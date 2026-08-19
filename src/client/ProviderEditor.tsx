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

export interface ProviderModel {
  id: string
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
  onSave: (provider: Provider) => void | Promise<void>
  onCancel: () => void
}

export function ProviderEditor({ id, initial, onSave, onCancel }: ProviderEditorProps) {
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
  const [discovered, setDiscovered] = useState<ProviderModel[] | null>(null)
  const [discoveredSource, setDiscoveredSource] = useState<'preset' | 'live'>('live')
  const [discoveredWarning, setDiscoveredWarning] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [manualId, setManualId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** 选择厂商模板：自动填入名称与端点（并预填内置候选模型）。 */
  const applyPreset = (value: string): void => {
    setPresetKey(value)
    if (value === '') return
    const preset = PROVIDER_PRESETS.find(p => p.apiBaseUrl === value)
    if (preset !== undefined) {
      setName(preset.name)
      setBaseUrl(preset.apiBaseUrl)
      setModels(preset.models.map(m => ({ id: m.id })))
    }
  }

  const hasModel = (id: string): boolean => models.some(m => m.id === id)

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setError('')
    setDiscoveredWarning('')
    try {
      const resp = await fetch('/api/dsh-image-create/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      })
      const json = await resp.json()
      if (json.ok && json.models) {
        setDiscovered(json.models.map((m: { id: string }) => ({ id: m.id })))
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

  const presetOptions = [
    <option key="__custom" value="">{tt('settings.customEndpoint')}</option>,
    ...PROVIDER_PRESETS.map(preset => (
      <option key={preset.apiBaseUrl} value={preset.apiBaseUrl}>
        {preset.name}（{preset.apiBaseUrl}）
      </option>
    )),
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
            {apiKey.trim() === '' ? tt('settings.noKeyForPreset') : ''}
          </span>
        </div>

        {discovered !== null && discovered.length > 0 ? (
          <div className="zGbnIq_addBlock">
            {discoveredSource === 'preset' && discoveredWarning !== '' ? (
              <p className="zGbnIq_notice">{discoveredWarning}</p>
            ) : null}
            <ul className="iv_candidateList">
              {discovered.map(model => (
                <li key={model.id} className="zGbnIq_candidate">
                  <label className="iv_candidateLabel">
                    <input type="checkbox" checked={hasModel(model.id)} onChange={() => toggleModel(model)} />
                    <span className="iv_candidateId">{model.id}</span>
                  </label>
                </li>
              ))}
            </ul>
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
