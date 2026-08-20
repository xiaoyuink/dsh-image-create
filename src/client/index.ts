/**
 * Browser-half entry for the dsh-image-create plugin — runs inside the dsh
 * web GUI.
 *
 * Registers the dsh-image-create locale dictionaries, binds the plugin's own
 * settings scope (its custom HTTP config routes), registers the settings card
 * into the Web UI plugin group slot, and mounts the two DOM surfaces: the
 * sidebar entry row (toggles the panel) and the generation studio in the
 * center column. Failure policy: DOM mounting problems are logged, never
 * thrown — the web shell fails the whole boot when a plugin apply throws,
 * and an external plugin must not take the GUI down.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { bindConversationBridge, SessionBridge } from './conversation-bridge.ts'
import { ImageGenApi } from './api.ts'
import { ImageGenController } from './controller.ts'
import { tt } from './helpers.ts'
import { en, zh, type ImageGenKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { ImageGenSettingsCard } from './SettingsCard.tsx'
import { ImageGenSettingsSection } from './SettingsSection.tsx'
import { injectSettingsVisionCss } from './settings-vision-css.ts'
import { bindImageGenScope, type ImageGenScope } from './settings-scope.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-image-create'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-image-create surface copy. */
    'dsh-image-create': ImageGenKey
  }

  interface SlotMap {
    /**
     * The official plugin-configuration slot the Settings → Plugins →
     * Configurable tab declares and renders. This card registers there as its
     * own standalone card — independent of the dsh-web-ui family group — so
     * this plugin never reads as part of that family. Spelled here with the
     * same shape so this package can register without depending on the
     * sibling UI package.
     */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: ImageGenPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface ImageGenPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'connection', 'sessions']

/**
 * Mount the studio, its sidebar entry, and the settings card.
 * @param ctx - client root context (services: slots, locale, connection).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-create: dictionaries')

  // 主对话框图片附件桥：注入会话服务引用 + 挂载零渲染的会话桥组件，
  // 「添加到对话框」借此直接把图片加入输入框（绕开 dsh-drop-caret 的
  // Files drop 落盘拦截，不修改任何其他插件）。
  bindConversationBridge(ctx.sessions as { scope: (sessionId: string) => unknown })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-image-create-session',
    order: 100,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inject: (sessionId: any) => ({ sessionId }),
  }, SessionBridge))

  // 设置页样式（照抄视觉插件设置页样式表）在客户端入口注入一次。
  injectSettingsVisionCss()

  // The custom HTTP config routes are always accessible (same-origin).
  const scope: ImageGenScope = bindImageGenScope()

  // Re-read the scope whenever the connection resets.
  ctx.effect(() => {
    const disposers = [
      ctx.on('connection/reset', () => { void scope.load() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-image-create: settings scope invalidation')

  // The settings page broadcasts config changes (saves / activations); the
  // panel scope re-reads so the model dropdown stays in sync.
  ctx.effect(() => {
    const handler = (): void => { void scope.load() }
    window.addEventListener('dsh-image-create-config-changed', handler)
    return () => { window.removeEventListener('dsh-image-create-config-changed', handler) }
  }, 'dsh-image-create: config change bridge')

  // Plugin configuration card: registered into the official plugin-configuration
  // slot (Settings → Plugins → Configurable) as a standalone card.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-image-create',
    locale: NS,
    inject: () => ({
      hooks: {
        imageGenSettingsCard: { getSnapshot: () => ({ loading: false, available: true, config: null, dirty: false, saving: false, saveError: null }), subscribe: () => () => {} },
        imageGenKeySet: { getSnapshot: () => false, subscribe: () => () => {} },
      },
      edit: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {},
    }),
  }, ImageGenSettingsCard))

  // Standalone settings page: a Settings-sidebar entry (like the vision
  // plugin) opening the full provider/model manager.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'image-create',
    order: 30,
    label: () => tt('settings.title'),
  }, ImageGenSettingsSection))

  // The sidebar entry and studio mount once the settings scope settles.
  let uiDisposer: (() => void) | undefined
  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    const controller = new ImageGenController()
    const api = new ImageGenApi()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(controller, tt('entry.label'), tt('entry.tooltip')))
      disposers.push(mountPanel(controller, api, scope))
    } catch (error) {
      // DOM failures degrade the studio, never the GUI.
      console.warn('[dsh-image-create] mount failed:', error)
    }
    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      uiDisposer = undefined
    }
  }
  const syncEnabled = (): void => {
    const snapshot = scope.getSnapshot()
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
    else uiDisposer?.()
  }
  scope.subscribe(syncEnabled)
  syncEnabled()
}