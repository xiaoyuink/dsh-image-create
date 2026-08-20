/**
 * dsh-image-create — host half. Mounts the plugin's settings section, the
 * /api/dsh-image-create route family (config routes + generate proxy +
 * history), a `generate_image` tool for agents, and a system-prompt
 * announcement.
 * The browser half (./client) renders the sidebar entry and the split-pane
 * generation studio.
 *
 * v1.1.0: Multi-provider support, API key security (cred:REF), model discovery,
 * agent tool registration, and automatic fallback across providers.
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
// Type-only: pulls the webServer Context merge (route registration).
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the systemPrompt Context merge (announcement section).
import type {} from '@deepseek-ai/dsh-system-prompt'
import { IMAGEGEN_SETTINGS_NAMESPACE, PRESET_PROVIDER_CATALOG, type Provider } from './protocol.ts'
import { appendHistory } from './history-store.ts'
import { makeRoutes, type ImageGenRoutesDeps, type SettingsSeam } from './routes.ts'
import { generateImageWithFallback, normalizeConfig, resolveProviderKey } from './engine.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-image-create'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt', 'tools']

// Internals re-exported for smoke tests and host-side debugging; the plugin
// contract only requires name / inject / Config / apply.
export { makeRoutes } from './routes.ts'
export { generateImage, generateImageWithFallback, ImageGenError } from './engine.ts'
export { checkForUpdate, clearUpdateCache, compareVersions, CURRENT_VERSION, installUpdate, profileFromProcess } from './updater.ts'

/** The branded settings namespace of this plugin (the card edits it). */
export const ImageGenSettingsNamespace = settingsNamespace(IMAGEGEN_SETTINGS_NAMESPACE)

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the plugin (routes, prompt section). */
  enabled?: boolean
  /** Announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Base URL of the OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  apiUrl?: string
  /** Bearer API key (stored as a secret field on the settings seam). */
  apiKey?: string
  /** Multi-provider configuration (v1.1.0). */
  providers?: Provider[]
  /** Active provider:model selection. */
  active?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  apiUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  providers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    apiBaseUrl: z.string(),
    apiKey: z.string().default(''),
    models: z.array(z.object({
      id: z.string(),
    })).default([]),
  })).default([]),
  active: z.string().default(''),
})

/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const IMAGEGEN_GUIDANCE = '本机已安装 dsh-image-create 插件（DSH 生图插件）：侧边栏「生图插件」入口。Agent 可通过 generate_image 工具调用生图。能力：对接 OpenAI 兼容图像生成 API，支持文生图（/images/generations）与图生图（/images/edits，上传参考图）；支持多供应商配置与自动降级；API 地址与密钥在 GUI「设置 → 插件 → 可配置」中配置，密钥以 cred:REF 引用存储于凭据服务；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；参考图会发送至所配置的 API 服务。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图」时即指本插件，请据此协作。'

/** Effective config (schema defaults applied). */
interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  apiUrl: string
  apiKey: string
  providers: Provider[]
  active: string
}

/** Resolve a key reference: cred:REF → credentials service, env:VAR → env, plain → as-is. */
async function resolveKeyRef(ctx: Context, raw: string): Promise<string> {
  const s = String(raw ?? '')
  if (s.startsWith('cred:')) {
    const ref = s.slice(5).trim()
    if (ref === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return ''
    const credentials = (ctx as { get?: (name: string) => unknown })?.get?.('credentials')
    if (credentials !== undefined && typeof credentials === 'object') {
      const credObj = credentials as { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
      if (typeof credObj.resolve === 'function') {
        const hit = await credObj.resolve(ref)
        return hit?.value ?? ''
      }
    }
    return String(process.env[ref] ?? '')
  }
  if (s.startsWith('env:')) {
    const name = s.slice(4).trim()
    return name === '' ? '' : String(process.env[name] ?? '')
  }
  return s
}

/**
 * Mount the settings section, routes, tool, and announcement.
 * @param ctx - host plugin context carrying webServer/systemPrompt/tools.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  // The live source the surfaces read: the settings section once the settings
  // service is attached, the composition entry otherwise.
  let current: () => Config = () => config ?? {}
  const resolve = (): EffectiveConfig => {
    const value = current()
    return {
      enabled: value.enabled ?? DEFAULT_ENABLED,
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      apiUrl: value.apiUrl ?? '',
      apiKey: value.apiKey ?? '',
      providers: Array.isArray(value.providers) ? value.providers : [],
      active: value.active ?? '',
    }
  }

  // 总开关驱动的生命周期：关闭时注销 generate_image 工具与功能路由（系统提示同），
  // 打开时重新注册。配置类路由始终保留（设置页依赖它们来重新打开总开关）。
  let disposeTool: (() => void) | undefined
  let syncTool: (() => void) | undefined
  let routeDisposers: Array<() => void> = []
  let syncRoutes: (() => void) | undefined

  // The route family mounts once, gated on the settings seam.
  ctx.inject(['settings'], (sctx) => {
    const seam = sctx.get('settings') as unknown as SettingsSeam
    sctx.effect(
      () => {
        const deps: ImageGenRoutesDeps = {
          settings: seam,
          resolve: () => {
            const value = resolve()
            return { apiUrl: value.apiUrl, apiKey: value.apiKey }
          },
          resolveFull: () => {
            const value = resolve()
            return normalizeConfig({
              enabled: value.enabled,
              announceToAgent: value.announceToAgent,
              apiUrl: value.apiUrl,
              apiKey: value.apiKey,
              providers: value.providers,
              active: value.active,
            } as unknown as Record<string, unknown>)
          },
          resolveKeyRef: async (raw: string) => resolveKeyRef(ctx, raw),
          // 明文 API Key → DSH 凭据服务（settings 只留 cred:REF，与视觉插件一致）。
          storeCredential: async (ref: string, key: string) => {
            const credentials = (ctx as { get?: (name: string) => unknown })?.get?.('credentials')
            const set = credentials !== undefined && typeof credentials === 'object'
              ? (credentials as { set?: (ref: string, key: string) => Promise<void> }).set
              : undefined
            if (typeof set !== 'function') {
              throw new Error('凭据服务不可用：已拒绝保存明文 API Key，请改用 cred:REF 或 env:VAR 引用')
            }
            await (credentials as { set: (ref: string, key: string) => Promise<void> }).set(ref, key)
          },
          // 保存完整配置（含总开关）：saveProviders 在写入 settings 时一并持久化
          // enabled / announceToAgent，否则总开关永远存不进去、点击无反应。
          saveProviders: async (
            providers: Provider[],
            active: string,
            extra?: { enabled?: boolean; announceToAgent?: boolean },
          ) => {
            const settings = ctx.get('settings')
            if (settings === undefined) return
            const ns = ImageGenSettingsNamespace
            await (settings as { update: (ns: unknown, value: Record<string, unknown>) => Promise<void> }).update(ns, {
              providers,
              active,
              ...(extra?.enabled !== undefined ? { enabled: extra.enabled } : {}),
              ...(extra?.announceToAgent !== undefined ? { announceToAgent: extra.announceToAgent } : {}),
              apiUrl: providers[0]?.apiBaseUrl ?? '',
              apiKey: providers[0]?.apiKey ?? '',
            })
          },
        }
        // 重挂全部路由：enabled=false 时 makeRoutes 不再返回生成/历史/更新路由。
        const syncRoutesNow = (): void => {
          for (const dispose of routeDisposers) dispose()
          routeDisposers = []
          const routes = makeRoutes(deps, { enabled: resolve().enabled })
          routeDisposers = routes.map(route => ctx.webServer.register(route))
        }
        syncRoutes = syncRoutesNow
        syncRoutesNow()
        return () => {
          syncRoutes = undefined
          for (const dispose of routeDisposers) dispose()
          routeDisposers = []
        }
      },
      'dsh-image-create: routes',
    )
  })

  // Register the generate_image tool for agents.
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => {
      // 工具生命周期跟随总开关：关闭时注销，打开时注册。
      const syncToolNow = (): void => {
        if (disposeTool !== undefined) {
          disposeTool()
          disposeTool = undefined
        }
        if (!resolve().enabled) return
        // 正确的注册方式：defineTool(def) 生成定义，tools.register 注册并返回注销函数。
        disposeTool = tctx.tools.register(defineTool({
          name: 'generate_image',
          description: 'Generate images using AI (text-to-image or image-to-image). Supports multiple providers with automatic fallback.',
          parameters: {
            prompt: {
              type: 'string',
              required: true,
              description: 'A detailed description of the image to generate. Be specific about style, composition, colors, lighting, and subject.',
            },
            size: {
              type: 'string',
              default: 'auto',
              description: 'Image size: "auto", "1024x1024", "1792x1024", "1024x1792", "1536x1024", or "1024x1536".',
            },
            quality: {
              type: 'string',
              default: 'auto',
              description: 'Image quality: "auto", "low", "medium", or "high".',
            },
            n: {
              type: 'number',
              default: 1,
              description: 'Number of images to generate (1-4).',
            },
            detail: {
              type: 'string',
              default: '',
              description: 'Detail level: "" (auto), "standard", or "high" (some gateways support this).',
            },
            image: {
              type: 'string',
              description: 'Optional reference image as data URL (for image-to-image editing).',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                images: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      b64: { type: 'string' },
                      mime: { type: 'string' },
                      revisedPrompt: { type: 'string' },
                    },
                  },
                },
                error: { type: 'string' },
                historyError: { type: 'string' },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args) {
            const effective = resolve()
            const cfg = normalizeConfig({
              enabled: effective.enabled,
              apiUrl: effective.apiUrl,
              apiKey: effective.apiKey,
              providers: effective.providers,
              active: effective.active,
            } as unknown as Record<string, unknown>)

            if (cfg.providers.length === 0) {
              return { error: '未配置图像生成供应商：请在设置中添加 API 供应商和模型。' }
            }

            const mode = args.image ? 'edit' : 'text'
            const model = parseActiveModel(cfg.active, cfg.providers)
            const prompt = String(args.prompt ?? '')
            const size = String(args.size ?? 'auto')
            const quality = String(args.quality ?? 'auto')
            const n = typeof args.n === 'number' ? Math.min(4, Math.max(1, Math.round(args.n))) : 1
            const detail = String(args.detail ?? '')

            try {
              const result = await generateImageWithFallback(
                cfg.providers,
                cfg.active,
                {
                  mode,
                  model,
                  prompt,
                  size,
                  quality,
                  n,
                  detail,
                  ...args.image ? { image: String(args.image) } : {},
                },
                async (provider) => resolveKeyRef(ctx, provider.apiKey),
              )
              const images = result.images.map(img => ({
                b64: img.b64,
                mime: img.mime,
                // 仅在存在时带 revisedPrompt：DSH 对工具输出做无损 JSON 校验，
                // undefined 字段会被拒绝（"value is not lossless JSON"）。
                ...img.revisedPrompt === undefined ? {} : { revisedPrompt: img.revisedPrompt },
              }))
              // 对话框（Agent）生成的图片同样写入面板历史记录，失败不阻断生成。
              try {
                await appendHistory({
                  id: randomUUID(),
                  createdAt: Date.now(),
                  mode,
                  model,
                  prompt,
                  size,
                  quality,
                  detail,
                  n,
                  images,
                })
              } catch (error) {
                return { images, historyError: error instanceof Error ? error.message : String(error) }
              }
              return { images }
            } catch (error) {
              return { error: error instanceof Error ? error.message : String(error) }
            }
          },
        }))
      }
      syncTool = syncToolNow
      syncToolNow()
      return () => {
        syncTool = undefined
        if (disposeTool !== undefined) {
          disposeTool()
          disposeTool = undefined
        }
      }
    }, 'dsh-image-create: tool')
  })

  // System-prompt announcement + master-switch resync (tools / routes / prompt).
  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    // 总开关驱动的生命周期：关闭时注销工具与功能路由，打开时重新挂载。
    syncTool?.()
    syncRoutes?.()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-image-create',
      order: SECTION_ORDER,
      text: IMAGEGEN_GUIDANCE,
    })
  }

  installSettingsSection(ctx, ImageGenSettingsNamespace, Config, config ?? {}, {
    setSource: (source) => {
      current = source
      sync()
    },
    onChange: sync,
  })

  // Initial registration from the composition entry.
  sync()
}

/** Parse the active model id from "providerId:modelId", falling back to the
 *  first configured model — never a hard-coded id. */
function parseActiveModel(active: string, providers: Provider[]): string {
  const sep = active.indexOf(':')
  if (sep > 0) {
    const pid = active.slice(0, sep)
    const mid = active.slice(sep + 1)
    if (pid !== '' && mid !== '') {
      const provider = providers.find(p => p.id === pid)
      const model = provider?.models.find(m => m.id === mid)
      if (model !== undefined) return model.id
    }
  }
  return providers[0]?.models[0]?.id ?? 'gpt-image-2'
}