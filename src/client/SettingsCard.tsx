/**
 * The dsh-image-create settings card: multi-provider management with model
 * discovery, active model selection, and plugin switches. Uses the plugin's
 * own HTTP config routes (GET/POST /api/dsh-image-create/config).
 *
 * v1.1.0: Redesigned to support multiple providers, each with multiple
 * models, API key security via cred:REF, and model discovery.
 */

import { useState, useEffect, useCallback } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PLUGIN_VERSION, PRESET_PROVIDER_CATALOG } from '../protocol.ts'
import css from './settings-card.module.css'

// ===== Types =====

interface ProviderModel {
  id: string
}

interface Provider {
  id: string
  name: string
  apiBaseUrl: string
  apiKey: string
  models: ProviderModel[]
}

interface ImageGenConfig {
  enabled?: boolean
  announceToAgent?: boolean
  apiUrl?: string
  apiKey?: string
  providers?: Provider[]
  active?: string
}

/** Card state as rendered by the component. */
interface CardState {
  /** Config loading state. */
  loading: boolean
  /** Config is available. */
  available: boolean
  /** The full config. */
  config: ImageGenConfig | null
  /** Whether the card has unsaved changes. */
  dirty: boolean
  /** Whether a save is in progress. */
  saving: boolean
  /** Error message from last save. */
  saveError: string | null
}

/** A provider being edited in the card. */
interface EditingProvider extends Provider {
  _key: string // stable key for React list
  _isNew: boolean
  _discovering: boolean
  _discoveryError: string | null
}

const MASKED_KEY = '********'

// ===== Helpers =====

function generateId(): string {
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** Check if a string is a reference (cred: or env:). */
function isKeyRef(key: string): boolean {
  return /^(cred|env):/.test(key)
}

/** Get display name for a key reference. */
function keyDisplayName(key: string): string {
  if (key.startsWith('cred:')) return `🔑 ${key}`
  if (key.startsWith('env:')) return `🌐 ${key}`
  if (key) return '已设置'
  return '未设置'
}

// ===== Component =====

/** Props the renderer binds for this card. */
export type ImageGenSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'dsh-image-create'>
  & {
    /** Injectable actions (the slot entry provides them). */
    edit?: (field: string, text: string) => void
    resetField?: (field: string) => void
    save?: () => void
    discard?: () => void
    /** Start expanded (the standalone settings page wants the form open). */
    startOpen?: boolean
  }

/**
 * Render the settings card with provider management.
 */
export function ImageGenSettingsCard(props: ImageGenSettingsCardProps) {
  const { t, startOpen } = props
  const [open, setOpen] = useState(startOpen ?? false)
  const [config, setConfig] = useState<ImageGenConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editingProviders, setEditingProviders] = useState<EditingProvider[]>([])
  const [editingEnabled, setEditingEnabled] = useState(true)
  const [editingAnnounce, setEditingAnnounce] = useState(true)
  const [editDirty, setEditDirty] = useState(false)

  // Load config
  const loadConfig = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/dsh-image-create/config')
      const json = await resp.json()
      if (json.ok && json.config) {
        setConfig(json.config)
        const cfg = json.config as ImageGenConfig
        setEditingEnabled(cfg.enabled ?? true)
        setEditingAnnounce(cfg.announceToAgent ?? true)
        setEditingProviders((cfg.providers ?? []).map(p => ({
          ...p,
          _key: generateId(),
          _isNew: false,
          _discovering: false,
          _discoveryError: null,
        })))
      }
    } catch {
      // Config unavailable
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadConfig() }, [loadConfig])

  const markDirty = useCallback(() => { setEditDirty(true); setSaveError(null) }, [])

  // Save config
  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const resp = await fetch('/api/dsh-image-create/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: editingEnabled,
          announceToAgent: editingAnnounce,
          providers: editingProviders.map(p => ({
            id: p.id,
            name: p.name,
            apiBaseUrl: p.apiBaseUrl,
            apiKey: p.apiKey,
            models: p.models,
          })),
          active: config?.active ?? '',
        }),
      })
      const json = await resp.json()
      if (json.ok && json.config) {
        setConfig(json.config)
        setEditDirty(false)
        // Reload to get fresh state
        await loadConfig()
// 通知主界面生图面板重新读取配置。
          try { window.dispatchEvent(new CustomEvent('dsh-image-create-config-changed')) } catch { /* ignore */ }
      } else {
        setSaveError(json.message ?? '保存失败')
      }
    } catch {
      setSaveError('无法连接到服务器')
    }
    setSaving(false)
  }, [editingEnabled, editingAnnounce, editingProviders, config, loadConfig])

  // Provider CRUD
  const addProvider = useCallback(() => {
    const newProvider: EditingProvider = {
      id: generateId(),
      name: '',
      apiBaseUrl: '',
      apiKey: '',
      models: [],
      _key: generateId(),
      _isNew: true,
      _discovering: false,
      _discoveryError: null,
    }
    setEditingProviders(prev => [...prev, newProvider])
    markDirty()
  }, [markDirty])

  const removeProvider = useCallback((key: string) => {
    setEditingProviders(prev => prev.filter(p => p._key !== key))
    markDirty()
  }, [markDirty])

  const updateProvider = useCallback((key: string, update: Partial<EditingProvider>) => {
    setEditingProviders(prev => prev.map(p => p._key === key ? { ...p, ...update } : p))
    markDirty()
  }, [markDirty])

  // Model management
  const addModel = useCallback((providerKey: string) => {
    setEditingProviders(prev => prev.map(p =>
      p._key === providerKey
        ? { ...p, models: [...p.models, { id: '' }] }
        : p,
    ))
    markDirty()
  }, [markDirty])

  const removeModel = useCallback((providerKey: string, modelIndex: number) => {
    setEditingProviders(prev => prev.map(p =>
      p._key === providerKey
        ? { ...p, models: p.models.filter((_, i) => i !== modelIndex) }
        : p,
    ))
    markDirty()
  }, [markDirty])

  const updateModel = useCallback((providerKey: string, modelIndex: number, id: string) => {
    setEditingProviders(prev => prev.map(p =>
      p._key === providerKey
        ? { ...p, models: p.models.map((m, i) => i === modelIndex ? { id } : m) }
        : p,
    ))
    markDirty()
  }, [markDirty])

  // Model discovery
  const discoverModels = useCallback(async (providerKey: string) => {
    const provider = editingProviders.find(p => p._key === providerKey)
    if (!provider || !provider.apiBaseUrl) return

    setEditingProviders(prev => prev.map(p =>
      p._key === providerKey ? { ...p, _discovering: true, _discoveryError: null } : p,
    ))

    try {
      const resp = await fetch('/api/dsh-image-create/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: provider.apiBaseUrl,
          apiKey: provider.apiKey || '',
        }),
      })
      const json = await resp.json()
      if (json.ok && json.models) {
        setEditingProviders(prev => prev.map(p =>
          p._key === providerKey
            ? { ...p, models: json.models.map((m: { id: string }) => ({ id: m.id })), _discovering: false }
            : p,
        ))
        markDirty()
      } else {
        setEditingProviders(prev => prev.map(p =>
          p._key === providerKey
            ? { ...p, _discovering: false, _discoveryError: json.warning ?? json.message ?? '无法获取模型列表' }
            : p,
        ))
      }
    } catch {
      setEditingProviders(prev => prev.map(p =>
        p._key === providerKey
          ? { ...p, _discovering: false, _discoveryError: '无法连接到服务器' }
          : p,
      ))
    }
  }, [editingProviders, markDirty])

  // Activate a model
  const handleActivate = useCallback(async (providerId: string, modelId: string) => {
    try {
      const resp = await fetch('/api/dsh-image-create/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId, modelId }),
      })
      const json = await resp.json()
      if (json.ok) {
        await loadConfig()
// 通知主界面生图面板重新读取配置。
          try { window.dispatchEvent(new CustomEvent('dsh-image-create-config-changed')) } catch { /* ignore */ }
      }
    } catch {
      // ignore
    }
  }, [loadConfig])

  // ===== Render =====
  const title = t('settings.title')

  if (loading) {
    return (
      <li className={css.card}>
        <button
          type="button"
          className={css.header}
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <span className={css.headText}>
            <span className={css.name}>{title}</span>
            <span className={css.description}>{t('settings.description')}</span>
          </span>
          <span className={open ? css.chevronOpen : css.chevron}>▾</span>
        </button>
      </li>
    )
  }

  return (
    <li className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {editDirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron}>▾</span>
      </button>
      {open && (
        <div className={css.body}>
          {/* Version */}
          <div className={css.versionRow}>
            <span className={css.versionLabel}>{t('settings.currentVersion')}</span>
            <code className={css.versionValue}>v{PLUGIN_VERSION}</code>
          </div>

          {/* Master switches */}
          <div className={css.field}>
            <div className={css.head}>
              <label className={css.label} htmlFor="dsh-image-create-enabled">{t('settings.enabled')}</label>
            </div>
            <select
              id="dsh-image-create-enabled"
              className={css.select}
              value={String(editingEnabled)}
              onChange={(e) => { setEditingEnabled(e.target.value === 'true'); markDirty() }}
            >
              <option value="true">{t('settings.on')}</option>
              <option value="false">{t('settings.off')}</option>
            </select>
            <p className={css.hint}>{t('settings.enabledHint')}</p>
          </div>

          <div className={css.field}>
            <div className={css.head}>
              <label className={css.label} htmlFor="dsh-image-create-announce">{t('settings.announceToAgent')}</label>
            </div>
            <select
              id="dsh-image-create-announce"
              className={css.select}
              value={String(editingAnnounce)}
              onChange={(e) => { setEditingAnnounce(e.target.value === 'true'); markDirty() }}
            >
              <option value="true">{t('settings.on')}</option>
              <option value="false">{t('settings.off')}</option>
            </select>
            <p className={css.hint}>{t('settings.announceToAgentHint')}</p>
          </div>

          {/* Provider list */}
          <div className={css.sectionTitle}>{t('settings.providers')}</div>

          {editingProviders.length === 0 && (
            <p className={css.hint}>{t('settings.noProviders')}</p>
          )}

          {editingProviders.map((provider, idx) => {
            const isActive = config?.active === `${provider.id}:${provider.models[0]?.id}`
            return (
              <div key={provider._key} className={css.providerCard}>
                {/* Provider header */}
                <div className={css.providerHeader}>
                  <span className={css.providerName}>
                    {provider.name || `供应商 ${idx + 1}`}
                  </span>
                  <span className={css.keyStatus}>
                    {isActive
                      ? <span className={css.activeBadge}>{t('settings.active')}</span>
                      : null}
                    {provider.apiKey && !isKeyRef(provider.apiKey)
                      ? <span className={css.keyDot} title={keyDisplayName(provider.apiKey)}/>
                      : null}
                  </span>
                  <button
                    type="button"
                    className={css.removeButton}
                    onClick={() => removeProvider(provider._key)}
                    title={t('settings.removeProvider')}
                  >
                    ✕
                  </button>
                </div>

                {/* Provider fields */}
                <div className={css.providerField}>
                  <label className={css.fieldLabel}>{t('settings.providerName')}</label>
                  <input
                    className={css.input}
                    type="text"
                    value={provider.name}
                    placeholder="e.g. OpenAI"
                    onChange={(e) => updateProvider(provider._key, { name: e.target.value })}
                  />
                </div>

                <div className={css.providerField}>
                  <label className={css.fieldLabel}>{t('settings.apiUrl')}</label>
                  <input
                    className={css.input}
                    type="text"
                    value={provider.apiBaseUrl}
                    placeholder="https://api.openai.com/v1"
                    onChange={(e) => updateProvider(provider._key, { apiBaseUrl: e.target.value })}
                  />
                </div>

                <div className={css.providerField}>
                  <label className={css.fieldLabel}>{t('settings.apiKey')}</label>
                  <div className={css.apiKeyRow}>
                    <input
                      className={css.input}
                      type="password"
                      value={provider.apiKey === MASKED_KEY ? '' : provider.apiKey}
                      placeholder={provider.apiKey === MASKED_KEY ? '••••••••' : 'sk-... or cred:REF or env:VAR'}
                      onChange={(e) => updateProvider(provider._key, { apiKey: e.target.value })}
                    />
                    {provider.apiKey !== '' && provider.apiKey !== MASKED_KEY && (
                      <button
                        type="button"
                        className={css.clearKeyButton}
                        onClick={() => updateProvider(provider._key, { apiKey: '' })}
                        title={t('settings.apiKeyClear')}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <p className={css.hint}>
                    {provider.apiKey === MASKED_KEY
                      ? t('settings.apiKeySet')
                      : provider.apiKey.startsWith('cred:')
                        ? `🔑 ${t('settings.keyRef')}: ${provider.apiKey}`
                        : provider.apiKey.startsWith('env:')
                          ? `🌐 ${t('settings.keyEnv')}: ${provider.apiKey}`
                          : t('settings.apiKeyHint')}
                  </p>
                </div>

                {/* Model discovery */}
                <div className={css.providerField}>
                  <div className={css.modelListHeader}>
                    <label className={css.fieldLabel}>{t('settings.models')}</label>
                    <button
                      type="button"
                      className={css.discoverButton}
                      onClick={() => discoverModels(provider._key)}
                      disabled={provider._discovering || !provider.apiBaseUrl}
                    >
                      {provider._discovering ? '…' : t('settings.discover')}
                    </button>
                  </div>

                  {provider._discoveryError && (
                    <p className={css.warning}>{provider._discoveryError}</p>
                  )}

                  {provider.models.map((model, midx) => (
                    <div key={midx} className={css.modelRow}>
                      <input
                        className={css.modelInput}
                        type="text"
                        value={model.id}
                        placeholder="gpt-image-2"
                        onChange={(e) => updateModel(provider._key, midx, e.target.value)}
                      />
                      {/* Active indicator */}
                      {config?.active === `${provider.id}:${model.id}`
                        ? <span className={css.activeModelBadge}>{t('settings.inUse')}</span>
                        : provider.models.length > 0 && (
                          <button
                            type="button"
                            className={css.useButton}
                            onClick={() => handleActivate(provider.id, model.id)}
                            title={t('settings.useModel')}
                          >
                            {t('settings.use')}
                          </button>
                        )}
                      <button
                        type="button"
                        className={css.removeModelButton}
                        onClick={() => removeModel(provider._key, midx)}
                        title={t('settings.removeModel')}
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  <button
                    type="button"
                    className={css.addModelButton}
                    onClick={() => addModel(provider._key)}
                  >
                    + {t('settings.addModel')}
                  </button>
                </div>
              </div>
            )
          })}

          {/* Add provider button */}
          <button
            type="button"
            className={css.addProviderButton}
            onClick={addProvider}
          >
            + {t('settings.addProvider')}
          </button>

          {/* Preset providers quick-add */}
          <details className={css.presetsSection}>
            <summary className={css.presetsSummary}>{t('settings.quickAdd')}</summary>
            <div className={css.presetsList}>
              {PRESET_PROVIDER_CATALOG.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={css.presetButton}
                  onClick={() => {
                    const exists = editingProviders.some(p =>
                      p.apiBaseUrl.toLowerCase().includes(preset.match),
                    )
                    if (exists) return
                    const newProvider: EditingProvider = {
                      id: generateId(),
                      name: preset.name,
                      apiBaseUrl: `https://${preset.match}`,
                      apiKey: '',
                      models: [],
                      _key: generateId(),
                      _isNew: true,
                      _discovering: false,
                      _discoveryError: null,
                    }
                    setEditingProviders(prev => [...prev, newProvider])
                    markDirty()
                  }}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </details>

          {/* Save / Discard */}
          <div className={css.footer}>
            {saveError ? <p className={css.failed} role="status">{saveError}</p> : null}
            <button
              type="button"
              className={css.discard}
              disabled={!editDirty || saving}
              onClick={() => {
                loadConfig()
                setEditDirty(false)
                setSaveError(null)
              }}
            >
              {t('settings.discard')}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={!editDirty || saving}
              onClick={handleSave}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}