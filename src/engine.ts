/**
 * Upstream proxy engine: forwards a generate request to the configured
 * OpenAI-compatible image endpoint (/images/generations for text-to-image,
 * /images/edits for image-to-image) and normalizes the response to base64
 * images so the browser never fetches the upstream itself.
 *
 * Supports multi-provider with automatic fallback: if the active provider
 * fails, the engine tries other configured providers.
 *
 * Framework-free (no cordis imports) so the route layer and tests can drive
 * it directly.
 */

import type { GeneratedImage, GenerateRequest, GenerateResult, Provider } from './protocol.ts'

/** The upstream credentials the panel's settings card configures. */
export interface UpstreamConfig {
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  apiUrl: string
  /** Bearer API key. */
  apiKey: string
}

/** A generation failure with a user-presentable message. */
export class ImageGenError extends Error {
  /** Stable wire code. */
  readonly code: string

  constructor(message: string, code = 'generate-failed') {
    super(message)
    this.name = 'ImageGenError'
    this.code = code
  }
}

/** Total budget for the upstream generation call (image models are slow). */
const UPSTREAM_TIMEOUT_MS = 240_000

/** Budget for downloading one result image URL. */
const IMAGE_FETCH_TIMEOUT_MS = 60_000

/** Cap on the reference image payload (edit mode), in bytes. */
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024

/** Sizes dall-e-3 accepts; anything else falls back to its square default. */
const DALLE3_SIZES = new Set(['1024x1024', '1792x1024', '1024x1792'])

/** Content-type extension hints for URL-fetched images. */
function mimeOfExtension(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  if (match === null) return undefined
  switch (match[1]!.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return undefined
  }
}

/** Parse `data:<mime>;base64,<payload>` into its parts; undefined when malformed. */
function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim())
  if (match === null || match[3] === undefined) return undefined
  if (match[2] === undefined) {
    return undefined
  }
  return { mime: match[1] ?? 'application/octet-stream', base64: match[3] }
}

/** Strip a data: prefix from an upstream b64 payload if a gateway added one. */
function bareBase64(value: string): string {
  const parsed = parseDataUrl(value)
  return parsed !== undefined && parsed.base64 !== undefined ? parsed.base64 : value
}

/** Clamp the requested image count into the API-accepted range. */
function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(4, Math.max(1, Math.round(n)))
}

/** Pick the effective per-model request parameters. Never includes `n`: the
 *  batch parameter is rejected by Responses-API-based gateways (tools[0].n),
 *  so the count is satisfied by parallel single-image requests instead. */
function effectiveParams(request: GenerateRequest): {
  model: string
  size?: string
  quality?: string
  detail?: string
  ppi?: string
} {
  const model = request.model.trim() === '' ? 'gpt-image-2' : request.model.trim()
  // dall-e-3 has no quality/detail knobs and only produces one image.
  if (model === 'dall-e-3') {
    const size = DALLE3_SIZES.has(request.size) ? request.size : '1024x1024'
    return { model, size }
  }
  return {
    model,
    ...request.size !== '' && request.size !== 'auto' ? { size: request.size } : {},
    ...request.quality !== '' && request.quality !== 'auto' ? { quality: request.quality } : {},
    ...request.detail !== '' ? { detail: request.detail } : {},
    ...request.ppi !== undefined && request.ppi !== '' ? { ppi: request.ppi } : {},
  }
}

/** How many single-image requests to issue for the requested image count. */
function effectiveCount(request: GenerateRequest): number {
  const model = request.model.trim() === '' ? 'gpt-image-2' : request.model.trim()
  if (model === 'dall-e-3') return 1
  return clampCount(request.n)
}

/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(
  item: Record<string, unknown>,
  upstream: UpstreamConfig,
): Promise<{ b64: string; mime: string; revisedPrompt?: string }> {
  const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
  if (typeof item.b64_json === 'string') {
    return { b64: bareBase64(item.b64_json), mime: 'image/png', revisedPrompt }
  }
  if (typeof item.url !== 'string' || item.url === '') {
    throw new ImageGenError('upstream image item has neither b64_json nor url')
  }
  const url = item.url
  if (url.startsWith('data:')) {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) throw new ImageGenError('upstream returned a malformed data: url')
    return { b64: parsed.base64, mime: parsed.mime, revisedPrompt }
  }
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        ...upstream.apiKey === '' ? {} : { authorization: `Bearer ${upstream.apiKey}` },
      },
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ImageGenError(`failed to fetch the generated image url: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new ImageGenError(`failed to fetch the generated image url: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')
  const mime = contentType !== null && contentType !== ''
    ? contentType.split(';')[0]!.trim()
    : mimeOfExtension(url) ?? 'image/png'
  return { b64: buffer.toString('base64'), mime, revisedPrompt }
}

/**
 * Issue one single-image request (never sends `n`). The response is kept as a
 * list so a gateway that happens to return several images per call still works.
 */
async function requestOneImage(
  baseUrl: string,
  upstream: UpstreamConfig,
  request: GenerateRequest,
  params: ReturnType<typeof effectiveParams>,
): Promise<GeneratedImage[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstream.apiKey.trim()}`,
  }
  let body: BodyInit
  if (request.mode === 'edit') {
    if (typeof request.image !== 'string' || request.image === '') {
      throw new ImageGenError('图生图需要上传参考图片', 'edit-image-missing')
    }
    const parsed = parseDataUrl(request.image)
    if (parsed === undefined) throw new ImageGenError('参考图片格式无效', 'edit-image-invalid')
    let bytes: Buffer
    try {
      bytes = Buffer.from(parsed.base64, 'base64')
    } catch {
      throw new ImageGenError('参考图片数据无法解码', 'edit-image-invalid')
    }
    if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) {
      throw new ImageGenError('参考图片超过 10MB 上限', 'edit-image-too-large')
    }
    const form = new FormData()
    form.append('image', new Blob([bytes], { type: parsed.mime }), `reference.${extensionOf(parsed.mime)}`)
    form.append('prompt', request.prompt)
    form.append('model', params.model)
    if (params.size !== undefined) form.append('size', params.size)
    if (params.quality !== undefined) form.append('quality', params.quality)
    if (params.detail !== undefined) form.append('detail', params.detail)
    body = form
  } else {
    headers['content-type'] = 'application/json'
    body = JSON.stringify({ prompt: request.prompt, ...params } as Record<string, unknown>)
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/images/${request.mode === 'edit' ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/aborter/i.test(message) || /timeout/i.test(message)) {
      throw new ImageGenError('上游接口响应超时（240 秒）', 'upstream-timeout')
    }
    throw new ImageGenError(`无法连接上游接口：${message}`, 'upstream-unreachable')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, 'upstream-invalid')
  }
  if (!response.ok) {
    throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
  }
  if (payload === null || typeof payload !== 'object') {
    throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
  }

  const record = payload as Record<string, unknown>
  const hasDataList = Array.isArray(record.data) || Array.isArray(record.images) || Array.isArray(record.output)
  // HTTP 200 但网关在 body 中携带错误（one-api 等）：不能只看状态码判定成功。
  // 显式 error 字段，或只有 message 而无图片列表，都视为上游拒绝。
  if ((record.error !== undefined && record.error !== null)
    || (typeof record.message === 'string' && record.message !== '' && !hasDataList)) {
    throw new ImageGenError(upstreamMessage(payload, response.status), 'upstream-rejected')
  }

  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
      ? record.images
      : Array.isArray(record.output)
        ? record.output
        : undefined
  if (data === undefined) {
    throw new ImageGenError('上游响应缺少 data 数组', 'upstream-invalid')
  }
  if (data.length === 0) {
    throw new ImageGenError('上游返回了 0 张图片', 'upstream-empty')
  }
  return Promise.all(data.map(async (entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new ImageGenError('上游响应包含无效的图片条目', 'upstream-invalid')
    }
    return normalizeItem(entry as Record<string, unknown>, upstream)
  }))
}

/**
 * Forward one generate request to a specific upstream endpoint.
 */
async function generateToEndpoint(
  baseUrl: string,
  upstream: UpstreamConfig,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const params = effectiveParams(request)
  const count = effectiveCount(request)
  try {
    const batches = await Promise.all(
      Array.from({ length: count }, () => requestOneImage(baseUrl, upstream, request, params)),
    )
    return { images: batches.flat() }
  } catch (error) {
    // PPI 为可选透传参数：部分网关会拒绝未知参数，去掉 PPI 重试一次（仅文生图）。
    if (request.mode !== 'edit' && request.ppi !== undefined && request.ppi !== '') {
      const fallbackRequest = { ...request, ppi: undefined }
      const fallbackParams = effectiveParams(fallbackRequest)
      const fallbackCount = effectiveCount(fallbackRequest)
      const batches = await Promise.all(
        Array.from({ length: fallbackCount }, () => requestOneImage(baseUrl, upstream, fallbackRequest, fallbackParams)),
      )
      return { images: batches.flat() }
    }
    throw error
  }
}

/**
 * Forward one generate request to the configured endpoint. The requested image
 * count is satisfied with N parallel single-image requests (the `n` batch
 * parameter is never sent, because Responses-API-based gateways reject it as
 * `tools[0].n`), then the results are flattened in order.
 *
 * Supports multi-provider fallback: tries the active provider first, then
 * falls back to other configured providers if the active one fails.
 */
export async function generateImage(upstream: UpstreamConfig, request: GenerateRequest): Promise<GenerateResult> {
  const baseUrl = upstream.apiUrl.trim().replace(/\/+$/, '')
  if (baseUrl === '') throw new ImageGenError('api_url 未配置：请先在「设置 → 插件 → 可配置」中填写', 'config-missing')
  if (upstream.apiKey.trim() === '') throw new ImageGenError('api_key 未配置：请先在「设置 → 插件 → 可配置」中填写', 'config-missing')
  return generateToEndpoint(baseUrl, upstream, request)
}

/**
 * Generate with multi-provider fallback. Tries the active provider first,
 * then falls back to other configured providers.
 */
export async function generateImageWithFallback(
  providers: Provider[],
  active: string,
  request: GenerateRequest,
  resolveKey: (provider: Provider) => Promise<string>,
): Promise<GenerateResult> {
  // Collect candidates: active first, then others
  const candidates = buildCandidateList(providers, active)
  if (candidates.length === 0) {
    throw new ImageGenError('未配置图像生成供应商：请在设置中添加并选择使用', 'config-missing')
  }

  // 文生图 + 编辑模型（如 Qwen/Qwen-Image-Edit-2509）时，上游 /images/generations
  // 会报 “Missing required key: image”。这里自动改用同供应商的可用生图模型；
  // 没有可用生图模型则给出明确提示（而不是抛出难懂的上游错误）。
  let effectiveModel = request.model
  if (request.mode === 'text' && isEditOnlyModel(effectiveModel)) {
    const target = parseActiveTarget(active)
    const activeProvider = target !== null ? providers.find(p => p.id === target.providerId) : undefined
    const alternative = activeProvider?.models.find(m => !isEditOnlyModel(m.id))
    if (alternative !== undefined) {
      effectiveModel = alternative.id
    } else {
      throw new ImageGenError(
        `模型 ${request.model} 是图像编辑模型，不能直接文生图：请在设置中选择生图模型（如 Qwen-Image），或上传参考图使用图生图`,
        'edit-model-for-text',
      )
    }
  }
  const effectiveRequest = effectiveModel === request.model ? request : { ...request, model: effectiveModel }

  const errors: string[] = []
  for (const candidate of candidates) {
    const apiKey = await resolveKey(candidate.provider)
    if (!apiKey) continue
    try {
      return await generateToEndpoint(candidate.provider.apiBaseUrl, { apiUrl: candidate.provider.apiBaseUrl, apiKey }, effectiveRequest)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${candidate.provider.name ?? candidate.provider.id}:${effectiveModel} → ${msg}`)
    }
  }
  throw new ImageGenError(`所有供应商均调用失败：\n${errors.join('\n')}`, 'all-providers-failed')
}

/** 是否为“仅支持图生图”的编辑模型（按模型 id 启发式判断）。 */
function isEditOnlyModel(modelId: string): boolean {
  return /edit/i.test(String(modelId ?? ''))
}

/** Parse "providerId:modelId" from the active string. */
export function parseActiveTarget(active: string): { providerId: string; modelId: string } | null {
  const sep = String(active ?? '').indexOf(':')
  if (sep <= 0) return null
  const providerId = active.slice(0, sep)
  const modelId = active.slice(sep + 1)
  if (providerId === '' || modelId === '') return null
  return { providerId, modelId }
}

/** Build the ordered candidate list for fallback. */
function buildCandidateList(providers: Provider[], active: string): Array<{ provider: Provider; isActive: boolean }> {
  const target = parseActiveTarget(active)
  const list: Array<{ provider: Provider; isActive: boolean }> = []

  // Add active provider first
  if (target) {
    const activeProvider = providers.find(p => p.id === target.providerId)
    if (activeProvider) {
      list.push({ provider: activeProvider, isActive: true })
    }
  }

  // Add other providers
  for (const p of providers) {
    if (p.apiKey === '') continue
    if (target && p.id === target.providerId) continue
    list.push({ provider: p, isActive: false })
  }

  return list
}

/** Human-readable failure message from an upstream error payload. */
function upstreamMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message !== '') return message
    }
    if (typeof record.message === 'string' && record.message !== '') return record.message
    if (typeof record.error === 'string' && record.error !== '') return record.error
  }
  return `上游接口拒绝请求（HTTP ${status}）`
}

/** File extension for a MIME type (multipart reference image). */
function extensionOf(mime: string): string {
  switch (mime.split(';')[0]!.trim()) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    case 'image/png':
    default: return 'png'
  }
}

/** Normalize config: migrate legacy single-provider shape to multi-provider. */
export function normalizeConfig(raw: Record<string, unknown>): {
  enabled: boolean
  announceToAgent: boolean
  providers: Provider[]
  active: string
} {
  const src = raw ?? {}
  const enabled = src.enabled !== false
  const announceToAgent = src.announceToAgent !== false

  let providers: Provider[] = Array.isArray(src.providers)
    ? (src.providers as Provider[]).filter(p => p && typeof p.id === 'string' && p.id !== '').map(p => ({
        ...p,
        models: Array.isArray(p.models) ? p.models.map(m => ({ ...m })) : [],
      }))
    : []

  // Migrate legacy single-provider config
  if (providers.length === 0) {
    const legacyUrl = String(src.apiUrl ?? '')
    const legacyKey = String(src.apiKey ?? '')
    if (legacyUrl !== '') {
      providers = [{
        id: 'default',
        name: '默认供应商',
        apiBaseUrl: legacyUrl,
        apiKey: legacyKey,
        models: [{ id: 'gpt-image-2' }],
      }]
    }
  }

  // Ensure each provider has at least one model. Rebuild the entry rather than
  // mutating it in place: the source value may be a frozen settings snapshot.
  providers = providers.map(p => (
    !Array.isArray(p.models) || p.models.length === 0
      ? { ...p, models: [{ id: 'gpt-image-2' }] }
      : p
  ))

  let active = String(src.active ?? '')
  if (!parseActiveTarget(active) && providers.length > 0) {
    active = `${providers[0].id}:${providers[0].models[0].id}`
  }

  return { enabled, announceToAgent, providers, active }
}

/** Resolve a provider's API key from its stored value (supports cred:REF / env:VAR). */
export async function resolveProviderKey(provider: Provider, resolveKeyRef: (raw: string) => Promise<string>): Promise<string> {
  return resolveKeyRef(String(provider.apiKey ?? ''))
}