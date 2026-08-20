/**
 * 供应商编辑器（添加/编辑共用）——照抄自视觉插件（dsh-image-vision）的
 * ProviderEditor，仅适配生图插件的配置形态与路由：
 * - 厂商模板下拉（选择后自动填入名称与端点）；
 * - API Key 不回显（GET 已脱敏为占位）：输入框初始为空；留空保存 = 保留原 Key；
 * - 模型：获取列表勾选 + 手动添加 + 删除；
 * - 保存/取消按钮。
 */

import { useState } from 'react'
import { PRESET_PROVIDER_CATALOG } from '../protocol.ts'
import { tt } from './helpers.ts'

/** 与后端 routes.ts 一致的脱敏占位符：GET 时已存密钥会被替换成它。 */
const MASKED_KEY = '********'

export interface ProviderModel {
  id: string
}

/** 候选模型（含后端标注的生图能力）。 */
interface DiscoveredModel {
  id: string
  image?: boolean
}

export interface Provider {
  id: string
  name: string
  apiBaseUrl: string
  apiKey: string
  models: ProviderModel[]
}

/** 厂商模板（由 image-create 的 PRESET_PROVIDER_CATALOG 映射：match → https://match）。 */
const PROVIDER_PRESETS = PRESET_PROVIDER_CATALOG.map(preset => ({
  name: preset.name,
  apiBaseUrl: `https://${preset.match}`,
  models: preset.models.map(id => ({ id })),
}))

function generateId(): string {
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="zGbnIq_field">
      <label className="zGbnIq_fieldLabel">{label}</label>
      {children}
    </div>
  )
}

function TextInput(props: {
  value: string
  type?: string
  placeholder?: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <input
      className="zGbnIq_input"
      value={props.value}
      type={props.type ?? 'text'}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled ?? false}
      onChange={(e) => props.onChange(e.target.value)}
    />
  )
}

interface ProviderEditorProps {
  /** DOM id（视觉插件原样保留）。 */
  id?: string
  /** 已存在的供应商（编辑）；null = 添加。 */
  initial: Provider | null
  /** 已存在的供应商 baseUrl 集合（去尾斜杠、小写），用于在下拉里禁用重复预设。 */
  existingBaseUrls?: string[]
  onSave: (provider: Provider) => void | Promise<void>
  onCancel: () => void
}

export function ProviderEditor({ id, initial, existingBaseUrls = [], onSave, onCancel }: ProviderEditorProps) {
  // apiKey 不回显：输入框初始为空；留空保存 = 保留原 Key。
  const [presetKey, setPresetKey] = useState(() => {
    const url = initial?.apiBaseUrl ?? ''
    return PROVIDER_PRESETS.some(preset => preset.apiBaseUrl === url) ? url : ''
  })
  const [name, setName] = useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.apiBaseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const hasExistingKey = !!(initial && initial.apiKey && initial.apiKey !== '')
  const [models, setModels] = useState<ProviderModel[]>(initial?.models ?? [])
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [discoveredSource, setDiscoveredSource] = useState<'preset' | 'live'>('live')
  const [discoveredWarning, setDiscoveredWarning] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [manualId, setManualId] = useState('')
  const [search, setSearch] = useState('')
  // 人工纠错：模型 id → 是否生图（覆盖后端 guessImageGen 判定）
  const [imageOverrides, setImageOverrides] = useState<Record<string, boolean>>({})
  // 候选列表排序：名称（主）、生图（次），各 none/asc/desc
  const [nameSort, setNameSort] = useState<'none' | 'asc' | 'desc'>('none')
  const [imageSort, setImageSort] = useState<'none' | 'asc' | 'desc'>('none')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** 选择厂商模板：自动填入名称与端点（不预填模型，模型须点「获取模型列表」后勾选或手动添加）。 */
  const applyPreset = (value: string): void => {
    setPresetKey(value)
    if (value === '') return
    const preset = PROVIDER_PRESETS.find(p => p.apiBaseUrl === value)
    if (preset !== undefined) {
      setName(preset.name)
      setBaseUrl(preset.apiBaseUrl)
    }
  }

  const hasModel = (id: string): boolean => models.some(m => m.id === id)

  // 模型是否生图：人工纠错覆盖表优先，否则用后端 guessImageGen 判定
  const effectiveImage = (m: DiscoveredModel): boolean =>
    Object.prototype.hasOwnProperty.call(imageOverrides, m.id)
      ? imageOverrides[m.id]
      : m.image !== false

  // 切换某模型的人工生图判定
  const toggleOverride = (id: string): void => {
    setImageOverrides(prev => {
      const next = { ...prev }
      const base = next[id] ?? (discovered?.find(m => m.id === id)?.image ?? false)
      next[id] = !base
      return next
    })
  }

  // 已获取候选模型：排序（名称为主、生图为次）+ 按搜索词（不区分大小写）过滤
  const q = search.trim().toLowerCase()
  const filteredDiscovered = discovered === null
    ? null
    : [...discovered]
        .sort((a, b) => {
          // 主排序：按名称
          if (nameSort !== 'none') {
            const cmp = a.id.localeCompare(b.id)
            if (cmp !== 0) return nameSort === 'asc' ? cmp : -cmp
          }
          // 次排序：按是否生图（asc=生图优先 true 在前，desc=非生图优先 false 在前）
          if (imageSort !== 'none') {
            const diff = Number(effectiveImage(b)) - Number(effectiveImage(a))
            const sign = imageSort === 'asc' ? 1 : -1
            if (diff !== 0) return diff * sign
          }
          return 0
        })
        .filter(m => q === '' || m.id.toLowerCase().includes(q))

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setError('')
    setDiscoveredWarning('')
    try {
      const resp = await fetch('/api/dsh-image-create/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 本地为空但已存 key 时传占位符，让后端走「找回原 key」分支
        // （routes.ts 对 MASKED_KEY / '' / cred: / env: 都会按 baseUrl 回查真实 key）。
        body: JSON.stringify({ baseUrl, apiKey: apiKey.trim() !== '' ? apiKey : (hasExistingKey ? MASKED_KEY : '') }),
      })
      const json = await resp.json()
      if (json.ok && json.models) {
        setDiscovered(json.models.map((m: { id: string; image?: boolean }) => ({ id: m.id, image: m.image })))
        setDiscoveredSource(json.source === 'preset' ? 'preset' : 'live')
        setDiscoveredWarning(json.warning ?? '')
      } else {
        setError(json.warning ?? json.message ?? tt('settings.fetchFailed'))
      }
    } catch {
      setError(tt('settings.fetchFailed'))
    }
    setDiscovering(false)
  }

  const toggleModel = (model: ProviderModel): void => {
    if (hasModel(model.id)) setModels(models.filter(x => x.id !== model.id))
    else setModels([...models, { id: model.id }])
  }

  const addManual = (): void => {
    const value = manualId.trim()
    if (value === '') return
    if (hasModel(value)) { setManualId(''); return }
    setModels([...models, { id: value }])
    setManualId('')
  }

  const removeModel = (id: string): void => {
    setModels(models.filter(m => m.id !== id))
  }

  const canSave = name.trim() !== '' && baseUrl.trim() !== '' && (apiKey.trim() !== '' || hasExistingKey) && models.length > 0

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError('')
    try {
      // 留空 = 不修改：回传原值（host 遇到脱敏占位会保留真实 Key）。
      const submitKey = apiKey.trim() !== '' ? apiKey.trim() : (initial?.apiKey ?? '')
      await onSave({
        id: initial?.id ?? generateId(),
        name: name.trim(),
        apiBaseUrl: baseUrl.trim(),
        apiKey: submitKey,
        models,
      })
    } catch (e) {
      setError(tt('settings.saveFailed') + ': ' + String(e instanceof Error ? e.message : e))
      setBusy(false)
    }
  }

  // 已存在的供应商 baseUrl（去尾斜杠、小写），用于禁用重复预设
  const existingSet = new Set(existingBaseUrls.map(u => u.replace(/\/+$/, '').toLowerCase()))

  const presetOptions = [
    <option key="__custom" value="">{tt('settings.customEndpoint')}</option>,
    ...PROVIDER_PRESETS.map(preset => {
      const exists = existingSet.has(preset.apiBaseUrl.replace(/\/+$/, '').toLowerCase())
      return (
        <option key={preset.apiBaseUrl} value={preset.apiBaseUrl} disabled={exists}>
          {preset.name}（{preset.apiBaseUrl}）{exists ? ` · ${tt('settings.presetAdded')}` : ''}
        </option>
      )
    }),
  ]

  return (
    <li id={id} className="zGbnIq_addCard iv_editingCard">
      <div className="zGbnIq_editorHeader">
        <span className="zGbnIq_editorTitle">
          {initial !== null ? `${tt('settings.editProviderTitle')}：${initial.name ?? ''}` : tt('settings.addProvider')}
        </span>
        {initial !== null ? <span className="zGbnIq_editorRoute">{initial.id}</span> : null}
      </div>

      <Field label={tt('settings.providerTemplate')}>
        <select className="zGbnIq_input" style={{ maxWidth: '100%' }} value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
          {presetOptions}
        </select>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 }}>
          {tt('settings.providerTemplateHint')}
        </div>
      </Field>

      <Field label={tt('settings.providerName')}>
        <TextInput value={name} placeholder="e.g. OpenAI" onChange={setName} />
      </Field>

      <Field label={tt('settings.apiEndpoint')}>
        <TextInput value={baseUrl} placeholder="https://api.openai.com/v1" onChange={setBaseUrl} />
      </Field>

      <Field label={tt('settings.apiKey')}>
        <TextInput
          value={apiKey}
          type="password"
          placeholder={hasExistingKey ? tt('settings.keySetHint') : 'sk-... or cred:REF or env:VAR'}
          onChange={setApiKey}
        />
      </Field>

      <Field label={tt('settings.models')}>
        <div className="iv_inlineRow">
          <button
            type="button"
            className="zGbnIq_secondaryButton"
            disabled={discovering || baseUrl.trim() === ''}
            onClick={() => void discover()}
          >
            {discovering ? tt('settings.fetchingModels') : tt('settings.fetchModels')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            {apiKey.trim() === ''
              ? (hasExistingKey ? tt('settings.usingStoredKey') : tt('settings.noKeyForPreset'))
              : ''}
          </span>
          {discovered !== null && discovered.length > 0 ? (
            <>
              <select
                className="zGbnIq_input zGbnIq_sortSelect"
                value={nameSort}
                onChange={(e) => setNameSort(e.target.value as 'none' | 'asc' | 'desc')}
                title={tt('settings.sortNameTitle')}
              >
                <option value="none">{tt('settings.sortNameNone')}</option>
                <option value="asc">{tt('settings.sortNameAsc')}</option>
                <option value="desc">{tt('settings.sortNameDesc')}</option>
              </select>
              <select
                className="zGbnIq_input zGbnIq_sortSelect"
                value={imageSort}
                onChange={(e) => setImageSort(e.target.value as 'none' | 'asc' | 'desc')}
                title={tt('settings.sortImageTitle')}
              >
                <option value="none">{tt('settings.sortImageNone')}</option>
                <option value="asc">{tt('settings.sortImageAsc')}</option>
                <option value="desc">{tt('settings.sortImageDesc')}</option>
              </select>
              <input
                className="zGbnIq_input zGbnIq_searchInput"
                type="search"
                value={search}
                placeholder={tt('settings.searchModels')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </>
          ) : null}
        </div>

        {discovered !== null && discovered.length > 0 ? (
          <div className="zGbnIq_addBlock">
            {discoveredSource === 'preset' && discoveredWarning !== '' ? (
              <p className="zGbnIq_notice">{discoveredWarning}</p>
            ) : null}
            <ul className="iv_candidateList">
              {filteredDiscovered !== null && filteredDiscovered.map(model => {
                const isImage = effectiveImage(model)
                return (
                  <li key={model.id} className="zGbnIq_candidate">
                    <label className="iv_candidateLabel" style={isImage ? undefined : { opacity: 0.55 }}>
                      <input
                        type="checkbox"
                        checked={hasModel(model.id)}
                        disabled={!isImage}
                        title={isImage ? '' : tt('settings.notImageModel')}
                        onChange={() => toggleModel(model)}
                      />
                      <span className="iv_candidateId">{model.id}</span>
                      <button
                        type="button"
                        className="zGbnIq_iconButton"
                        title={tt('settings.correctHint')}
                        onClick={() => toggleOverride(model.id)}
                      >
                        ⇄
                      </button>
                      <span className={`zGbnIq_rowTag ${isImage ? 'iv_visionYes' : 'iv_visionNo'}`}>
                        {isImage ? tt('settings.imageModel') : tt('settings.notImageModel')}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            {filteredDiscovered !== null && filteredDiscovered.length === 0 ? (
              <p className="zGbnIq_modelEmpty">{tt('settings.noModels')}</p>
            ) : null}
          </div>
        ) : null}

        {discovered !== null && discovered.length === 0 ? (
          <p className="zGbnIq_modelEmpty">{tt('settings.noModels')}</p>
        ) : null}

        {models.length > 0 ? (
          <ul className="zGbnIq_modelList" style={{ marginTop: 8 }}>
            {models.map(model => (
              <li key={model.id} className="zGbnIq_modelEntry">
                <div className="zGbnIq_modelRow iv_modelRow">
                  <span className="iv_candidateId">{model.id}</span>
                  <button
                    type="button"
                    className="zGbnIq_iconButton zGbnIq_iconButtonDanger"
                    title={tt('settings.removeModel')}
                    onClick={() => removeModel(model.id)}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="iv_manualRow">
          <TextInput value={manualId} placeholder={tt('settings.addModelPlaceholder')} onChange={setManualId} />
          <button type="button" className="zGbnIq_secondaryButton" onClick={addManual}>
            {tt('settings.add')}
          </button>
        </div>
      </Field>

      {error !== '' ? <p className="zGbnIq_error">{error}</p> : null}

      <div className="zGbnIq_editorActions">
        <button type="button" className="zGbnIq_secondaryButton" disabled={busy} onClick={onCancel}>
          {tt('settings.cancel')}
        </button>
        <button type="button" className="zGbnIq_primaryButton" disabled={busy || !canSave} onClick={() => void save()}>
          {busy ? tt('settings.saving') : tt('settings.save')}
        </button>
      </div>
    </li>
  )
}
