import {useEffect,useId,useRef,useState} from 'react'
import {ChevronDown,LoaderCircle,RefreshCcw,Sparkles} from 'lucide-react'
import type {Harnesses} from '../types'
import {assistantEffortOptions,assistantModelOptions,assistantSummary,harnessLabel,TIMEOUT_OPTIONS,type AssistantSetting} from '../assistantSettings'

interface Props {
  assistant: AssistantSetting
  harnesses: Harnesses | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (next: AssistantSetting) => void
  onRedetect: () => Promise<boolean>
}

// The one place to choose the assistant. The topbar button, the Analyze summary and the panel "Change" buttons all open it.
export function AssistantMenu({assistant, harnesses, open, onOpenChange, onChange, onRedetect}: Props) {
  const baseId = useId()
  const wrapper = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [redetecting, setRedetecting] = useState(false)
  const [redetectFailed, setRedetectFailed] = useState(false)

  const installed = !!harnesses?.[assistant.harness]?.installed
  const models = assistantModelOptions(harnesses, assistant.harness)
  const listed = assistant.model === 'default' || models.some(item => item.id === assistant.model)
  const showCustom = customOpen || !listed
  const efforts = assistantEffortOptions(harnesses, assistant.harness, assistant.model)

  // Focus moves into the panel when it opens, and goes back to whatever opened it when Escape closes it.
  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLElement>('select, input, button')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
      ;(returnFocus.current || trigger.current)?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, onOpenChange])

  function chooseHarness(value: AssistantSetting['harness']) {
    setCustomOpen(false)
    onChange({harness: value, model: 'default', effort: 'default', timeout_seconds: assistant.timeout_seconds})
  }

  function chooseModel(value: string) {
    if (value === 'custom') { setCustomOpen(true); return }
    setCustomOpen(false)
    onChange({...assistant, model: value})
  }

  async function redetect() {
    setRedetecting(true)
    setRedetectFailed(false)
    const ok = await onRedetect()
    setRedetecting(false)
    setRedetectFailed(!ok)
  }

  return <div className="assistant-menu" ref={wrapper}>
    <button ref={trigger} type="button" className="topbar-action assistant-menu-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${baseId}-panel` : undefined} onClick={() => onOpenChange(!open)} title="Choose the assistant used for AI review notes, questions and architecture">
      <Sparkles size={14}/><span>{assistantSummary(assistant)}</span>
    </button>
    {open && <div id={`${baseId}-panel`} ref={panel} className="assistant-menu-panel" role="dialog" aria-labelledby={`${baseId}-title`}>
      <div className="assistant-menu-head"><strong id={`${baseId}-title`}>Assistant</strong><span>Used for AI review notes, questions and architecture.</span></div>
      <div className="form-field">
        <label htmlFor={`${baseId}-harness`}>Assistant CLI</label>
        <div className="select-wrap"><select id={`${baseId}-harness`} value={assistant.harness} onChange={event => chooseHarness(event.target.value as AssistantSetting['harness'])}>
          {(['codex', 'claude'] as const).map(key => <option key={key} value={key} disabled={!!harnesses && !harnesses[key].installed}>{harnessLabel(key)}{harnesses && !harnesses[key].installed ? ' (not installed)' : ''}</option>)}
        </select><ChevronDown size={15}/></div>
      </div>
      <div className="form-field">
        <label htmlFor={`${baseId}-model`}>Model</label>
        <div className="select-wrap"><select id={`${baseId}-model`} value={showCustom ? 'custom' : assistant.model} onChange={event => chooseModel(event.target.value)}>
          <option value="default">CLI default</option>
          {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          <option value="custom">Custom model ID…</option>
        </select><ChevronDown size={15}/></div>
        {showCustom && <input className="custom-model" aria-label="Custom model ID" placeholder="Enter CLI model ID" value={listed ? '' : assistant.model} onChange={event => onChange({...assistant, model: event.target.value.trim() || 'default'})}/>}
      </div>
      <div className="form-field">
        <label htmlFor={`${baseId}-effort`}>Reasoning effort</label>
        <div className="select-wrap"><select id={`${baseId}-effort`} value={assistant.effort} onChange={event => onChange({...assistant, effort: event.target.value})}>
          <option value="default">CLI default</option>
          {efforts.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}
        </select><ChevronDown size={15}/></div>
      </div>
      <div className="form-field">
        <label htmlFor={`${baseId}-timeout`}>Time limit per assistant call</label>
        <div className="select-wrap"><select id={`${baseId}-timeout`} value={assistant.timeout_seconds === undefined ? 'default' : String(assistant.timeout_seconds)} onChange={event => { const {timeout_seconds: _drop, ...rest} = assistant; onChange(event.target.value === 'default' ? rest : {...rest, timeout_seconds: Number(event.target.value)}) }}>
          {TIMEOUT_OPTIONS.map(item => <option key={item.label} value={item.value === undefined ? 'default' : String(item.value)}>{item.label}</option>)}
        </select><ChevronDown size={15}/></div>
        <p className="timeout-hint">Large PRs can need longer. "No limit" lets the assistant run until you press Stop.</p>
      </div>
      <div className="assistant-menu-status">
        <span className={'status-tag ' + (installed ? 'ok' : '')} role="status">{harnesses ? (installed ? 'Detected' : 'Not detected') : 'Checking…'}</span>
        <button type="button" className="secondary-btn" disabled={redetecting} onClick={redetect}>{redetecting ? <LoaderCircle size={14} className="spinning"/> : <RefreshCcw size={14}/>}<span>Re-detect CLIs</span></button>
      </div>
      {redetectFailed && <p className="assistant-menu-error" role="alert">Could not reach Prism to check the CLIs. Try again.</p>}
    </div>}
  </div>
}
