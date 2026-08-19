/**
 * Browser-side settings scope for the dsh-image-create namespace, served by
 * the plugin's own custom HTTP config routes (/api/dsh-image-create/config).
 * Uses the same pattern as dsh-image-vision: custom routes bypass the
 * settings wire white-list limitation.
 *
 * Minimal implementation without external snapshot-store dependency to
 * avoid build issues with the DSH client runtime module format.
 */

import { CONFIG_API } from '../protocol.ts'

/** The fields this plugin's settings card edits. */
export interface ImageGenConfig {
  enabled?: boolean
  announceToAgent?: boolean
  apiUrl?: string
  apiKey?: string
  /** 图片实际保存目录（host 在 GET /config 时返回）。 */
  saveDir?: string
  providers?: Array<{
    id: string
    name: string
    apiBaseUrl: string
    apiKey: string
    models: Array<{ id: string }>
  }>
  active?: string
}

/** Config response from the host. */
interface ConfigResponse {
  ok: boolean
  config?: ImageGenConfig & { providers?: Array<Record<string, unknown>> }
  error?: string
  code?: string
}

/** Models response from the host. */
interface ModelsResponse {
  ok: boolean
  models?: Array<{ id: string }>
  source?: string
  warning?: string
  error?: string
}

/** Activate response from the host. */
interface ActivateResponse {
  ok: boolean
  active?: string
  error?: string
}

/** Minimal observable snapshot source. */
interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Minimal snapshot store implementation. */
class SimpleSnapshotStore<T> implements ObservableSnapshot<T> {
  private state: T
  private listeners = new Set<() => void>()

  constructor(init: T) {
    this.state = init
  }

  getSnapshot(): T {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  update(mutator: (draft: T) => void): void {
    const draft = { ...this.state }
    mutator(draft)
    this.state = draft
    this.notify()
  }

  set(next: T): void {
    this.state = next
    this.notify()
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}

/** Settings scope status. */
export type SettingsScopeStatus = 'loading' | 'ready' | 'unavailable'

/** Settings scope snapshot shape. */
export interface SettingsScopeSnapshot<T> {
  status: SettingsScopeStatus
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host'
}

/** Settings scope interface. */
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(fn: () => void): () => void
  load(): Promise<void>
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
  dispose(): Promise<void>
}

/**
 * Fetch-based settings scope for the dsh-image-create namespace.
 * Reads/writes the plugin's configuration through custom HTTP routes.
 */
class FetchSettingsScope implements SettingsScope<ImageGenConfig> {
  private readonly store: SimpleSnapshotStore<SettingsScopeSnapshot<ImageGenConfig>>
  private keySet = false
  private readonly keyListeners = new Set<() => void>()
  private disposed = false

  constructor() {
    this.store = new SimpleSnapshotStore<SettingsScopeSnapshot<ImageGenConfig>>({
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: true,
      mode: 'host',
    })
  }

  getSnapshot(): SettingsScopeSnapshot<ImageGenConfig> {
    return this.store.getSnapshot()
  }

  /** Whether the API key is set (from the provider's apiKey field). */
  getKeySetSnapshot(): boolean {
    return this.keySet
  }

  subscribeKeySet(listener: () => void): () => void {
    this.keyListeners.add(listener)
    return () => { this.keyListeners.delete(listener) }
  }

  subscribe(fn: () => void): () => void {
    return this.store.subscribe(fn)
  }

  /** Load the config from the host. */
  async load(): Promise<void> {
    try {
      const response = await fetch(CONFIG_API.get)
      const json: ConfigResponse = await response.json()
      if (json.ok && json.config) {
        const cfg = json.config
        this.keySet = cfg.providers?.some(p => {
          const key = String((p as Record<string, unknown>).apiKey ?? '')
          return key !== '' && key !== '********'
        }) ?? false
        this.store.update(draft => {
          draft.status = 'ready'
          draft.value = cfg as ImageGenConfig
          draft.writable = true
        })
      } else {
        this.store.update(draft => { draft.status = 'unavailable' })
      }
    } catch {
      this.store.update(draft => { draft.status = 'unavailable' })
    }
    this.notifyKey()
  }

  set(field: string, value: unknown): Promise<void> {
    return this.write({ [field]: value })
  }

  unset(field: string): Promise<void> {
    return this.write({ [field]: undefined })
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  private async write(partial: Record<string, unknown>): Promise<void> {
    try {
      const response = await fetch(CONFIG_API.set, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial),
      })
      const json: ConfigResponse = await response.json()
      if (json.ok && json.config) {
        const cfg = json.config
        this.keySet = cfg.providers?.some(p => {
          const key = String((p as Record<string, unknown>).apiKey ?? '')
          return key !== '' && key !== '********'
        }) ?? false
        this.store.update(draft => {
          draft.status = 'ready'
          draft.value = cfg as ImageGenConfig
        })
      }
    } catch {
      // Re-read on failure
      await this.load()
    }
    this.notifyKey()
  }

  private notifyKey(): void {
    for (const fn of [...this.keyListeners]) fn()
  }
}

/** The bound scope plus the secret-set flag, as the card and panel consume it. */
export interface ImageGenScope extends SettingsScope<ImageGenConfig> {
  /** Queue a bridge refresh. */
  load(): Promise<void>
  getKeySetSnapshot(): boolean
  subscribeKeySet(listener: () => void): () => void
  /** Discover models for a given base URL. */
  discoverModels(baseUrl: string, apiKey: string): Promise<ModelsResponse>
  /** Activate a specific provider+model. */
  activate(providerId: string, modelId: string): Promise<ActivateResponse>
}

/**
 * Bind the dsh-image-create settings scope over the custom HTTP config routes.
 * @returns the scope.
 */
export function bindImageGenScope(): ImageGenScope {
  const controller = new FetchSettingsScope()

  const scope: ImageGenScope = {
    getSnapshot: () => controller.getSnapshot(),
    subscribe: (fn) => controller.subscribe(fn),
    load: () => controller.load(),
    set: (field, value) => controller.set(field, value),
    unset: (field) => controller.unset(field),
    dispose: () => controller.dispose(),
    getKeySetSnapshot: () => controller.getKeySetSnapshot(),
    subscribeKeySet: (fn) => controller.subscribeKeySet(fn),

    discoverModels: async (baseUrl: string, apiKey: string): Promise<ModelsResponse> => {
      try {
        const response = await fetch(CONFIG_API.models, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseUrl, apiKey }),
        })
        return await response.json()
      } catch {
        return { ok: false, error: '无法连接到服务器' }
      }
    },

    activate: async (providerId: string, modelId: string): Promise<ActivateResponse> => {
      try {
        const response = await fetch(CONFIG_API.activate, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerId, modelId }),
        })
        const json: ActivateResponse = await response.json()
        if (json.ok) {
          await controller.load()
        }
        return json
      } catch {
        return { ok: false, error: '无法连接到服务器' }
      }
    },
  }

  void controller.load()
  return scope
}