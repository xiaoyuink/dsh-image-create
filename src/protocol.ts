/**
 * Wire contract shared by the host and client halves of dsh-image-create: the
 * settings namespace, the route paths, and the generate payload/result shapes.
 * Pure types + constants — safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const IMAGEGEN_SETTINGS_NAMESPACE = 'image-create'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '1.4.0'

/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
export const SETTINGS_API = {
  describe: '/api/dsh-image-create/settings/describe',
  mutate: '/api/dsh-image-create/settings/mutate',
} as const

/** Custom config routes (bypasses settings wire white-list limitation). */
export const CONFIG_API = {
  get: '/api/dsh-image-create/config',
  set: '/api/dsh-image-create/config',
  activate: '/api/dsh-image-create/activate',
  models: '/api/dsh-image-create/models',
} as const

/** The image-generation proxy route. */
export const GENERATE_API = '/api/dsh-image-create/generate'

/**
 * 附件存储 raw 图片路由前缀（与 dsh-image-vision 同款设计）：生成的图片
 * 通过 DSH 附件存储（attachments.saveImage，永久保留）持久化，并以
 * `![图片](/api/dsh-image-create/raw/<attachmentId>?m=..&b=..&w=..&h=..)`
 * 的 markdown 引用嵌入 agent 消息，消息对话框即可渲染图片。
 * 元数据编进 URL（digest/类型/尺寸），进程重启后旧引用依然可读。
 */
export const RAW_API = '/api/dsh-image-create/raw'

/** Host-mediated GitHub Release update routes. */
export const UPDATE_API = {
  check: '/api/dsh-image-create/update/check',
  apply: '/api/dsh-image-create/update/apply',
} as const

/**
 * Same-origin route family for the host-persisted generation history. Images
 * live as files under ~/.dsh/plugin/dsh-image-create/images/ and are served
 * back through the `image` prefix route, so list responses carry metadata only
 * (never base64) and the browser loads thumbnails/previews lazily.
 */
export const HISTORY_API = {
  list: '/api/dsh-image-create/history/list',
  append: '/api/dsh-image-create/history/append',
  remove: '/api/dsh-image-create/history/remove',
  clear: '/api/dsh-image-create/history/clear',
  image: '/api/dsh-image-create/history/image',
  openDir: '/api/dsh-image-create/history/open-dir',
} as const

/** Maximum number of history entries retained host-side (oldest evicted). */
export const HISTORY_MAX = 50

/** Generation modes. */
export type GenerateMode = 'text' | 'edit'

/** A client → host generate request (what the panel collects). */
export interface GenerateRequest {
  /** text-to-image (images/generations) or image-to-image (images/edits). */
  mode: GenerateMode
  /** Upstream model name, e.g. gpt-image-2. */
  model: string
  /** The prompt (up to 2000 chars in the UI). */
  prompt: string
  /** Canvas size: 'auto' or a pixel size like '1024x1024'. */
  size: string
  /** Quality: 'auto' | 'low' | 'medium' | 'high'. */
  quality: string
  /** Number of images, 1-4. */
  n: number
  /**
   * Passthrough detail parameter: '' (omit), 'standard', or 'high'. Some
   * gpt-image-2 gateways expose it; official OpenAI endpoints reject unknown
   * parameters, so the UI defaults to '' (omit).
   */
  detail: string
  /** 可选透传：自定义清晰度 PPI（如 '300'）；网关不支持时引擎自动去掉重试。 */
  ppi?: string
  /** Reference image as a data URL (edit mode only). */
  image?: string
  /** Original reference-image name, retained in the history entry. */
  refName?: string
}

/** One generated image, normalized host-side to base64 so the browser never
 *  has to fetch the upstream (no CORS, no key exposure). */
export interface GeneratedImage {
  /** Raw base64 payload (no data: prefix). */
  b64: string
  /** MIME type of the payload, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** Successful generate outcome. */
export interface GenerateResult {
  images: GeneratedImage[]
  /** Updated host-persisted history, when returned by the generate route. */
  history?: HistoryEntry[]
  /** Persistence failure after images were successfully generated. */
  historyError?: string
}

/** GitHub Release update information shown by the client. */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  publishedAt?: string
}

/** One history image reference as the browser consumes it (a served URL). */
export interface HistoryImageRef {
  /** Same-origin URL: `${HISTORY_API.image}/<file>`. */
  url: string
  /** MIME type, e.g. image/png. */
  mime: string
  /** Upstream revised prompt, when provided. */
  revisedPrompt?: string
}

/** A saved generation as the browser consumes it (metadata + served images). */
export interface HistoryEntry {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: HistoryImageRef[]
  /** Reference-image filename (edit mode), kept for display only. */
  refName?: string
}

/** A history entry the client submits for persistence (images still carry base64). */
export interface HistoryEntryInput {
  id: string
  createdAt: number
  mode: GenerateMode
  model: string
  prompt: string
  size: string
  quality: string
  detail: string
  n: number
  images: GeneratedImage[]
  refName?: string
}

// ===== Multi-provider types (new in v1.1.0) =====

/** One model under a provider. */
export interface ProviderModel {
  id: string
}

/** One image-generation provider endpoint. */
export interface Provider {
  id: string
  name: string
  apiBaseUrl: string
  apiKey: string
  models: ProviderModel[]
}

/** The full plugin configuration (new multi-provider shape). */
export interface ImageGenFullConfig {
  enabled: boolean
  announceToAgent: boolean
  providers: Provider[]
  /** "providerId:modelId" — which provider+model is active. */
  active: string
}

/** MIME type map for file extensions. */
export const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** Common image-generation providers and their default models. */
export const PRESET_PROVIDER_CATALOG: Array<{
  match: string
  name: string
  models: string[]
}> = [
  // match 是 OpenAI 兼容端点的主机+路径（不含协议），baseUrl = https://<match>。
  { match: 'api.openai.com/v1', name: 'OpenAI', models: ['gpt-image-2', 'gpt-image-1', 'dall-e-3', 'dall-e-2'] },
  { match: 'api.siliconflow.cn/v1', name: 'SiliconFlow', models: ['black-forest-labs/FLUX.1-dev', 'stabilityai/stable-diffusion-3.5-large', 'Pro/black-forest-labs/FLUX.1.1-pro', 'deepseek-ai/Janus-Pro-7B'] },
  { match: 'dashscope.aliyuncs.com/compatible-mode/v1', name: '阿里云 DashScope', models: ['qwen-image-plus', 'qwen-image-generate-plus', 'qwen-image-generate'] },
  { match: 'open.bigmodel.cn/api/paas/v4', name: '智谱 AI', models: ['glm-4v-plus', 'cogview-4', 'cogview-3-plus'] },
  { match: 'api.hunyuan.cloud.tencent.com/v1', name: '腾讯混元', models: ['hunyuan-image', 'hunyuan-standard'] },
  { match: 'ark.cn-beijing.volces.com/api/v3', name: '火山引擎', models: ['doubao-seed-1-6-250615', 'doubao-1.5-image-generate-pro-32k-250115'] },
  { match: 'api.minimaxi.com/v1', name: 'MiniMax', models: ['MiniMax-Image-01', 'MiniMax-VL-01'] },
  { match: 'api.stepfun.com/v1', name: '阶跃星辰', models: ['step-1x-medium', 'step-2-16k'] },
  { match: 'api.lingyiwanwu.com/v1', name: '零一万物', models: ['yi-vision-v3', 'yi-large'] },
  { match: 'openrouter.ai/api/v1', name: 'OpenRouter', models: ['openai/gpt-image-2', 'black-forest-labs/flux-1.1-pro', 'stabilityai/stable-diffusion-3.5-large'] },
]