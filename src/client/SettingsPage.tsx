/**
 * dsh-image-create 设置页 —— 照抄自视觉插件（dsh-image-vision）的
 * SettingsSection + ProviderCard，仅适配生图插件的配置形态与路由：
 * - 标题/总开关/当前使用条/供应商卡片/模型列表/就地编辑，渲染与视觉插件一致；
 * - 供应商卡片默认展开模型列表；展开/收起只由小箭头按钮触发（整行不可点）；
 * - 「编辑」「删除」短按钮；添加/编辑供应商为灰色就地编辑卡。
 */

import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tt } from './helpers.ts'
import { ProviderEditor, type Provider, type ProviderModel } from './ProviderEditor.tsx'
import { PLUGIN_VERSION, UPDATE_API, type UpdateInfo } from '../protocol.ts'

interface ImageGenConfig {
  enabled?: boolean
  announceToAgent?: boolean
  providers?: Provider[]
  active?: string
}

/** 解析 "providerId:modelId" → { provider, model }。 */
function resolveActive(providers: Provider[], active: string): { provider: Provider; model: ProviderModel } | null {
  const sep = active.indexOf(':')
  if (sep <= 0) return null
  const provider = providers.find(p => p.id === active.slice(0, sep))
  if (provider === undefined) return null
  const model = provider.models.find(m => m.id === active.slice(sep + 1))
  if (model === undefined) return null
  return { provider, model }
}

/** 状态点：绿色=当前使用中，灰色=未使用（与视觉插件一致）。 */
function Dot({ active }: { active: boolean }) {
  const cls = `zGbnIq_credentialDot ${active ? 'zGbnIq_credentialDotConfigured' : 'iv_dotIdle'}`
  return <span className={cls} title={active ? tt('settings.inUse') : '未使用'} />
}

// ===== 供应商卡片（行）=====

interface ProviderCardProps {
  provider: Provider
  active: string
  onUse: (providerId: string, modelId: string) => void
  onRemoveModel: (providerId: string, modelId: string) => void
  onAddModels: (providerId: string, models: ProviderModel[]) => void
  onEdit: () => void
  onDelete: () => void
  onReorderModels: (providerId: string, newModels: ProviderModel[]) => void
  onDragStart: (e: React.PointerEvent) => void
  dragging: boolean
  dragDisabled: boolean
}

function ProviderCard({ provider: p, active, onUse, onRemoveModel, onAddModels, onEdit, onDelete, onReorderModels, onDragStart, dragging, dragDisabled }: ProviderCardProps) {
  // 模型行拖拽排序：按住手柄上下移动，其他模型行实时让位，松手保存
  const [modelDrag, setModelDrag] = useState<{ index: number } | null>(null)
  const [previewModels, setPreviewModels] = useState<ProviderModel[] | null>(null)

  const beginModelDrag = (idx: number, e: React.PointerEvent): void => {
    e.preventDefault()
    if (dragDisabled) return
    const cur0 = idx
    let cur = idx
    let order = (previewModels ?? p.models).slice()
    let grabOffset = 0
    let dragEl: HTMLElement | null = null
    let lastY = e.clientY
    const flipBefore = new Map<string, number>()
    let flipScheduled = false
    let followScheduled = false
    let ended = false
    const layoutTop = (el: HTMLElement): number => {
      const r = el.getBoundingClientRect()
      const t = el.style.transform
      if (typeof t === 'string' && t !== '' && t !== 'none') {
        const m = t.match(/translateY\((-?[\d.]+)px\)/)
        if (m !== null) return r.top - parseFloat(m[1])
      }
      return r.top
    }
    const snap = (): void => {
      const root = document.querySelector(`[data-iv-provider-id="${p.id}"]`)
      if (root === null) return
      const nodes = Array.from(root.querySelectorAll('[data-iv-model-id]')) as HTMLElement[]
      flipBefore.clear()
      nodes.forEach(el => flipBefore.set(el.getAttribute('data-iv-model-id') ?? '', layoutTop(el)))
    }
    const flip = (): void => {
      if (flipScheduled || ended) return
      flipScheduled = true
      requestAnimationFrame(() => {
        flipScheduled = false
        if (ended) return
        const root = document.querySelector(`[data-iv-provider-id="${p.id}"]`)
        if (root === null) return
        const els = Array.from(root.querySelectorAll('[data-iv-model-id]')) as HTMLElement[]
        els.forEach(el => {
          if (el === dragEl) return
          const from = flipBefore.get(el.getAttribute('data-iv-model-id') ?? '')
          if (from === undefined) return
          const to = layoutTop(el)
          const delta = from - to
          if (Math.abs(delta) < 0.5) return
          el.style.transition = 'none'
          el.style.transform = `translateY(${delta}px)`
          void el.getBoundingClientRect()
          el.style.transition = 'transform 180ms ease'
          el.style.transform = ''
        })
      })
    }
    const follow = (ev: PointerEvent): void => {
      lastY = ev.clientY
      if (dragEl === null || followScheduled) return
      followScheduled = true
      requestAnimationFrame(() => {
        followScheduled = false
        if (dragEl === null || ended) return
        let ty = lastY - grabOffset - layoutTop(dragEl)
        const listEl = dragEl.parentElement
        if (listEl !== null) {
          const lr = listEl.getBoundingClientRect()
          const visual = layoutTop(dragEl) + ty
          const minV = lr.top + 2
          const maxV = lr.bottom - dragEl.offsetHeight - 2
          if (visual < minV) ty = minV - layoutTop(dragEl)
          if (visual > maxV) ty = maxV - layoutTop(dragEl)
        }
        if (Math.abs(ty) < 0.5) ty = 0
        dragEl.style.transition = 'none'
        dragEl.style.transform = `translateY(${ty}px)`
      })
    }
    setModelDrag({ index: idx })
    setPreviewModels(order)
    const rootEl = document.querySelector(`[data-iv-provider-id="${p.id}"]`)
    if (rootEl !== null) {
      const initEl = rootEl.querySelector(`[data-iv-model-index="${idx}"]`) as HTMLElement | null
      if (initEl !== null) {
        dragEl = initEl
        grabOffset = e.clientY - layoutTop(initEl)
        initEl.style.position = 'relative'
        initEl.style.zIndex = '5'
        follow(e.nativeEvent)
      }
    }
    const onMove = (ev: PointerEvent): void => {
      const root = document.querySelector(`[data-iv-provider-id="${p.id}"]`)
      if (root === null) return
      const nodes = Array.from(root.querySelectorAll('[data-iv-model-id]')) as HTMLElement[]
      let target = -1
      for (let i = 0; i < nodes.length; i++) {
        const top = layoutTop(nodes[i])
        if (ev.clientY >= top && ev.clientY <= top + nodes[i].offsetHeight) { target = i; break }
      }
      if (target < 0 || target === cur) {
        follow(ev)
        return
      }
      snap()
      const next = order.slice()
      const t = next.splice(cur, 1)[0]
      next.splice(target, 0, t)
      order = next
      cur = target
      setPreviewModels(next)
      setModelDrag({ index: cur })
      flip()
      follow(ev)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      ended = true
      if (dragEl !== null) {
        dragEl.style.transform = ''
        dragEl.style.position = ''
        dragEl.style.zIndex = ''
      }
      setModelDrag(null)
      setPreviewModels(null)
      if (cur !== cur0) onReorderModels(p.id, order)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 模型列表收纳状态：true = 收起（默认展开，与视觉插件一致）。
  const [collapsed, setCollapsed] = useState(false)
  // 内嵌「添加模型」面板。
  const [panelOpen, setPanelOpen] = useState(false)
  const [addDiscovered, setAddDiscovered] = useState<ProviderModel[] | null>(null)
  const [addDiscovering, setAddDiscovering] = useState(false)
  const [addManual, setAddManual] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const isActiveProvider = active.startsWith(`${p.id}:`)
  const target = resolveActive([p], active)

  const addDiscover = async (): Promise<void> => {
    setAddDiscovering(true)
    try {
      const resp = await fetch('/api/dsh-image-create/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: p.apiBaseUrl, apiKey: p.apiKey || '' }),
      })
      const json = await resp.json()
      setAddDiscovered(json.ok && json.models ? json.models.map((m: { id: string }) => ({ id: m.id })) : [])
    } catch {
      setAddDiscovered([])
    } finally {
      setAddDiscovering(false)
    }
  }

  const togglePick = (m: ProviderModel): void => {
    setPicked(prev => {
      const next = { ...prev }
      if (next[m.id]) delete next[m.id]
      else next[m.id] = true
      return next
    })
  }

  const addManualModel = (): void => {
    const value = addManual.trim()
    if (value === '') return
    setAddManual('')
    onAddModels(p.id, [{ id: value }])
  }

  const confirmAdd = (): void => {
    const ids = Object.keys(picked)
    if (ids.length === 0) return
    onAddModels(p.id, ids.map(id => ({ id })))
    setPicked({})
    setAddDiscovered(null)
    setPanelOpen(false)
  }

  const addPanel = (
    <div className="iv_addPanel">
      <div className="iv_inlineRow">
        <button type="button" className="zGbnIq_secondaryButton" disabled={addDiscovering} onClick={() => void addDiscover()}>
          {addDiscovering ? tt('settings.fetchingModels') : tt('settings.fetchModels')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {tt('settings.addModelsHint')}
        </span>
      </div>
      {addDiscovered !== null && addDiscovered.length > 0 ? (
        <ul className="iv_candidateList" style={{ marginTop: 8 }}>
          {addDiscovered.map(model => (
            <li key={model.id} className="zGbnIq_candidate">
              <label className="iv_candidateLabel">
                <input type="checkbox" checked={Boolean(picked[model.id])} onChange={() => togglePick(model)} />
                <span className="iv_candidateId">{model.id}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {addDiscovered !== null && addDiscovered.length === 0 ? (
        <p className="zGbnIq_modelEmpty">{tt('settings.noModels')}</p>
      ) : null}
      <div className="iv_manualRow">
        <input
          className="zGbnIq_input"
          value={addManual}
          placeholder={tt('settings.addModelPlaceholder')}
          onChange={(e) => setAddManual(e.target.value)}
        />
        <button type="button" className="zGbnIq_secondaryButton" onClick={addManualModel}>
          {tt('settings.add')}
        </button>
      </div>
      <div className="zGbnIq_editorActions">
        <button type="button" className="zGbnIq_secondaryButton" onClick={() => setPanelOpen(false)}>
          {tt('settings.cancel')}
        </button>
        <button type="button" className="zGbnIq_primaryButton" disabled={Object.keys(picked).length === 0} onClick={confirmAdd}>
          {tt('settings.addPicked', { count: Object.keys(picked).length })}
        </button>
      </div>
    </div>
  )

  const shownModels = previewModels ?? p.models

  return (
    <li
      className={`zGbnIq_rowCard iv_providerCard${isActiveProvider ? ' iv_activeCard' : ''}${dragging ? ' iv_dragging' : ''}`}
      data-iv-provider-id={p.id}
    >
      <div
        className="zGbnIq_rowHead"
        style={{ background: 'rgba(128,128,128,0.10)', borderRadius: 8, padding: '6px 8px', margin: '-6px -8px' }}
      >
        <button
          type="button"
          className="iv_dragHandle"
          title={tt('settings.dragSort')}
          disabled={dragDisabled}
          onPointerDown={(e) => onDragStart(e)}
        >
          ≡
        </button>
        <Dot active={isActiveProvider} />
        <span className="zGbnIq_rowIdentity">
          <span className="zGbnIq_rowName">{p.name}</span>
          <span className="zGbnIq_rowTag">{p.models.length} {tt('settings.modelsCount')}</span>
          {isActiveProvider ? <span className="zGbnIq_rowTag iv_visionYes">{tt('settings.inUse')}</span> : null}
        </span>
        <span className="zGbnIq_rowActions">
          <button
            type="button"
            className="zGbnIq_iconButton"
            title={collapsed ? tt('settings.expand') : tt('settings.collapse')}
            onClick={() => setCollapsed(!collapsed)}
          >
            <span style={collapsed ? { transform: 'rotate(-90deg)' } : undefined}>
              <IconChevronDownOutline14 />
            </span>
          </button>
          <button type="button" className="zGbnIq_secondaryButton" onClick={onEdit}>
            {tt('settings.editProvider')}
          </button>
          <button type="button" className="zGbnIq_dangerButton" onClick={onDelete}>
            {tt('settings.removeProvider')}
          </button>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p className="iv_metaText" style={{ flex: 1 }} title={p.apiBaseUrl}>
          {p.apiBaseUrl}
        </p>
      </div>

      {!collapsed && shownModels.length > 0 ? (
        <ul className="zGbnIq_modelList" style={{ margin: 0 }}>
          {shownModels.map((model, mi) => {
            const isUsing = isActiveProvider && target !== null && target.model.id === model.id
            return (
              <li
                key={model.id}
                className={`zGbnIq_modelEntry${modelDrag !== null && modelDrag.index === mi ? ' iv_dragging' : ''}`}
                data-iv-model-index={mi}
                data-iv-model-id={model.id}
                style={isUsing ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined}
              >
                <div className="zGbnIq_modelRow iv_modelRow">
                  <button
                    type="button"
                    className="iv_dragHandle"
                    title={tt('settings.dragSort')}
                    disabled={dragDisabled}
                    onPointerDown={(e) => beginModelDrag(mi, e)}
                  >
                    ≡
                  </button>
                  <span className="iv_candidateId">{model.id}</span>
                  <button
                    type="button"
                    className="zGbnIq_secondaryButton"
                    style={{ height: 28, padding: '0 10px', fontSize: 12, borderRadius: 14 }}
                    disabled={isUsing}
                    title={isUsing ? tt('settings.inUse') : tt('settings.useModel')}
                    onClick={() => onUse(p.id, model.id)}
                  >
                    {isUsing ? tt('settings.inUse') : tt('settings.use')}
                  </button>
                  <button
                    type="button"
                    className="zGbnIq_iconButton zGbnIq_iconButtonDanger"
                    title={tt('settings.removeModel')}
                    onClick={() => onRemoveModel(p.id, model.id)}
                  >
                    ×
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : !collapsed ? (
        <p className="zGbnIq_modelEmpty">{tt('settings.noModels')}</p>
      ) : null}

      {!collapsed && (panelOpen ? addPanel : (
        <button type="button" className="zGbnIq_addModelButton" style={{ marginTop: 8 }} onClick={() => setPanelOpen(true)}>
          + {tt('settings.addModel')}
        </button>
      ))}
    </li>
  )
}

// ===== 设置页主体 =====

/**
 * 设置页。无 props：自足（通过插件自身 HTTP 配置路由），渲染方式与视觉插件一致。
 */
export function ImageGenSettingsPage() {
  const [data, setData] = useState<{ providers: Provider[]; active: string; enabled: boolean }>({ providers: [], active: '', enabled: false })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ index: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [saved, setSaved] = useState(false)
  const [drag, setDrag] = useState<{ index: number } | null>(null)
  const [previewOrder, setPreviewOrder] = useState<Provider[] | null>(null)
  // ===== 在线更新相关状态 =====
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null) // 更新检查结果（null=未检查/无更新）
  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      const resp = await fetch('/api/dsh-image-create/config')
      const json = await resp.json()
      if (!resp.ok || json.ok !== true) throw new Error(json?.message ?? `HTTP ${resp.status}`)
      const cfg = json.config as ImageGenConfig
      setData({ providers: cfg.providers ?? [], active: cfg.active ?? '', enabled: cfg.enabled ?? true })
    } catch (e) {
      setError(tt('settings.loadFailed') + ': ' + String(e instanceof Error ? e.message : e))
    } finally {
      setLoaded(true)
    }
  }
  useEffect(() => { void reload() }, [])

  // 打开设置页即检查一次 GitHub Release 更新（可选功能，失败静默不打扰）。
  useEffect(() => {
    let disposed = false
    fetch(UPDATE_API.check, { method: 'POST' })
      .then(r => r.json())
      .then((json: { ok?: boolean; update?: UpdateInfo }) => {
        if (disposed || !json.ok || json.update === undefined) return
        setUpdateInfo(json.update)
      })
      .catch(() => { /* 更新发现是可选功能 */ })
    return () => { disposed = true }
  }, [])

  // 一键安装最新 Release（与视觉插件同款：宿主校验版本后从 GitHub Release tarball 安装）。
  const applyUpdate = async (): Promise<void> => {
    if (updateInfo === null || updating) return
    setUpdating(true)
    setUpdateMessage(null)
    try {
      const resp = await fetch(UPDATE_API.apply, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: updateInfo.latestVersion }),
      })
      const json = await resp.json()
      if (json.ok !== true) throw new Error(json?.message ?? `HTTP ${resp.status}`)
      setUpdateMessage(`已更新到 ${String(json.updatedVersion)}，请重启 DSH 生效`)
    } catch (e) {
      setUpdateMessage('更新失败: ' + String(e instanceof Error ? e.message : e))
    } finally {
      setUpdating(false)
    }
  }

  const flashSaved = (): void => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1800)
  }

  const saveConfig = async (next: Partial<ImageGenConfig>): Promise<void> => {
    const resp = await fetch('/api/dsh-image-create/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    })
    const json = await resp.json()
    if (json.ok !== true) throw new Error(json?.message ?? `HTTP ${resp.status}`)
    const cfg = json.config as ImageGenConfig
    setData({ providers: cfg.providers ?? [], active: cfg.active ?? '', enabled: cfg.enabled ?? true })
    flashSaved()
    // 通知其他表面（生图面板等）重新读取配置。
    try { window.dispatchEvent(new CustomEvent('dsh-image-create-config-changed')) } catch { /* ignore */ }
  }

  const reorderModels = async (providerId: string, newModels: ProviderModel[]): Promise<void> => {
    setError('')
    try {
      const providers = data.providers.map(pr => pr.id !== providerId ? pr : { ...pr, models: newModels })
      await saveConfig({ providers })
    } catch (e) {
      setError(tt('settings.reorderFailed') + ': ' + String(e instanceof Error ? e.message : e))
    }
  }

  const beginProviderDrag = (idx: number, e: React.PointerEvent): void => {
    e.preventDefault()
    if (editing !== null || adding) return
    let cur = idx
    let order = (previewOrder ?? data.providers).slice()
    let grabOffset = 0
    let dragEl: HTMLElement | null = null
    let lastY = e.clientY
    const flipBefore = new Map<string, number>()
    let flipScheduled = false
    let followScheduled = false
    let ended = false
    const layoutTop = (el: HTMLElement): number => {
      const r = el.getBoundingClientRect()
      const t = el.style.transform
      if (typeof t === 'string' && t !== '' && t !== 'none') {
        const m = t.match(/translateY\((-?[\d.]+)px\)/)
        if (m !== null) return r.top - parseFloat(m[1])
      }
      return r.top
    }
    const snap = (): void => {
      const nodes = Array.from(document.querySelectorAll('[data-iv-provider-id]')) as HTMLElement[]
      flipBefore.clear()
      nodes.forEach(el => flipBefore.set(el.getAttribute('data-iv-provider-id') ?? '', layoutTop(el)))
    }
    const flip = (): void => {
      if (flipScheduled || ended) return
      flipScheduled = true
      requestAnimationFrame(() => {
        flipScheduled = false
        if (ended) return
        const els = Array.from(document.querySelectorAll('[data-iv-provider-id]')) as HTMLElement[]
        els.forEach(el => {
          if (el === dragEl) return
          const from = flipBefore.get(el.getAttribute('data-iv-provider-id') ?? '')
          if (from === undefined) return
          const to = layoutTop(el)
          const delta = from - to
          if (Math.abs(delta) < 0.5) return
          el.style.transition = 'none'
          el.style.transform = `translateY(${delta}px)`
          void el.getBoundingClientRect()
          el.style.transition = 'transform 180ms ease'
          el.style.transform = ''
        })
      })
    }
    const follow = (ev: PointerEvent): void => {
      lastY = ev.clientY
      if (dragEl === null || followScheduled) return
      followScheduled = true
      requestAnimationFrame(() => {
        followScheduled = false
        if (dragEl === null) return
        let ty = lastY - grabOffset - layoutTop(dragEl)
        const listEl = dragEl.parentElement
        if (listEl !== null) {
          const lr = listEl.getBoundingClientRect()
          const visual = layoutTop(dragEl) + ty
          const minV = lr.top + 2
          const maxV = lr.bottom - dragEl.offsetHeight - 2
          if (visual < minV) ty = minV - layoutTop(dragEl)
          if (visual > maxV) ty = maxV - layoutTop(dragEl)
        }
        if (Math.abs(ty) < 0.5) ty = 0
        dragEl.style.transition = 'none'
        dragEl.style.transform = `translateY(${ty}px)`
      })
    }
    setDrag({ index: idx })
    setPreviewOrder(order)
    const initEl = document.querySelector(`[data-iv-provider-id="${order[idx].id}"]`) as HTMLElement | null
    if (initEl !== null) {
      dragEl = initEl
      grabOffset = e.clientY - layoutTop(initEl)
      initEl.style.position = 'relative'
      initEl.style.zIndex = '5'
      follow(e.nativeEvent)
    }
    const onMove = (ev: PointerEvent): void => {
      const nodes = Array.from(document.querySelectorAll('[data-iv-provider-id]')) as HTMLElement[]
      let target = -1
      for (let i = 0; i < nodes.length; i++) {
        const top = layoutTop(nodes[i])
        if (ev.clientY >= top && ev.clientY <= top + nodes[i].offsetHeight) { target = i; break }
      }
      if (target < 0 || target === cur) {
        follow(ev)
        return
      }
      snap()
      const next = order.slice()
      const t = next.splice(cur, 1)[0]
      next.splice(target, 0, t)
      order = next
      cur = target
      setPreviewOrder(next)
      setDrag({ index: cur })
      flip()
      follow(ev)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      ended = true
      if (dragEl !== null) {
        dragEl.style.transform = ''
        dragEl.style.position = ''
        dragEl.style.zIndex = ''
      }
      setDrag(null)
      if (cur !== idx) {
        saveConfig({ providers: order })
          .then(() => setPreviewOrder(null))
          .catch((err) => {
            setPreviewOrder(null)
            setError(tt('settings.reorderFailed') + ': ' + String(err instanceof Error ? err.message : err))
          })
      } else {
        setPreviewOrder(null)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activate = async (providerId: string, modelId: string): Promise<void> => {
    setError('')
    try {
      const resp = await fetch('/api/dsh-image-create/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, modelId }),
      })
      const json = await resp.json()
      if (json.ok !== true) throw new Error(json?.message ?? `HTTP ${resp.status}`)
      await reload()
// 通知主界面生图面板重新读取配置，否则面板模型下拉不会跟随激活变化。
        try { window.dispatchEvent(new CustomEvent('dsh-image-create-config-changed')) } catch { /* ignore */ }
      flashSaved()
    } catch (e) {
      setError(tt('settings.activateFailed') + ': ' + String(e instanceof Error ? e.message : e))
    }
  }

  const removeProvider = async (providerId: string, providerName: string): Promise<void> => {
    if (!window.confirm(tt('settings.confirmRemoveProvider', { name: providerName }))) return
    setError('')
    try {
      const providers = data.providers.filter(p => p.id !== providerId)
      await saveConfig({ providers })
    } catch (e) {
      setError(tt('settings.removeFailed') + ': ' + String(e instanceof Error ? e.message : e))
    }
  }

  const removeModel = async (providerId: string, modelId: string): Promise<void> => {
    if (!window.confirm(tt('settings.confirmRemoveModel', { name: modelId }))) return
    setError('')
    try {
      const providers = data.providers.map(p =>
        p.id !== providerId ? p : { ...p, models: p.models.filter(m => m.id !== modelId) },
      )
      await saveConfig({ providers })
    } catch (e) {
      setError(tt('settings.removeFailed') + ': ' + String(e instanceof Error ? e.message : e))
    }
  }

  const addModels = async (providerId: string, newModels: ProviderModel[]): Promise<void> => {
    setError('')
    try {
      const providers = data.providers.map(p => {
        if (p.id !== providerId) return p
        const ids = new Set(p.models.map(m => m.id))
        return { ...p, models: [...p.models, ...newModels.filter(m => !ids.has(m.id))] }
      })
      await saveConfig({ providers })
    } catch (e) {
      setError(tt('settings.saveFailed') + ': ' + String(e instanceof Error ? e.message : e))
    }
  }

  const finishEdit = async (draft: Provider): Promise<void> => {
    const providers = data.providers.slice()
    if (editing !== null && editing.index >= 0 && editing.index < providers.length) {
      // 编辑：保留原 id。
      providers[editing.index] = { ...draft, id: providers[editing.index].id }
    } else {
      providers.push(draft)
    }
    await saveConfig({ providers })
    setEditing(null)
    setAdding(false)
  }

  const providers = data.providers
  const active = data.active
  const target = resolveActive(providers, active)
  const shownProviders = previewOrder ?? providers

  const providerCards = shownProviders.map((prov, idx) => {
    // 就地编辑：编辑界面直接渲染在原卡片位置，不收起、不跳转（与视觉插件一致）。
    if (editing !== null && editing.index === idx) {
      return (
        <ProviderEditor
          key={`edit-${prov.id}`}
          id="iv-editor-edit"
          initial={prov}
          existingBaseUrls={shownProviders.filter((_, i) => i !== idx).map(p => p.apiBaseUrl)}
          onSave={(draft) => finishEdit(draft)}
          onCancel={() => setEditing(null)}
        />
      )
    }
    return (
      <ProviderCard
        key={prov.id}
        provider={prov}
        active={active}
        onUse={(pid, mid) => void activate(pid, mid)}
        onRemoveModel={(pid, mid) => void removeModel(pid, mid)}
        onAddModels={(pid, ms) => void addModels(pid, ms)}
        onEdit={() => { setEditing({ index: idx }); setAdding(false) }}
        onDelete={() => void removeProvider(prov.id, prov.name)}
        onReorderModels={(pid, ms) => void reorderModels(pid, ms)}
        onDragStart={(e) => beginProviderDrag(idx, e)}
        dragging={drag !== null && drag.index === idx}
        dragDisabled={editing !== null || adding}
      />
    )
  })

  return (
    <div className="zGbnIq_section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 className="zGbnIq_title">{tt('settings.title')}</h2>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 }}>v{PLUGIN_VERSION}</span>
          {updateInfo !== null && updateInfo.updateAvailable ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' }}>有新版本 v{updateInfo.latestVersion}</span>
          ) : null}
          {updateInfo !== null && updateInfo.updateAvailable ? (
            <button
              type="button"
              className="zGbnIq_addButton"
              disabled={updating}
              onClick={() => void applyUpdate()}
              style={{ height: 26, padding: '0 10px', fontSize: 12 }}
            >
              {updating ? '更新中…' : '更新'}
            </button>
          ) : null}
          {updateInfo !== null && updateInfo.updateAvailable ? (
            <a
              href={updateInfo.releaseUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: 'var(--dsw-alias-link, var(--dsw-alias-primary))', textDecoration: 'none' }}
            >
              查看 Release
            </a>
          ) : null}
          {updateMessage !== null ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }}>{updateMessage}</span> : null}
        </span>
      </div>
      <p className="zGbnIq_intro">{tt('settings.description')}</p>

      {/* 总开关（与视觉插件一致的样式） */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '10px 14px', margin: '0 0 4px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{tt('settings.enabled')}</div>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 }}>{tt('settings.enabledHint')}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data.enabled === true}
          title={data.enabled === true ? '点击关闭' : '点击开启'}
          style={{
            width: 44, height: 24, borderRadius: 12, flex: 'none', cursor: 'pointer', border: 'none', position: 'relative',
            background: data.enabled === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l3)',
            transition: 'background .15s',
          }}
          onClick={() => { void saveConfig({ enabled: data.enabled !== true }) }}
        >
          <span style={{ position: 'absolute', top: 2, left: data.enabled === true ? 22 : 2, width: 20, height: 20, borderRadius: 10, background: '#fff', transition: 'left .15s' }} />
        </button>
      </div>

      {/* 当前使用条（与视觉插件 iv_currentBar 一致） */}
      <div className="iv_currentBar">
        {target !== null ? (
          <span>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{tt('settings.currentUse')}：</span>
            <strong>{target.provider.name}</strong>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}> · </span>
            <strong>{target.model.id}</strong>
          </span>
        ) : (
          <span className="iv_currentEmpty">{tt('settings.noActive')}</span>
        )}
        {saved ? <span className="zGbnIq_savedNotice" style={{ marginLeft: 'auto' }}>{tt('settings.saved')}</span> : null}
      </div>

      {!loaded ? <p className="zGbnIq_intro">{tt('settings.loading')}</p> : null}
      {error !== '' ? <p className="zGbnIq_error">{error}</p> : null}

      <ul className="zGbnIq_rows">
        {providerCards}
        {adding ? (
          <ProviderEditor key="add" id="iv-editor-add" initial={null} existingBaseUrls={providers.map(p => p.apiBaseUrl)} onSave={(draft) => finishEdit(draft)} onCancel={() => setAdding(false)} />
        ) : null}
      </ul>

      {editing === null && !adding ? (
        <div className="zGbnIq_addActions" style={{ marginTop: 12, gap: 8, display: 'flex' }}>
          <button type="button" className="zGbnIq_addButton" onClick={() => setAdding(true)}>
            + {tt('settings.addProvider')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
