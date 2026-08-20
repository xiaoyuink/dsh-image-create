/**
 * The /api/dsh-image-create route family: config routes (custom HTTP,
 * bypassing the settings wire white-list), model discovery, the generate
 * proxy, and history routes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, settingsNamespace, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { generateImage, generateImageWithFallback, normalizeConfig, resolveProviderKey, type UpstreamConfig } from './engine.ts'
import { appendHistory, clearHistory, historyImagesDir, listHistory, readHistoryImage, removeHistory } from './history-store.ts'
import { checkForUpdate, CURRENT_VERSION, installUpdate } from './updater.ts'
import {
  CONFIG_API, GENERATE_API, HISTORY_API, IMAGEGEN_SETTINGS_NAMESPACE,
  PRESET_PROVIDER_CATALOG, SETTINGS_API, UPDATE_API,
  type GeneratedImage, type GenerateRequest, type HistoryEntry, type HistoryEntryInput, type Provider,
} from './protocol.ts'

/** Cap on JSON request bodies (settings ops and generate payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024

/** Cap on history append bodies (base64 result images can be much larger). */
const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024

/** Settings seam face the bridge needs (the host settings provider). */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: unknown, ops: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
}

/** Route dependencies. */
export interface ImageGenRoutesDeps {
  /** The settings seam (namespace storage). */
  settings: SettingsSeam
  /** Resolve the current upstream config (composition entry + settings). */
  resolve: () => UpstreamConfig
  /** Resolve the full config including providers. */
  resolveFull: () => ReturnType<typeof normalizeConfig>
  /** Resolve a key reference (cred:REF / env:VAR). */
  resolveKeyRef: (raw: string) => Promise<string>
  /** 把明文 API Key 写入 DSH 凭据服务（settings 只存 cred:REF）；失败应抛错拒绝保存。 */
  storeCredential: (ref: string, key: string) => Promise<void>
  /** Save providers + active（及总开关等配置字段，供设置页持久化）。 */
  saveProviders: (
    providers: Provider[],
    active: string,
    extra?: { enabled?: boolean; announceToAgent?: boolean },
  ) => Promise<void>
  /** Overrideable history backend, primarily for host integration tests. */
  history?: {
    list: () => Promise<HistoryEntry[]>
    append: (entry: HistoryEntryInput) => Promise<HistoryEntry[]>
    remove: (id: string) => Promise<HistoryEntry[]>
    clear: () => Promise<HistoryEntry[]>
    readImage: (file: string) => Promise<{ data: Buffer; mime: string } | undefined>
  }
}

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body. */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validate a submitted history entry (images carry base64). */
function parseHistoryEntryInput(body: Record<string, unknown>): HistoryEntryInput | undefined {
  const raw = body.entry
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.createdAt !== 'number') return undefined
  if (entry.mode !== 'text' && entry.mode !== 'edit') return undefined
  if (typeof entry.model !== 'string' || typeof entry.prompt !== 'string') return undefined
  if (typeof entry.size !== 'string' || typeof entry.quality !== 'string' || typeof entry.detail !== 'string') return undefined
  if (typeof entry.n !== 'number') return undefined
  if (!Array.isArray(entry.images)) return undefined
  const images: GeneratedImage[] = []
  for (const item of entry.images) {
    if (item === null || typeof item !== 'object') return undefined
    const image = item as Record<string, unknown>
    if (typeof image.b64 !== 'string' || typeof image.mime !== 'string') return undefined
    images.push({
      b64: image.b64,
      mime: image.mime,
      ...typeof image.revisedPrompt === 'string' ? { revisedPrompt: image.revisedPrompt } : {},
    })
  }
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    model: entry.model,
    prompt: entry.prompt,
    size: entry.size,
    quality: entry.quality,
    detail: entry.detail,
    n: entry.n,
    images,
    ...typeof entry.refName === 'string' ? { refName: entry.refName } : {},
  }
}

/** Extract the image file name from a history-image request URL. */
function imageFileFrom(rawUrl: string | undefined, basePath: string): string | undefined {
  if (rawUrl === undefined) return undefined
  let pathname: string
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${basePath}/`)) return undefined
  return decodeURIComponent(pathname.slice(basePath.length + 1))
}

/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor: SettingsDescriptor): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    ...descriptor.secrets === undefined ? {} : {
      secrets: descriptor.secrets.map(secret => ({ path: [...secret.path], set: secret.set })),
    },
    revision: descriptor.revision,
  }
}

/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof SettingsConflictError) {
    return { ok: false, code: 'settings-conflict', message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'settings-rejected', message }
}

/** MASKED_KEY placeholder for API key redaction. */
const MASKED_KEY = '********'

/** Credential reference name derived from provider id. */
function credentialRefFor(providerId: string): string {
  const cleaned = String(providerId ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1')
  return `IMAGEGEN_${cleaned || 'PROVIDER'}`
}

/** Try to list models from an OpenAI-compatible /v1/models endpoint. */
async function tryListModels(baseUrl: string, apiKey: string): Promise<{ models: string[]; reason: string | null }> {
  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    })
  } catch (error) {
    return { models: [], reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' }
  }
  if (resp.status === 401 || resp.status === 403) return { models: [], reason: 'auth' }
  if (resp.status === 404) return { models: [], reason: 'not-found' }
  if (!resp.ok) return { models: [], reason: 'http' }
  let data: unknown
  try { data = await resp.json() } catch { return { models: [], reason: 'shape' } }
  if (!data || typeof data !== 'object') return { models: [], reason: 'shape' }
  const arr = (data as Record<string, unknown>).data
  if (!Array.isArray(arr)) return { models: [], reason: 'shape' }
  const models = arr
    .map((m: unknown) => (typeof m === 'string' ? m : (m as Record<string, unknown>)?.id))
    .filter((x: unknown): x is string => typeof x === 'string' && x !== '')
  if (models.length === 0) return { models: [], reason: 'shape' }
  return { models, reason: null }
}

/** Find a preset provider catalog entry by baseUrl match. */
function findPreset(baseUrl: string): { name: string; models: string[] } | null {
  const url = String(baseUrl ?? '').toLowerCase()
  for (const p of PRESET_PROVIDER_CATALOG) {
    if (url.includes(p.match)) return { name: p.name, models: p.models }
  }
  return null
}

/**
 * 模型 id 关键词启发式判断：是否为图像生成（text-to-image）模型。
 * 覆盖各预设厂商的生图型号 id 特征；裸 qwen / hunyuan-standard 等文本模型不命中。
 */
const IMAGEGEN_HINTS: RegExp[] = [
  /gpt-image/i, /dall-e/i, /flux/i, /stable-diffusion/i, /sdxl/i,
  /cogview/i, /hunyuan-image/i, /doubao-?[\w.-]*image-?generate/i,
  /qwen-?image/i, /minimax-?image/i, /step-1x/i, /janus/i,
  /kolors/i, /pixart/i, /ideogram/i, /recraft/i, /midjourney/i,
]
function guessImageGen(modelId: string): boolean {
  const id = String(modelId ?? '').toLowerCase()
  return IMAGEGEN_HINTS.some(re => re.test(id))
}

/** Reason message for model list failure. */
function reasonMessage(reason: string): string {
  switch (reason) {
    case 'auth': return '需要有效的 API Key 才能获取模型列表'
    case 'not-found': return '该端点不支持模型列表接口，请手动输入模型名称'
    case 'timeout': return '获取模型列表超时，请检查网络'
    case 'network': return '无法连接该端点，请检查地址与网络'
    case 'shape': return '返回的模型列表格式无法解析'
    case 'http': return '端点返回错误，无法获取模型列表'
    default: return '无法获取模型列表'
  }
}

/**
 * Build every /api/dsh-image-create route.
 * @param deps - settings seam + config resolver.
 * @param options - when `enabled` is false, only the config routes are built:
 *   the generate / history / update routes stay unregistered until the plugin
 *   is re-enabled (the config routes must remain so the settings page can
 *   turn the master switch back on).
 * @returns the route registrations.
 */
export function makeRoutes(deps: ImageGenRoutesDeps, options: { enabled?: boolean } = {}): WebRoute[] {
  const history = deps.history ?? {
    list: listHistory,
    append: appendHistory,
    remove: removeHistory,
    clear: clearHistory,
    readImage: readHistoryImage,
  }
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  // 配置类路由（设置页依赖，enabled=false 时也必须可用，以便重新打开总开关）。
  const always: WebRoute[] = [
    // ============================================================ CONFIG GET
    {
      kind: 'exact',
      path: CONFIG_API.get,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          // Return config with redacted keys
          const cfg = deps.resolveFull()
          const redacted = {
            ...cfg,
            providers: cfg.providers.map(p => ({
              ...p,
              apiKey: p.apiKey !== '' && !/^(env|cred):/.test(p.apiKey) ? MASKED_KEY : p.apiKey,
            })),
            // 图片实际保存目录（供面板历史区展示“图片保存于”）。
            saveDir: historyImagesDir(),
          }
          writeJson(res, 200, { ok: true, config: redacted })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 200, { ok: false, code: 'bad-request', message: '无法读取请求体' })
            return
          }
          try {
            // Merge with current config
            const current = deps.resolveFull()
            const merged = { ...current, ...body } as Record<string, unknown>

            // Handle providers: merge with existing to preserve keys
            if (Array.isArray(body.providers)) {
              const incomingProviders = body.providers as Array<Record<string, unknown>>
              const existingProviders = current.providers
              merged.providers = incomingProviders.map(incoming => {
                const existing = existingProviders.find(p => p.id === incoming.id)
                const apiKey = String(incoming.apiKey ?? '')
                // If masked, keep existing key
                const resolvedKey = apiKey === MASKED_KEY
                  ? (existing?.apiKey ?? '')
                  : apiKey
                return {
                  id: String(incoming.id),
                  name: String(incoming.name ?? incoming.id),
                  apiBaseUrl: String(incoming.apiBaseUrl ?? ''),
                  apiKey: resolvedKey,
                  models: Array.isArray(incoming.models)
                    ? incoming.models.map((m: unknown) => typeof m === 'string' ? { id: m } : { id: String((m as Record<string, unknown>).id ?? '') })
                    : (existing?.models ?? []),
                }
              })

              // Store plaintext keys to credentials service（照视觉插件：settings
              // 只留 cred:REF；凭据服务不可用或写入失败时拒绝保存，绝不落明文）。
              for (const p of merged.providers as Provider[]) {
                const key = p.apiKey ?? ''
                if (key === '' || key === MASKED_KEY || /^(env|cred):/.test(key)) continue
                const ref = credentialRefFor(p.id)
                try {
                  await deps.storeCredential(ref, key)
                } catch (error) {
                  throw new Error(`保存 API Key 到凭据存储失败（已拒绝写入 settings）：${messageOf(error)}`)
                }
                p.apiKey = `cred:${ref}`
              }
            }

            // Save to settings（连同总开关/播报开关一并持久化）
            await deps.saveProviders(
              (merged.providers as Provider[]) ?? [],
              String(merged.active ?? current.active),
              {
                enabled: merged.enabled !== false,
                announceToAgent: merged.announceToAgent !== false,
              },
            )

            // Read back
            const saved = deps.resolveFull()
            writeJson(res, 200, { ok: true, config: saved })
          } catch (error) {
            writeJson(res, 200, { ok: false, code: 'save-failed', message: messageOf(error) })
          }
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      },
    },

    // ============================================================ ACTIVATE
    {
      kind: 'exact',
      path: CONFIG_API.activate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '无法读取请求体' })
          return
        }
        const providerId = String(body.providerId ?? '')
        const modelId = String(body.modelId ?? '')
        if (!providerId || !modelId) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少 providerId 或 modelId' })
          return
        }
        const active = `${providerId}:${modelId}`
        const cfg = deps.resolveFull()
        const provider = cfg.providers.find(p => p.id === providerId)
        if (!provider) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: `供应商不存在: ${providerId}` })
          return
        }
        const model = provider.models.find(m => m.id === modelId)
        if (!model) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: `模型不存在: ${modelId}` })
          return
        }
        try {
          await deps.saveProviders(cfg.providers, active)
          writeJson(res, 200, { ok: true, active })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'save-failed', message: messageOf(error) })
        }
      },
    },

    // ============================================================ MODEL DISCOVERY
    {
      kind: 'exact',
      path: CONFIG_API.models,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '无法读取请求体' })
          return
        }
        const baseUrl = String(body.baseUrl ?? '').replace(/\/+$/, '')
        let apiKey = String(body.apiKey ?? '')
        if (!baseUrl) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少 baseUrl' })
          return
        }
        // Resolve key if masked or reference
        if (apiKey === MASKED_KEY || apiKey === '' || /^(env|cred):/.test(apiKey)) {
          const cfg = deps.resolveFull()
          const match = cfg.providers.find(p => p.apiBaseUrl.replace(/\/+$/, '') === baseUrl)
          // match.apiKey 可能是 cred:REF / env:VAR 引用，必须解析成真实密钥再用
          // （否则把 "cred:IMAGEGEN_xxx" 当 Bearer token，端点必返 401）。
          if (match) apiKey = await deps.resolveKeyRef(match.apiKey)
        }
        // Try to list models from endpoint
        const result = await tryListModels(baseUrl, apiKey)
        if (result.models.length > 0) {
          writeJson(res, 200, { ok: true, models: result.models.map(id => ({ id, image: guessImageGen(id) })), source: 'live' })
          return
        }
        // Fallback to preset
        const preset = findPreset(baseUrl)
        if (preset !== null) {
          writeJson(res, 200, {
            ok: true,
            models: preset.models.map(id => ({ id, image: guessImageGen(id) })),
            source: 'preset',
            warning: reasonMessage(result.reason ?? 'unknown'),
          })
          return
        }
        writeJson(res, 200, { ok: false, code: 'discovery-failed', message: reasonMessage(result.reason ?? 'unknown') })
      },
    },

    // ============================================================ SETTINGS DESCRIBE (backward compat)
    {
      kind: 'exact',
      path: SETTINGS_API.describe,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === IMAGEGEN_SETTINGS_NAMESPACE)
        writeJson(res, 200, {
          ok: true,
          value: {
            namespaces: descriptor === undefined ? [] : [toView(descriptor)],
            writable: deps.settings.writable !== false,
          },
        })
      },
    },
    // ============================================================ SETTINGS MUTATE (backward compat)
    {
      kind: 'exact',
      path: SETTINGS_API.mutate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const ns = typeof body.ns === 'string' ? body.ns : ''
        if (ns !== IMAGEGEN_SETTINGS_NAMESPACE || !Array.isArray(body.ops)) {
          writeJson(res, 200, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
          return
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
        try {
          await deps.settings.mutate(settingsNamespace(ns), body.ops, expectedRevision)
        } catch (error) {
          writeJson(res, 200, failureOf(error))
          return
        }
        const descriptor = deps.settings.describe({ redactSecrets: true })
          .find(candidate => String(candidate.ns) === ns)
        if (descriptor === undefined) {
          writeJson(res, 200, { ok: false, code: 'internal', message: `settings namespace "${ns}" was disposed after the mutate` })
          return
        }
        writeJson(res, 200, { ok: true, value: toView(descriptor) })
      },
    },

    // ===== gated: 功能路由（跟随总开关，enabled=false 时不注册）=====
  ]
  const gated: WebRoute[] = [
    // ============================================================ GENERATE
    {
      kind: 'exact',
      path: GENERATE_API,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt is required' })
          return
        }
        if (prompt.length > 2000) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'prompt exceeds 2000 characters' })
          return
        }
        const request: GenerateRequest = {
          mode: body.mode === 'edit' ? 'edit' : 'text',
          model: typeof body.model === 'string' ? body.model : 'gpt-image-2',
          prompt,
          size: typeof body.size === 'string' ? body.size : 'auto',
          quality: typeof body.quality === 'string' ? body.quality : 'auto',
          n: typeof body.n === 'number' ? body.n : 1,
          detail: typeof body.detail === 'string' ? body.detail : '',
          ...typeof body.image === 'string' && body.image !== '' ? { image: body.image } : {},
          ...typeof body.refName === 'string' && body.refName !== '' ? { refName: body.refName } : {},
        }

        // Determine whether to use single-provider or multi-provider mode
        const cfg = deps.resolveFull()

        try {
          let result: { images: GeneratedImage[] }

          if (cfg.providers.length > 0 && cfg.active) {
            // Multi-provider mode with fallback
            result = await generateImageWithFallback(
              cfg.providers,
              cfg.active,
              request,
              async (provider) => deps.resolveKeyRef(provider.apiKey),
            )
          } else {
            // Legacy single-provider mode
            const upstream = deps.resolve()
            result = await generateImage(upstream, request)
          }

          try {
            const entries = await history.append({
              id: randomUUID(),
              createdAt: Date.now(),
              mode: request.mode,
              model: request.model,
              prompt: request.prompt,
              size: request.size,
              quality: request.quality,
              detail: request.detail,
              n: request.n,
              images: result.images,
              ...request.refName === undefined ? {} : { refName: request.refName },
            })
            writeJson(res, 200, { ok: true, ...result, history: entries })
          } catch (error) {
            writeJson(res, 200, { ok: true, ...result, historyError: messageOf(error) })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'generate-failed'
          writeJson(res, 200, { ok: false, code, message })
        }
      },
    },

    // ============================================================ UPDATE CHECK
    {
      kind: 'exact',
      path: UPDATE_API.check,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, update: await checkForUpdate() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'update-check-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ UPDATE APPLY
    {
      kind: 'exact',
      path: UPDATE_API.apply,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const version = body !== undefined && typeof body.version === 'string' ? body.version.trim() : ''
        if (version === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'update version is required' })
          return
        }
        try {
          const latest = await checkForUpdate()
          if (!latest.updateAvailable || latest.latestVersion !== version) {
            writeJson(res, 200, { ok: false, code: 'update-not-available', message: `version ${version} is not the latest available release` })
            return
          }
          await installUpdate(version)
          writeJson(res, 200, { ok: true, currentVersion: CURRENT_VERSION, updatedVersion: version, restartRequired: true })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'update-failed', message: messageOf(error) })
        }
      },
    },

    // ============================================================ HISTORY LIST
    {
      kind: 'exact',
      path: HISTORY_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.list() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ HISTORY APPEND
    {
      kind: 'exact',
      path: HISTORY_API.append,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const entry = parseHistoryEntryInput(body)
        if (entry === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'malformed history entry' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.append(entry) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ HISTORY REMOVE
    {
      kind: 'exact',
      path: HISTORY_API.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = body !== undefined && typeof body.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: 'history id is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, entries: await history.remove(id) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ HISTORY CLEAR
    {
      kind: 'exact',
      path: HISTORY_API.clear,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { ok: true, entries: await history.clear() })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'history-failed', message: messageOf(error) })
        }
      },
    },
    // ============================================================ HISTORY IMAGE
    {
      kind: 'prefix',
      path: HISTORY_API.image,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const file = imageFileFrom(req.url, HISTORY_API.image)
        if (file === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        const found = await history.readImage(file)
        if (found === undefined) {
          writeJson(res, 404, { error: 'not found' })
          return
        }
        res.writeHead(200, {
          'content-type': found.mime,
          'content-length': found.data.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(found.data)
      },
    },
  ]

  return options.enabled === false ? always : [...always, ...gated]
}