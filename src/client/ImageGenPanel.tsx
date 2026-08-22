/**
 * The 生图插件 studio: a three-column layout — left, a card-grouped
 * configuration sidebar (mode tabs, prompt with counter, rounded parameter
 * selectors, model dropdown + generate button); center, the result canvas;
 * right, a persistent generation history column.
 *
 * Controls ride the system UI primitives (@deepseek-ai/dsh-client-ui-primitives,
 * a platform module) so the studio matches the dsh shell look by construction.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImageGenApi } from './api.ts'
import type { ImageGenController } from './controller.ts'
import { addImageFileToConversation } from './conversation-bridge.ts'
import { errorMessage, tt } from './helpers.ts'
import type { GeneratedImage, GenerateMode, GenerateRequest, HistoryEntry, HistoryImageRef, UpdateInfo } from '../protocol.ts'
import type { ImageGenConfig, ImageGenScope } from './settings-scope.ts'
import css from './panel.module.css'

/** All size options for gpt-image-2. */
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '512x512', '1792x1024', '1024x1792'] as const

/** Size option keys in the locale dictionary. */
const SIZE_KEYS: Record<string, 'size.auto' | 'size.square' | 'size.landscape' | 'size.portrait' | 'size.small' | 'size.wide' | 'size.tall'> = {
  auto: 'size.auto',
  '1024x1024': 'size.square',
  '1536x1024': 'size.landscape',
  '1024x1536': 'size.portrait',
  '512x512': 'size.small',
  '1792x1024': 'size.wide',
  '1024x1792': 'size.tall',
}

/** Quality options. */
const QUALITIES = ['auto', 'low', 'medium', 'high'] as const

/** Detail options ('' = omit the passthrough). */
const DETAILS = ['', 'standard', 'high'] as const

const PROMPT_MAX = 2000
const REF_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const PREVIEW_SCALE_MIN = 0.5
const PREVIEW_SCALE_MAX = 8
const PREVIEW_SCALE_STEP = 0.1

/** Custom drag payload MIME for dragging a history image onto the edit box. */
const HISTORY_DRAG_MIME = 'application/x-dsh-image-create-url'

/** Extract a history-image URL from a drag payload. Tries our custom MIME,
 *  then the standard text/uri-list (browser default for dragged links/images),
 *  then a plain-text URL we placed ourselves. */
function dragUrlFrom(dt: DataTransfer | null): string | null {
  if (dt === null) return null
  const marker = dt.getData(HISTORY_DRAG_MIME)
  if (marker !== '') return marker
  const uri = dt.getData('text/uri-list').split('\n')[0]?.trim() ?? ''
  if (uri !== '') return uri
  const plain = dt.getData('text/plain').trim()
  if (plain.startsWith('/api/dsh-image-create/history/image/')) return plain
  return null
}

function clampPreviewScale(scale: number): number {
  return Math.min(PREVIEW_SCALE_MAX, Math.max(PREVIEW_SCALE_MIN, scale))
}

/** Read the current config from the settings scope snapshot. */
function useConfig(scope: ImageGenScope): ImageGenConfig | undefined {
  const [value, setValue] = useState(scope.getSnapshot().value)
  useEffect(() => scope.subscribe(() => { setValue(scope.getSnapshot().value) }), [scope])
  return value
}

/** Track the redacted api-key presence bit exposed by the settings bridge. */
function useKeySet(scope: ImageGenScope): boolean {
  const [keySet, setKeySet] = useState(scope.getKeySetSnapshot())
  useEffect(() => scope.subscribeKeySet(() => { setKeySet(scope.getKeySetSnapshot()) }), [scope])
  return keySet
}

/** Tick a seconds counter while `running`. */
function useElapsed(running: boolean, startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running || startedAt === null) return
    const timer = window.setInterval(() => {
      setElapsed(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  return elapsed
}

/** Data URL for a generated image. */
function srcOf(image: GeneratedImage): string {
  return `data:${image.mime};base64,${image.b64}`
}

/** Fetch persisted history image refs and decode them back to in-memory
 *  GeneratedImage[] (base64), so the canvas/preview can reuse the same
 *  rendering path as a fresh generation. */
async function historyImagesToGenerated(refs: HistoryImageRef[]): Promise<GeneratedImage[]> {
  return Promise.all(refs.map(async ref => {
    const response = await fetch(ref.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(new Error('image read failed'))
      reader.readAsDataURL(blob)
    })
    const comma = dataUrl.indexOf(',')
    return {
      b64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
      mime: ref.mime,
      ...ref.revisedPrompt === undefined ? {} : { revisedPrompt: ref.revisedPrompt },
    }
  }))
}

/** Compact, locale-independent timestamp for history entries. */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 是否为「仅支持图生图」的编辑模型（与宿主引擎同一启发式：id 含 edit）。 */
function isEditOnlyModelId(id: string): boolean {
  return /edit/i.test(id)
}

/** Render the studio. */
export function ImageGenPanel(props: {
  api: ImageGenApi
  scope: ImageGenScope
  controller: ImageGenController
}) {
  const { api, scope, controller } = props
  const config = useConfig(scope)
  const enabled = config?.enabled ?? true
  const keySet = useKeySet(scope)

  // 模型下拉项：跨所有供应商的模型，标识为 providerId::modelId
  // （不同供应商可能使用同名模型）。
  const modelOptions = (config?.providers ?? []).flatMap(p =>
    (p.models ?? []).map(m => ({ providerId: p.id, providerName: p.name || p.id, modelId: m.id })),
  )
  const configured = modelOptions.length > 0
  const connected = enabled && configured && keySet

  const [mode, setMode] = useState<GenerateMode>('text')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<string>('auto')
  const [quality, setQuality] = useState<string>('auto')
  const [count, setCount] = useState(1)
  const [detail, setDetail] = useState('')
  // 自定义参数（非空时覆盖上方预设）。
  const [customSize, setCustomSize] = useState('')
  const [customSize2, setCustomSize2] = useState('')
  const [ppi, setPpi] = useState('')
  const [modelKey, setModelKey] = useState<string>('')
  // 标题处展示的当前模型（与模型下拉同一格式：供应商 / 模型）。
  const activeModel = modelKey === ''
    ? null
    : modelOptions.find(option => `${option.providerId}::${option.modelId}` === modelKey) ?? null
  const [refImage, setRefImage] = useState<{ dataUrl: string; name: string } | null>(null)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ images: GeneratedImage[]; index: number } | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [promptCopied, setPromptCopied] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [updateResult, setUpdateResult] = useState<'success' | 'failed' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const previewStage = useRef<HTMLDivElement>(null)
  const previewDrag = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null)
  const previewScaleRef = useRef(previewScale)
  /** 下一次 React 提交渲染后要应用的滚动位置（光标/中心锚定）。 */
  const pendingPreviewScroll = useRef<{ left: number; top: number } | null>(null)
  const [previewDragging, setPreviewDragging] = useState(false)
  /** scale ≤ 1 时图片在 stage 内的平移偏移（配合居中缩放，实现鼠标锚定）。 */
  const [previewTranslate, setPreviewTranslate] = useState({ x: 0, y: 0 })
  const elapsed = useElapsed(generating, startedAt)

  // Keep previewScale in sync with the DOM ref for zoom calculations. This runs
  // in the layout phase (before paint) so consecutive wheel events always read
  // the scale that matches the already-committed DOM.
  useLayoutEffect(() => {
    previewScaleRef.current = previewScale
  }, [previewScale])

  // 缩放后应用锚定的滚动位置：在 React 提交 DOM（frame 尺寸已更新）之后、
  // 浏览器绘制之前同步设置 scrollLeft/scrollTop。相比原来的 requestAnimationFrame，
  // 这消除了 rAF 与 React 渲染的时序竞争 —— 之前 frame 尺寸与滚动位置可能
  // 落在不同的帧，导致滚轮缩放时画面剧烈晃动。
  useLayoutEffect(() => {
    if (pendingPreviewScroll.current === null) return
    const stage = previewStage.current
    if (stage === null) {
      pendingPreviewScroll.current = null
      return
    }
    const { left, top } = pendingPreviewScroll.current
    pendingPreviewScroll.current = null
    stage.scrollLeft = left
    stage.scrollTop = top
  }, [previewScale])

  /** 统一缩放入口：以指定锚点（默认视口中心）缩放预览。
   *
   *  两种缩放状态使用不同的锚定机制：
   *  - scale ≤ 1：frame 与 stage 同大（无滚动），图片在 frame 内居中，
   *    用 translate 平移图片，使锚点下方的图片内容保持不动；
   *  - scale > 1：frame 放大、图片填满 frame（内容从原点开始），
   *    用 scrollLeft/scrollTop 锚定，滚动位置在 React 提交后同步（见上方
   *    useLayoutEffect），消除 rAF 与渲染竞争导致的晃动。
   *  跨过 1 的边界时两种机制在 scale=1 处自然连续（此时图片=frame=stage，
   *  translate=0 且 scroll=0）。 */
  const applyZoom = (next: number, anchorX?: number, anchorY?: number): void => {
    const stage = previewStage.current
    const current = previewScaleRef.current
    if (next === current) return
    if (stage === null) {
      setPreviewScale(next)
      return
    }
    const ratio = next / current
    const ax = anchorX ?? stage.clientWidth / 2
    const ay = anchorY ?? stage.clientHeight / 2
    const stageW = stage.clientWidth
    const stageH = stage.clientHeight

    if (current <= 1) {
      // 从缩小/原始状态缩放：图片在 frame 内居中，用 translate 锚定。
      const imgW = stageW * current
      const imgH = stageH * current
      const imgLeft = (stageW - imgW) / 2
      const imgTop = (stageH - imgH) / 2
      // 锚点在图片内容坐标中的比例（0~1）。
      const px = (ax - imgLeft) / imgW
      const py = (ay - imgTop) / imgH
      if (next <= 1) {
        // 仍在缩小区：平移图片使锚点内容保持不动。
        const imgW2 = stageW * next
        const imgH2 = stageH * next
        const newLeft = ax - px * imgW2
        const newTop = ay - py * imgH2
        setPreviewTranslate({ x: newLeft - (stageW - imgW2) / 2, y: newTop - (stageH - imgH2) / 2 })
        pendingPreviewScroll.current = null
      } else {
        // 跨过 1 放大：scale=1 处 translate=0、scroll=0，此后转滚动锚定。
        // 锚点内容坐标（相对内容原点 = frame 原点）。
        const contentX = imgLeft + px * imgW
        const contentY = imgTop + py * imgH
        pendingPreviewScroll.current = {
          left: contentX * ratio - ax,
          top: contentY * ratio - ay,
        }
        setPreviewTranslate({ x: 0, y: 0 })
      }
    } else if (next > 1) {
      // 放大区：滚动锚定（frame 从内容原点开始，图片填满 frame）。
      pendingPreviewScroll.current = {
        left: (ax + stage.scrollLeft) * ratio - ax,
        top: (ay + stage.scrollTop) * ratio - ay,
      }
    } else {
      // 从放大缩小到 ≤1：锚点内容坐标 = scroll + 视口位置。
      const contentX = stage.scrollLeft + ax
      const contentY = stage.scrollTop + ay
      // 目标图片在 frame（=stage）内居中，translate 使锚点内容显示在锚点处：
      // 视口位置 = translate + 内容坐标 * ratio（图片原点居中偏移已抵消）。
      setPreviewTranslate({ x: ax - contentX * ratio, y: ay - contentY * ratio })
      pendingPreviewScroll.current = null
    }
    setPreviewScale(next)
  }

  // 配置就绪后，把当前选中的模型同步到 active 或第一个可用模型。
  useEffect(() => {
    if (modelOptions.length === 0) {
      setModelKey('')
      return
    }
    const active = config?.active ?? ''
    if (active !== '') {
      const sep = active.indexOf(':')
      if (sep > 0) {
        const pid = active.slice(0, sep)
        const mid = active.slice(sep + 1)
        if (modelOptions.some(o => o.providerId === pid && o.modelId === mid)) {
          setModelKey(`${pid}::${mid}`)
          return
        }
      }
    }
    setModelKey(`${modelOptions[0].providerId}::${modelOptions[0].modelId}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  /** Select a model from the dropdown: persist the activation, then use it. */
  const selectModel = (providerId: string, modelId: string): void => {
    setModelKey(`${providerId}::${modelId}`)
    void scope.activate(providerId, modelId)
  }

  // Load the host-persisted history once on mount (it lives in ~/.dsh on the
  // DSH host, so every browser/device sees the same list).
  useEffect(() => {
    let disposed = false
    api.historyList()
      .then(entries => { if (!disposed) setHistory(entries) })
      .catch(() => { /* history unavailable — leave the list empty */ })
    return () => { disposed = true }
  }, [api])

  // The panel stays mounted across open/close cycles (its visibility is driven
  // by the html[data-dsh-image-create-active] attribute set in mount.tsx), so
  // the mount-time history load alone would miss generations made afterwards
  // by agent tools or other browsers. Refresh the list every time the panel
  // is (re)opened — watch the active attribute, with an activate-event
  // fallback when MutationObserver is unavailable. While the panel stays open,
  // poll at a low frequency so agent-tool generations show up in real time.
  useEffect(() => {
    const ACTIVE_ATTR = 'data-dsh-image-create-active'
    const refresh = (): void => {
      if (!document.documentElement.hasAttribute(ACTIVE_ATTR)) return
      api.historyList()
        .then(entries => setHistory(entries))
        .catch(() => { /* history unavailable — keep the current list */ })
    }
    const onActivate = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === 'image-create') refresh()
    }
    let observer: MutationObserver | undefined
    try {
      observer = new MutationObserver(refresh)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [ACTIVE_ATTR],
      })
    } catch {
      // MutationObserver unavailable — fall back to panel-activate events.
      document.addEventListener('dsh-panel-activate', onActivate)
    }
    refresh()
    const pollTimer = window.setInterval(refresh, 10_000)
    return () => {
      observer?.disconnect()
      document.removeEventListener('dsh-panel-activate', onActivate)
      window.clearInterval(pollTimer)
    }
  }, [api])

  // Drag & drop guard: dragging a history image carries our custom payload
  // MIME (plus the browser's default image types). Intercept dragover/drop at
  // the document capture phase so the image never falls into the main chat
  // composer or the browser's default "open image" behavior. Events targeting
  // the panel itself still propagate (the edit upload box handles them).
  useEffect(() => {
    const isPanelTarget = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest('[data-dsh-image-create-view]') !== null
    const hasMarker = (dt: DataTransfer | null): boolean =>
      dt !== null && Array.from(dt.types).includes(HISTORY_DRAG_MIME)
    const onDragOver = (event: DragEvent): void => {
      if (!hasMarker(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      if (!isPanelTarget(event.target)) event.stopPropagation()
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasMarker(event.dataTransfer)) return
      event.preventDefault()
      if (!isPanelTarget(event.target)) event.stopPropagation()
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [])

  // Release checks are host-mediated and intentionally best-effort: a GitHub
  // outage must never make the image-generation studio unavailable.
  useEffect(() => {
    let disposed = false
    api.updateCheck()
      .then(info => {
        if (!disposed && info.updateAvailable) setUpdate(info)
      })
      .catch(() => { /* update discovery is optional */ })
    return () => { disposed = true }
  }, [api])

  const applyUpdate = async (): Promise<void> => {
    if (update === null || updating) return
    setUpdating(true)
    setUpdateMessage(null)
    setUpdateResult(null)
    try {
      const result = await api.updateApply(update.latestVersion)
      setUpdateMessage(tt('update.success', { version: result.updatedVersion }))
      setUpdateResult('success')
    } catch {
      setUpdateMessage(tt('update.failed'))
      setUpdateResult('failed')
    } finally {
      setUpdating(false)
    }
  }

  /** Read an uploaded reference image into a data URL. */
  const acceptFile = (file: File | undefined): void => {
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      setError(tt('edit.uploadHint'))
      return
    }
    if (file.size > REF_IMAGE_MAX_BYTES) {
      setError(tt('edit.uploadHint'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setRefImage({ dataUrl: reader.result, name: file.name })
    }
    reader.onerror = () => { setError(tt('edit.uploadHint')) }
    reader.readAsDataURL(file)
  }

  /** Accept a history image dragged onto the edit box: fetch the served
   *  URL and convert it to a data URL (same shape as acceptFile). */
  const acceptHistoryImageUrl = async (url: string): Promise<void> => {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) throw new Error(tt('edit.uploadHint'))
      if (blob.size > REF_IMAGE_MAX_BYTES) throw new Error(tt('edit.uploadHint'))
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(new Error(tt('edit.uploadHint')))
        reader.readAsDataURL(blob)
      })
      const name = url.split('/').pop() ?? 'reference.png'
      setRefImage({ dataUrl, name })
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Run one generation. */
  const handleGenerate = async (): Promise<void> => {
    if (generating) return
    const promptText = prompt.trim()
    if (promptText === '') {
      setError(tt('prompt.required'))
      return
    }
    if (mode === 'edit' && refImage === null) {
      setError(tt('edit.required'))
      return
    }
    // 文生图 + 编辑模型（如 Qwen/Qwen-Image-Edit-2509）：下拉自动切到同供应商的
    // 生图模型（仅本次生效，不改变设置里持久化的激活模型）。
    let requestModelKey = modelKey
    if (mode === 'text') {
      const sep = modelKey.indexOf('::')
      if (sep > 0) {
        const pid = modelKey.slice(0, sep)
        const mid = modelKey.slice(sep + 2)
        if (isEditOnlyModelId(mid)) {
          const alternative = modelOptions.find(option => option.providerId === pid && !isEditOnlyModelId(option.modelId))
          if (alternative !== undefined) {
            requestModelKey = `${alternative.providerId}::${alternative.modelId}`
            setModelKey(requestModelKey)
          }
        }
      }
    }
    // 自定义参数覆盖预设（尺寸/数量/PPI；PPI 留空则不带该字段）。
    // 自定义尺寸：只填一个时，另一个默认 1024 并自动填入，提醒使用者。
    let customW = customSize.trim()
    let customH = customSize2.trim()
    if (customW !== '' && customH === '') {
      customH = '1024'
      setCustomSize2(customH)
    } else if (customW === '' && customH !== '') {
      customW = '1024'
      setCustomSize(customW)
    }
    const effectiveSize = customW !== '' ? `${customW}x${customH}` : size
    const request: GenerateRequest = {
      mode,
      model: requestModelKey.split('::')[1] ?? 'gpt-image-2',
      prompt: promptText,
      size: effectiveSize,
      quality,
      n: count,
      detail,
      ...ppi.trim() !== '' ? { ppi: ppi.trim() } : {},
      ...mode === 'edit' && refImage !== null ? { image: refImage.dataUrl } : {},
      ...mode === 'edit' && refImage !== null ? { refName: refImage.name } : {},
    }
    setGenerating(true)
    setError(null)
    setImages([])
    setStartedAt(Date.now())
    try {
      const result = await api.generate(request)
      setImages(result.images)
      setViewingHistoryId(null)
      if (result.history !== undefined) setHistory(result.history)
      if (result.historyError !== undefined) setError(result.historyError)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setGenerating(false)
      setStartedAt(null)
    }
  }

  /** Open the full-screen image preview at a given index. */
  const openPreview = (previewImages: GeneratedImage[], index: number): void => {
    pendingPreviewScroll.current = null
    setPreviewTranslate({ x: 0, y: 0 })
    setPreview({ images: previewImages, index })
    setPreviewScale(1)
    setPromptCopied(false)
  }

  const closePreview = (): void => {
    pendingPreviewScroll.current = null
    setPreviewTranslate({ x: 0, y: 0 })
    setPreview(null)
    setPreviewScale(1)
    setPromptCopied(false)
  }

  /** Step the preview by ±1, wrapping around. */
  const stepPreview = (delta: number): void => {
    pendingPreviewScroll.current = null
    setPreviewTranslate({ x: 0, y: 0 })
    setPreviewScale(1)
    setPromptCopied(false)
    setPreview(current => {
      if (current === null) return null
      const total = current.images.length
      return { images: current.images, index: (current.index + delta + total) % total }
    })
  }

  // Keyboard navigation for the preview overlay.
  useEffect(() => {
    if (preview === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
      else if (event.key === 'ArrowLeft') stepPreview(-1)
      else if (event.key === 'ArrowRight') stepPreview(1)
      else if (event.key === '+' || event.key === '=') applyZoom(clampPreviewScale(previewScaleRef.current + PREVIEW_SCALE_STEP))
      else if (event.key === '-') applyZoom(clampPreviewScale(previewScaleRef.current - PREVIEW_SCALE_STEP))
      else if (event.key === '0') {
        pendingPreviewScroll.current = null
        setPreviewTranslate({ x: 0, y: 0 })
        setPreviewScale(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  // A scaled image owns real scrollable space, rather than being visually
  // transformed and clipped. Recenter the viewport when a new image opens or
  // the preview slides; zooming keeps the cursor-anchored position instead
  // (see onWheel), so previewScale is intentionally NOT a dependency here.
  useEffect(() => {
    if (preview === null) return
    const frame = window.requestAnimationFrame(() => {
      const stage = previewStage.current
      if (stage === null) return
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2)
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [preview])

  // Pan-by-drag: once the zoomed image overflows the preview stage, holding
  // the left mouse button turns the cursor into a grab hand and dragging the
  // stage moves the viewport (scrollLeft/scrollTop) to inspect image details.
  useEffect(() => {
    if (preview === null) return
    const onMove = (event: MouseEvent): void => {
      const drag = previewDrag.current
      const stage = previewStage.current
      if (drag === null || stage === null) return
      stage.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX)
      stage.scrollTop = drag.scrollTop - (event.clientY - drag.startY)
    }
    const onUp = (): void => {
      if (previewDrag.current === null) return
      previewDrag.current = null
      setPreviewDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      previewDrag.current = null
      setPreviewDragging(false)
    }
  }, [preview])

  /** Load a past generation's images into the canvas. */
  const viewHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      setImages(await historyImagesToGenerated(entry.images))
      setError(null)
      setViewingHistoryId(entry.id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Restore a past generation's parameters (and its images) into the form. */
  const restoreHistoryEntry = async (entry: HistoryEntry): Promise<void> => {
    try {
      const restored = await historyImagesToGenerated(entry.images)
      setMode(entry.mode)
      setPrompt(entry.prompt)
      setSize((SIZES as readonly string[]).includes(entry.size) ? entry.size : 'auto')
      setQuality((QUALITIES as readonly string[]).includes(entry.quality) ? entry.quality : 'auto')
      setDetail((DETAILS as readonly string[]).includes(entry.detail) ? entry.detail : '')
      setCount(entry.n >= 1 && entry.n <= 4 ? entry.n : 1)
      const match = modelOptions.find(o => o.modelId === entry.model)
      if (match !== undefined) setModelKey(`${match.providerId}::${match.modelId}`)
      else if (modelOptions.length > 0) setModelKey(`${modelOptions[0].providerId}::${modelOptions[0].modelId}`)
      setRefImage(null)
      setImages(restored)
      setError(null)
      setViewingHistoryId(entry.id)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove one history entry. */
  const deleteHistoryEntry = async (id: string): Promise<void> => {
    setHistory(history.filter(entry => entry.id !== id))
    if (viewingHistoryId === id) setViewingHistoryId(null)
    try {
      setHistory(await api.historyRemove(id))
    } catch {
      // Keep the optimistic local removal.
    }
  }

  /** Remove all history entries. */
  const clearHistory = async (): Promise<void> => {
    setHistory([])
    setViewingHistoryId(null)
    try {
      setHistory(await api.historyClear())
    } catch {
      // Keep the cleared local state.
    }
  }

  /** Ask the host to open the image storage directory in the file manager. */
  const openHistoryDir = async (): Promise<void> => {
    try {
      await api.openHistoryDir()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  /** Remove one image from the canvas (local view only; history untouched). */
  const closeImage = (index: number): void => {
    const next = images.filter((_, i) => i !== index)
    setImages(next)
    if (next.length === 0) setViewingHistoryId(null)
  }

  /** Copy a canvas image into the edit box as a reference image. */
  const addImageToEdit = (index: number): void => {
    const image = images[index]
    if (image === undefined) return
    setMode('edit')
    setRefImage({
      dataUrl: srcOf(image),
      name: `dsh-image-${index + 1}.${extensionOf(image.mime)}`,
    })
    if (prompt.trim() === '' && image.revisedPrompt !== undefined) setPrompt(image.revisedPrompt)
    setError(null)
  }

  /** Drop a canvas image into the main conversation composer. The DSH input
   *  bar listens for drop events with a Files payload on document; dispatching
   *  a full drag sequence (enter → over → drop → end) with a Files-carrying
   *  DataTransfer inserts the image as a draft attachment (no internal API).
   *  The File is built straight from the stored base64 so the payload is
   *  byte-identical to what a real drag of the same image would carry. */
  const addImageToConversation = (index: number): void => {
    const image = images[index]
    if (image === undefined) return
    try {
      const binary = atob(image.b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: image.mime })
      const file = new File([blob], `dsh-image-${index + 1}.${extensionOf(image.mime)}`, { type: image.mime })
      // 走 conversation 服务桥（绕开 drop 事件，避免 dsh-drop-caret 拦截落盘）。
      void addImageFileToConversation(file).then((err) => {
        if (err !== null) setError(err)
      })
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const generateDisabled = generating || !enabled || !configured
  const viewingEntry = viewingHistoryId === null ? null : history.find(entry => entry.id === viewingHistoryId) ?? null
  const previewImage = preview === null ? null : preview.images[preview.index] ?? null
  const previewFrameScale = Math.max(1, previewScale)
  const previewImageScale = previewScale / previewFrameScale

  const copyPreviewPrompt = async (text: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('copy failed')
      }
      setPromptCopied(true)
      window.setTimeout(() => { setPromptCopied(false) }, 1800)
    } catch {
      setPromptCopied(false)
    }
  }

  const addPreviewToEdit = (): void => {
    if (previewImage === null || preview === null) return
    setMode('edit')
    setRefImage({
      dataUrl: srcOf(previewImage),
      name: `dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`,
    })
    if (prompt.trim() === '' && previewImage.revisedPrompt !== undefined) setPrompt(previewImage.revisedPrompt)
    setError(null)
    closePreview()
  }

  return (
    // 拖拽图片时：只有图生图上传框显示“可放置”；面板其余区域显示禁止态，
    // 且所有事件都不冒泡到 document（避免 dsh 对话框输入区拦截图片）。
    // 从历史记录拖来的图片可在面板任意位置释放：自动切到图生图并填入参考图。
    <div
      className={css.panel}
      onDragEnter={(event) => { event.stopPropagation() }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = dragUrlFrom(event.dataTransfer) !== null ? 'copy' : 'none'
        event.stopPropagation()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const url = dragUrlFrom(event.dataTransfer)
        if (url !== null) {
          setMode('edit')
          void acceptHistoryImageUrl(url)
        }
      }}
    >
      <header className={css.panelHeader}>
        <span className={css.panelHeading}>
          <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
          <span className={css.panelSubtitle}>{tt('panel.subtitle')}</span>
          {activeModel !== null ? (
            <span className={css.panelModel}>
              {tt('model.label')}: {activeModel.providerName} / {activeModel.modelId}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className={css.connectionStatus}
          data-connected={connected ? 'true' : 'false'}
          aria-label={tt(connected ? 'connection.connected' : 'connection.disconnected')}
        >
          <span className={css.connectionDot} aria-hidden="true" />
          {tt(connected ? 'connection.connected' : 'connection.disconnected')}
        </button>
        <button
          type="button"
          className={css.panelClose}
          aria-label={tt('panel.close')}
          title={tt('panel.close')}
          onClick={() => { controller.close() }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

      {update !== null ? (
        <div className={css.updateBanner} data-kind={updateResult === 'success' ? 'ok' : 'warn'}>
          <span className={css.updateText}>
            {updateMessage ?? tt('update.available', { version: update.latestVersion })}
          </span>
          <span className={css.updateActions}>
            <a className={css.updateRelease} href={update.releaseUrl} target="_blank" rel="noreferrer">{tt('update.release')}</a>
            <Button variant="primary" size="sm" disabled={updating || updateMessage !== null} onClick={() => { void applyUpdate() }}>
              {updating ? tt('update.installing') : tt('update.install')}
            </Button>
          </span>
        </div>
      ) : null}

      <div className={css.studio}>
        {/* ---------------------------------------------------- config sidebar */}
        <aside className={css.config}>
          <div className={css.configScroll}>
            {/* mode tabs */}
            <section className={css.card}>
              <div className={css.modeRow} role="tablist" aria-label={tt('panel.title')}>
                <Pill
                  active={mode === 'text'}
                  onClick={() => { setMode('text') }}
                  className={css.modePill}
                >
                  {tt('mode.text')}
                </Pill>
                <Pill
                  active={mode === 'edit'}
                  onClick={() => { setMode('edit') }}
                  className={css.modePill}
                >
                  {tt('mode.edit')}
                </Pill>
              </div>
            </section>

            {/* reference image (edit mode) */}
            {mode === 'edit' ? (
              <section className={css.card}>
                {refImage === null
                  ? (
                    <button
                      type="button"
                      className={css.uploadBox}
                      onClick={() => { fileInput.current?.click() }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'copy'
                        event.stopPropagation()
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const url = dragUrlFrom(event.dataTransfer)
                        if (url !== null) {
                          void acceptHistoryImageUrl(url)
                          return
                        }
                        acceptFile(event.dataTransfer.files?.[0])
                      }}
                    >
                      <span className={css.uploadIcon}>
                        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10.5V3"/><path d="M5 5.5l3-3 3 3"/><path d="M2.5 9v3.5h11V9"/></svg>
                      </span>
                      <span>{tt('edit.upload')}</span>
                      <span className={css.uploadHint}>{tt('edit.uploadHint')}</span>
                    </button>
                  )
                  : (
                    // 已有参考图时也支持拖拽替换（事件不冒泡到 document，避免进对话框）。
                    <div
                      className={css.reference}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'copy'
                        event.stopPropagation()
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const url = dragUrlFrom(event.dataTransfer)
                        if (url !== null) {
                          void acceptHistoryImageUrl(url)
                          return
                        }
                        acceptFile(event.dataTransfer.files?.[0])
                      }}
                    >
                      <img className={css.referenceImage} src={refImage.dataUrl} alt={refImage.name} />
                      <div className={css.referenceActions}>
                        <Button variant="outline" size="sm" onClick={() => { fileInput.current?.click() }}>
                          {tt('edit.change')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => { setRefImage(null) }}>
                          {tt('edit.remove')}
                        </Button>
                      </div>
                    </div>
                  )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className={css.hiddenFile}
                  onChange={(event) => {
                    acceptFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                />
              </section>
            ) : null}

            {/* prompt */}
            <section className={css.card}>
              <textarea
                className={css.prompt}
                value={prompt}
                maxLength={PROMPT_MAX}
                placeholder={tt('prompt.placeholder')}
                onChange={(event) => { setPrompt(event.target.value) }}
              />
              <div className={css.promptFooter}>
                <span className={css.promptCount}>{tt('prompt.count', { count: prompt.length })}</span>
              </div>
            </section>

            {/* parameters */}
            <section className={css.card}>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.size')}</span>
                <div className={css.optionGrid}>
                  {SIZES.map(option => (
                    <Pill
                      key={option}
                      active={customSize.trim() === '' && customSize2.trim() === '' && size === option}
                      onClick={() => { setSize(option); setCustomSize(''); setCustomSize2('') }}
                      className={css.optionPill}
                    >
                      {tt(SIZE_KEYS[option] ?? 'size.auto')}
                    </Pill>
                  ))}
                </div>
                <div className={css.sizeCustomRow}>
                  <input
                    className={css.paramInput}
                    value={customSize}
                    placeholder={customSize2.trim() !== '' && customSize.trim() === '' ? '1024' : '宽'}
                    title={tt('params.sizeCustom')}
                    onChange={(event) => { setCustomSize(event.target.value) }}
                  />
                  <span className={css.sizeCustomX}>×</span>
                  <input
                    className={css.paramInput}
                    value={customSize2}
                    placeholder={customSize.trim() !== '' && customSize2.trim() === '' ? '1024' : '高'}
                    title={tt('params.sizeCustom')}
                    onChange={(event) => { setCustomSize2(event.target.value) }}
                  />
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.quality')}</span>
                <div className={css.optionRow}>
                  {QUALITIES.map(option => (
                    <Pill
                      key={option}
                      active={ppi.trim() === '' && quality === option}
                      onClick={() => { setQuality(option) }}
                      className={css.optionPill}
                    >
                      {tt(`quality.${option}` as const)}
                    </Pill>
                  ))}
                </div>
                <input
                  className={css.paramInput}
                  value={ppi}
                  placeholder={tt('params.ppiPlaceholder')}
                  title={tt('params.ppi')}
                  onChange={(event) => { setPpi(event.target.value) }}
                />
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.count')}</span>
                <div className={css.optionRow}>
                  {[1, 2, 3, 4].map(option => (
                    <Pill
                      key={option}
                      active={count === option}
                      onClick={() => { setCount(option) }}
                      className={css.optionPill}
                    >
                      {tt(`count.${option === 1 ? 'one' : option === 2 ? 'two' : option === 3 ? 'three' : 'four'}` as const)}
                    </Pill>
                  ))}
                </div>
              </div>
              <div className={css.paramGroup}>
                <span className={css.paramLabel}>{tt('params.detail')}</span>
                <div className={css.optionRow}>
                  {DETAILS.map(option => (
                    <Pill
                      key={option === '' ? 'auto' : option}
                      active={detail === option}
                      onClick={() => { setDetail(option) }}
                      className={css.optionPill}
                    >
                      {tt(option === '' ? 'detail.auto' : option === 'standard' ? 'detail.standard' : 'detail.high')}
                    </Pill>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* footer: model + generate — a fixed sibling of the scroll area, so
              it never overlaps the cards scrolling above it. */}
          <section className={css.footer}>
            <label className={css.modelWrap}>
              <span className={css.modelLabel}>{tt('model.label')}</span>
              <select
                className={css.modelSelect}
                value={modelKey}
                disabled={generating}
                onChange={(event) => {
                  const value = event.target.value
                  const sep = value.indexOf('::')
                  if (sep > 0) selectModel(value.slice(0, sep), value.slice(sep + 2))
                }}
              >
                {modelOptions.length === 0 ? (
                  <option value="">{tt('model.none')}</option>
                ) : (
                  modelOptions.map(option => (
                    <option key={`${option.providerId}::${option.modelId}`} value={`${option.providerId}::${option.modelId}`}>
                      {option.providerName} / {option.modelId}
                    </option>
                  ))
                )}
              </select>
            </label>
            <Button
              variant="primary"
              size="md"
              className={css.generateButton}
              disabled={generateDisabled}
              onClick={() => { void handleGenerate() }}
            >
              {generating ? (
                <span className={css.generateInner}>
                  <span className={css.spinner} />
                  {tt('generating')}
                </span>
              ) : tt('generate')}
            </Button>
          </section>
        </aside>

        {/* --------------------------------------------------------- canvas */}
        <section className={css.canvas}>
          {generating ? (
            <div className={css.canvasState} role="status">
              <span className={css.bigSpinner} />
              <span className={css.canvasStateTitle}>{tt('canvas.generating')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.elapsed', { seconds: elapsed })}</span>
            </div>
          ) : null}

          {!generating && error !== null ? (
            <div className={css.canvasError} role="alert">{tt('canvas.error', { error })}</div>
          ) : null}

          {!generating && !error && images.length === 0 ? (
            <div className={css.canvasState}>
              <span className={css.canvasEmptyIcon}>
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              </span>
              <span className={css.canvasStateTitle}>{tt('canvas.emptyTitle')}</span>
              <span className={css.canvasStateHint}>{tt('canvas.emptyHint')}</span>
            </div>
          ) : null}

          {!generating && images.length > 0 ? (
            <div className={css.canvasBody}>
              <div className={css.canvasMeta}>
                <span>{tt('canvas.images', { count: images.length })}</span>
                {viewingEntry !== null ? (
                  <span className={css.canvasHistoryTag}>{tt('history.viewing', { time: formatTime(viewingEntry.createdAt) })}</span>
                ) : null}
              </div>
              <div className={css.grid} data-count={images.length}>
                {images.map((image, index) => (
                  <figure
                    key={index}
                    className={css.imageCard}
                    role="button"
                    tabIndex={0}
                    title={tt('preview.open')}
                    onClick={() => { openPreview(images, index) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openPreview(images, index)
                      }
                    }}
                  >
                    <img
                      className={css.image}
                      src={srcOf(image)}
                      alt={image.revisedPrompt ?? `${tt('panel.title')} ${index + 1}`}
                    />
                    {image.revisedPrompt !== undefined ? (
                      <figcaption className={css.imageCaption} title={image.revisedPrompt}>
                        {tt('revisedPrompt', { prompt: image.revisedPrompt })}
                      </figcaption>
                    ) : null}
                    <span className={css.imageCardHints}>
                      <span className={css.zoomHint}>
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="M13 13l-3.2-3.2"/><path d="M7 5.4v3.2M5.4 7h3.2"/></svg>
                        {tt('preview.open')}
                      </span>
                      <span className={css.zoomAddToEdit} onClick={(event) => { event.stopPropagation(); addImageToEdit(index) }}>
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
                        {tt('preview.addToEdit')}
                      </span>
                      <span className={css.zoomAddToChat} onClick={(event) => { event.stopPropagation(); void addImageToConversation(index) }}>
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11v7h-11z"/><path d="M2.5 11l3 3h3l-3-3"/></svg>
                        {tt('image.addToChat')}
                      </span>
                    </span>
                    <span className={css.imageCardActions}>
                      <button
                        type="button"
                        className={css.imageClose}
                        aria-label={tt('preview.close')}
                        title={tt('preview.close')}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeImage(index)
                        }}
                      >
                        {tt('preview.close')}
                      </button>
                      <a
                        className={css.download}
                        href={srcOf(image)}
                        download={`dsh-image-${index + 1}.${extensionOf(image.mime)}`}
                        onClick={(event) => { event.stopPropagation() }}
                      >
                        {tt('download')}
                      </a>
                    </span>
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* -------------------------------------------------------- history */}
        <aside className={css.history}>
          <header className={css.historyHeader}>
            <span className={css.historyTitle}>{tt('history.title')}</span>
            <span className={css.historyHeaderActions}>
              <button type="button" className={css.historyOpenDir} onClick={() => { void openHistoryDir() }}>
                {tt('history.openDir')}
              </button>
              {history.length > 0 ? (
                <button type="button" className={css.historyClear} onClick={() => { void clearHistory() }}>
                  {tt('history.clear')}
                </button>
              ) : null}
            </span>
          </header>
          {config?.saveDir !== undefined && config.saveDir !== '' ? (
            <div className={css.historySaveDir} title={config.saveDir}>
              {tt('history.saveDir', { dir: config.saveDir })}
            </div>
          ) : null}

          {history.length === 0 ? (
            <div className={css.historyEmpty}>{tt('history.empty')}</div>
          ) : (
            <div className={css.historyList}>
              {history.map(entry => (
                <div
                  key={entry.id}
                  className={css.historyItem}
                  data-active={entry.id === viewingHistoryId ? '' : undefined}
                >
                  <button
                    type="button"
                    className={css.historyMain}
                    draggable
                    onDragStart={(event) => {
                      if (entry.images.length === 0) return
                      const url = entry.images[0]!.url
                      event.dataTransfer.clearData()
                      event.dataTransfer.setData(HISTORY_DRAG_MIME, url)
                      event.dataTransfer.setData('text/uri-list', url)
                      event.dataTransfer.setData('text/plain', url)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => { void viewHistoryEntry(entry) }}
                  >
                    {entry.images.length > 0 ? (
                      <img className={css.historyThumb} src={entry.images[0]!.url} alt="" draggable={false} />
                    ) : (
                      <span className={css.historyThumbPlaceholder} />
                    )}
                    <span className={css.historyInfo}>
                      <span className={css.historyPrompt}>{entry.prompt}</span>
                      <span className={css.historyMeta}>
                        {tt(`mode.${entry.mode === 'edit' ? 'edit' : 'text'}` as const)}
                        {' · '}{formatTime(entry.createdAt)}
                        {' · '}{entry.images.length} {tt('history.images')}
                      </span>
                    </span>
                  </button>
                  <span className={css.historyActions}>
                    <button type="button" className={css.historyAction} onClick={() => { void restoreHistoryEntry(entry) }}>
                      {tt('history.restore')}
                    </button>
                    <button type="button" className={css.historyAction} data-danger onClick={() => { void deleteHistoryEntry(entry.id) }}>
                      {tt('history.delete')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* -------------------------------------------------- preview overlay */}
      {preview !== null && previewImage !== null
        ? createPortal(
          <div
            className={css.lightbox}
            role="dialog"
            aria-modal="true"
            aria-label={tt('preview.title')}
            onClick={closePreview}
          >
            <button type="button" className={css.lightboxClose} aria-label={tt('preview.close')} title={tt('preview.close')} onClick={closePreview}>
              <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
            {preview.images.length > 1 ? (
              <>
                <button type="button" className={css.lightboxNav} data-dir="prev" aria-label={tt('preview.prev')} onClick={(event) => { event.stopPropagation(); stepPreview(-1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3l-5 5 5 5"/></svg>
                </button>
                <button type="button" className={css.lightboxNav} data-dir="next" aria-label={tt('preview.next')} onClick={(event) => { event.stopPropagation(); stepPreview(1) }}>
                  <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
                </button>
              </>
            ) : null}
            <figure className={css.lightboxFigure} onClick={(event) => { event.stopPropagation() }}>
              <div
                ref={previewStage}
                className={css.lightboxStage}
                data-zoomable={previewFrameScale > 1 ? '' : undefined}
                data-dragging={previewDragging ? '' : undefined}
                onWheel={(event) => {
                  event.preventDefault()
                  const stage = previewStage.current
                  if (stage === null) return
                  // 光标锚定缩放：记录鼠标在视口中的位置与缩放前滚动偏移，
                  // 缩放后调整 scroll，使鼠标下方的图片内容保持在鼠标下方。
                  const rect = stage.getBoundingClientRect()
                  const mx = event.clientX - rect.left
                  const my = event.clientY - rect.top
                  const current = previewScaleRef.current
                  const next = clampPreviewScale(current + (event.deltaY < 0 ? PREVIEW_SCALE_STEP : -PREVIEW_SCALE_STEP))
                  applyZoom(next, mx, my)
                }}
                onMouseDown={(event) => {
                  if (event.button !== 0 || previewFrameScale <= 1) return
                  const stage = previewStage.current
                  if (stage === null) return
                  event.preventDefault()
                  previewDrag.current = {
                    startX: event.clientX,
                    startY: event.clientY,
                    scrollLeft: stage.scrollLeft,
                    scrollTop: stage.scrollTop,
                  }
                  setPreviewDragging(true)
                }}
              >
                <div
                  className={css.lightboxScaleFrame}
                  style={{ width: `${previewFrameScale * 100}%`, height: `${previewFrameScale * 100}%` }}
                >
                  <img
                    className={css.lightboxImage}
                    style={{
                      width: `${previewImageScale * 100}%`,
                      height: `${previewImageScale * 100}%`,
                      transform: `translate(${previewTranslate.x}px, ${previewTranslate.y}px)`,
                    }}
                    src={srcOf(previewImage)}
                    alt={previewImage.revisedPrompt ?? tt('preview.title')}
                    draggable={false}
                  />
                </div>
              </div>
              <div className={css.lightboxTools} role="group" aria-label={tt('preview.zoomControls')}>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomOut')} title={tt('preview.zoomOut')} onClick={() => { applyZoom(clampPreviewScale(previewScaleRef.current - PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
                <button type="button" className={css.lightboxZoomLevel} aria-label={tt('preview.zoomReset')} title={tt('preview.zoomReset')} onClick={() => { pendingPreviewScroll.current = null; setPreviewTranslate({ x: 0, y: 0 }); setPreviewScale(1) }}>
                  {tt('preview.zoomLevel', { percent: Math.round(previewScale * 100) })}
                </button>
                <button type="button" className={css.lightboxTool} aria-label={tt('preview.zoomIn')} title={tt('preview.zoomIn')} onClick={() => { applyZoom(clampPreviewScale(previewScaleRef.current + PREVIEW_SCALE_STEP)) }}>
                  <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M7 4.8v4.4M4.8 7h4.4M13 13l-2.8-2.8"/></svg>
                </button>
              </div>
              {previewImage.revisedPrompt !== undefined ? (
                <div className={css.lightboxCaptionRow}>
                  <figcaption className={css.lightboxCaption} title={previewImage.revisedPrompt}>
                    {tt('revisedPrompt', { prompt: previewImage.revisedPrompt })}
                  </figcaption>
                  <button type="button" className={css.lightboxCopy} aria-label={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} title={tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')} onClick={() => { void copyPreviewPrompt(previewImage.revisedPrompt!) }}>
                    {promptCopied ? (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="7" height="8" rx="1"/><path d="M3 10V3.8c0-.44.36-.8.8-.8H9"/></svg>
                    )}
                    <span>{tt(promptCopied ? 'preview.copied' : 'preview.copyPrompt')}</span>
                  </button>
                </div>
              ) : null}
              <div className={css.lightboxMeta}>
                <span className={css.lightboxIndex}>{tt('preview.index', { index: preview.index + 1, total: preview.images.length })}</span>
                <span className={css.lightboxActions}>
                  <button type="button" className={css.lightboxEdit} onClick={addPreviewToEdit}>
                    {tt('preview.addToEdit')}
                  </button>
                  <a
                    className={css.lightboxDownload}
                    href={srcOf(previewImage)}
                    download={`dsh-image-${preview.index + 1}.${extensionOf(previewImage.mime)}`}
                  >
                    {tt('download')}
                  </a>
                </span>
              </div>
            </figure>
          </div>,
          document.body,
        )
        : null}
    </div>
  )
}

/** File extension for a MIME type (download filenames). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}
