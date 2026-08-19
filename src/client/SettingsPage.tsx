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
}

function ProviderCard({ provider, active, onUse, onRemoveModel, onAddModels, onEdit, onDelete }: ProviderCardProps) {
  // 模型列表收纳状态：true = 收起（默认展开，与视觉插件一致）。
  const [collapsed, setCollapsed] = useState(false)
  // 内嵌「添加模型」面板。
  const [panelOpen, setPanelOpen] = useState(false)
  const [addDiscovered, setAddDiscovered] = useState<ProviderModel[] | null>(null)
  const [addDiscovering, setAddDiscovering] = useState(false)
  const [addManual, setAddManual] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})

  const isActiveProvider = active.startsWith(`${provider.id}:`)
  const target = resolveActive([provider], active)

  const addDiscover = async (): Promise<void> => {
    setAddDiscovering(true)
    try {
      const resp = await fetch('/api/dsh-image-create/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: provider.apiBaseUrl, apiKey: provider.apiKey || '' }),
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
    onAddModels(provider.id, [{ id: value }])
  }

  const confirmAdd = (): void => {
    const ids = Object.keys(picked)
    if (ids.length === 0) return
    onAddModels(provider.id, ids.map(id => ({ id })))
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

  return (
    <li className={`zGbnIq_rowCard iv_providerCard${isActiveProvider ? ' iv_activeCard' : ''}`}>
      <div
        className="zGbnIq_rowHead"
        style={{ background: 'rgba(128,128,128,0.10)', borderRadius: 8, padding: '6px 8px', margin: '-6px -8px' }}
      >
        <Dot active={isActiveProvider} />
        <span className="zGbnIq_rowIdentity">
          <span className="zGbnIq_rowName">{provider.name}</span>
          <span className="zGbnIq_rowTag">{provider.models.length} {tt('settings.modelsCount')}</span>
          {isActiveProvider ? <span className="zGbnIq_rowTag iv_visionYes">{tt('settings.inUse')}</span> : null}
        </span>
        <span className="zGbnIq_rowActions">
          <button
            type="button"
            className="zGbnIq_iconButton"
            title={collapsed ? tt('settings.expand') : tt('settings.collapse')}
            onClick={() => setCollapsed(!collapsed)}
          >
            <IconChevronDownOutline14 style={collapsed ? { transform: 'rotate(-90deg)' } : undefined} />
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
        <p className="iv_metaText" style={{ flex: 1 }} title={provider.apiBaseUrl}>
          {provider.apiBaseUrl}
        </p>
      </div>

      {!collapsed && provider.models.length > 0 ? (
        <ul className="zGbnIq_modelList" style={{ margin: 0 }}>
          {provider.models.map(model => {
            const isUsing = isActiveProvider && target !== null && target.model.id === model.id
            return (
              <li
                key={model.id}
                className="zGbnIq_modelEntry"
                style={isUsing ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : undefined}
              >
                <div className="zGbnIq_modelRow iv_modelRow">
                  <span className="iv_candidateId">{model.id}</span>
                  <button
                    type="button"
                    className="zGbnIq_secondaryButton"
                    style={{ height: 28, padding: '0 10px', fontSize: 12, borderRadius: 14 }}
                    disabled={isUsing}
                    title={isUsing ? tt('settings.inUse') : tt('settings.useModel')}
                    onClick={() => onUse(provider.id, model.id)}
                  >
                    {isUsing ? tt('settings.inUse') : tt('settings.use')}
                  </button>
                  <button
                    type="button"
                    className="zGbnIq_iconButton zGbnIq_iconButtonDanger"
                    title={tt('settings.removeModel')}
                    onClick={() => onRemoveModel(provider.id, model.id)}
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

  const providerCards = providers.map((prov, idx) => {
    // 就地编辑：编辑界面直接渲染在原卡片位置，不收起、不跳转（与视觉插件一致）。
    if (editing !== null && editing.index === idx) {
      return (
        <ProviderEditor
          key={`edit-${prov.id}`}
          id="iv-editor-edit"
          initial={prov}
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
      />
    )
  })

  return (
    <div className="zGbnIq_section">
      <h2 className="zGbnIq_title">{tt('settings.title')}</h2>
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
          <ProviderEditor key="add" id="iv-editor-add" initial={null} onSave={(draft) => finishEdit(draft)} onCancel={() => setAdding(false)} />
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
