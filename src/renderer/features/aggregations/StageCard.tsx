import { useState } from 'react'
import type { Compiled } from '@shared/aggregations/compiler'
import { stageFragment, stagesFromFragment } from '@shared/aggregations/decompiler'
import { newStage, STAGE_HINT, STAGE_LABEL, type Stage, type StageKind } from '@shared/aggregations/model'
import { CodeEditor } from '../../components/CodeEditor'
import { Menu } from '../../components/Menu'
import { OutputPanel } from './OutputPanel'
import type { Preview } from './preview'
import { StageForm, type FormCtx } from './StageForms'
import { describe, groupKindLabel, outcome } from './summary'

export const ADDABLE: Array<[StageKind, string]> = [
  ['filter', 'Filter'],
  ['groupBy', 'Group by'],
  ['metrics', 'Metrics'],
  ['keepOnly', 'Keep only (having)'],
  ['sortLimit', 'Sort & limit'],
  ['runningTotal', 'Running total'],
  ['changeOverTime', 'Change over time'],
  ['topDocs', 'Top documents'],
  ['custom', 'Custom JSON']
]

export interface CardProps {
  stage: Stage
  index: number
  stages: Stage[]
  compiled: Compiled
  preview?: Preview
  previous?: Preview
  ctx: FormCtx
  focused: boolean
  profileMs?: number
  onChange(s: Stage): void
  /** Replace this stage with several (an edited JSON fragment that maps to more than one stage). */
  onReplace(stages: Stage[]): void
  onRemove(): void
  onMove(delta: -1 | 1): void
  onDuplicate(): void
  onFocus(): void
}

/** One stage: the form on the left, its live output on the right (mockup screen 7). */
export function StageCard({ stage, index, stages, compiled, preview, previous, ctx, focused, profileMs, onChange, onReplace, onRemove, onMove, onDuplicate, onFocus }: CardProps) {
  const [json, setJson] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string>()
  const info = compiled.stages[index]!
  const errors = info.errors
  const n = index + 1
  const level = info.level > 0 ? compiled.levels[info.level] : undefined
  const opened = compiled.levels.find((l) => l.stageIndex === index && l.kind === 'multi')
  const kindLabel = stage.kind === 'groupBy' ? stage.group.type : undefined

  const openJson = () => {
    setJson(JSON.stringify(stageFragment({ stages }, index), null, 2))
    setJsonError(undefined)
  }
  const applyJson = () => {
    try {
      const frag = JSON.parse(json ?? '{}') as unknown
      if (!frag || typeof frag !== 'object' || Array.isArray(frag)) throw new Error('Must be a JSON object')
      const parsed = stagesFromFragment(frag as Record<string, unknown>, ctx.atRoot)
      if (!parsed.length) throw new Error('Nothing to keep — delete the stage instead')
      const keep = (s: Stage): Stage => ({ ...s, id: stage.id, enabled: stage.enabled, label: stage.label })
      onReplace(parsed.length === 1 ? [keep(parsed[0]!)] : parsed)
      setJson(null)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }

  if (stage.collapsed)
    return (
      <section className={`agg-card collapsed${focused ? ' focused' : ''}${stage.enabled ? '' : ' off'}`} id={`stage-${stage.id}`} onFocusCapture={onFocus} onMouseDown={onFocus}>
        <span className="agg-num">{n}</span>
        <button type="button" className="agg-collapsed-type" onClick={() => onChange({ ...stage, collapsed: false })} aria-label={`Expand stage ${n}`}>
          {STAGE_LABEL[stage.kind]}
        </button>
        <span className="mono agg-collapsed-desc" title={describe(stage, compiled, index)}>
          {describe(stage, compiled, index)}
        </span>
        <span className="faint">→</span>
        <span className={`mono agg-outcome${errors.length ? ' bad' : ''}`}>{errors.length ? `⚠ ${errors[0]}` : outcome(stage, index, preview, previous)}</span>
      </section>
    )

  return (
    <section className={`agg-card${focused ? ' focused' : ''}${stage.enabled ? '' : ' off'}${errors.length ? ' has-error' : ''}`} id={`stage-${stage.id}`} aria-label={`Stage ${n}: ${STAGE_LABEL[stage.kind]}`} onFocusCapture={onFocus} onMouseDown={onFocus}>
      <div className="agg-card-form">
        <div className="agg-card-head">
          <span className="agg-num">{n}</span>
          <Menu
            label={`Stage ${n} kind`}
            buttonClass="agg-kind"
            align="left"
            items={ADDABLE.map(([k, l]) => ({ label: l, onSelect: () => k !== stage.kind && onChange({ ...newStage(k, { keyword: ctx.fields?.find((f) => f.type === 'keyword')?.path, numeric: ctx.fields?.find((f) => ['long', 'integer', 'double', 'float'].includes(f.type))?.path }), id: stage.id }) }))}
          >
            <span>
              {STAGE_LABEL[stage.kind]}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </Menu>
          {kindLabel && <span className="pill tiny mono" title={groupKindLabel(stage)}>{kindLabel}</span>}
          <span className="hint">{stage.kind === 'metrics' && level ? `calculated per ${level.label}` : level && stage.kind !== 'groupBy' && stage.kind !== 'filter' ? `applies to ${level.label} buckets` : STAGE_HINT[stage.kind]}</span>
          {profileMs !== undefined && <span className="pill tiny mono" title="Time spent in this stage's aggregations (profile)">⏱ {profileMs < 1 ? profileMs.toFixed(2) : profileMs.toFixed(1)} ms</span>}
          <span className="agg-card-actions">
            <button type="button" onClick={() => (json === null ? openJson() : setJson(null))} aria-pressed={json !== null} title="Edit this stage's JSON">
              &lt;/&gt; JSON
            </button>
            <button type="button" onClick={() => onChange({ ...stage, enabled: !stage.enabled })}>{stage.enabled ? 'Disable' : 'Enable'}</button>
            <Menu
              label={`Stage ${n} actions`}
              buttonClass="agg-more"
              items={[
                { label: 'Collapse', onSelect: () => onChange({ ...stage, collapsed: true }) },
                { label: 'Move up  ⌘⌥↑', onSelect: () => onMove(-1), disabled: index === 0 },
                { label: 'Move down  ⌘⌥↓', onSelect: () => onMove(1), disabled: index === stages.length - 1 },
                { label: 'Duplicate  ⌘D', onSelect: onDuplicate },
                'sep',
                { label: 'Delete  ⌘⌫', danger: true, onSelect: onRemove }
              ]}
            >
              ⋯
            </Menu>
            <button type="button" aria-label={`Delete stage ${n}`} onClick={onRemove}>
              ✕
            </button>
          </span>
        </div>
        {json !== null ? (
          <div className="agg-stage-json">
            <div className="agg-stage-json-editor">
              <CodeEditor value={json} onChange={setJson} height={Math.min(320, 30 + json.split('\n').length * 21)} options={{ lineNumbers: 'off', folding: false }} onRun={applyJson} />
            </div>
            {jsonError && <div className="hint error">{jsonError}</div>}
            <div className="agg-row">
              <button type="button" className="btn xs primary" onClick={applyJson}>
                Apply
              </button>
              <button type="button" className="btn xs" onClick={() => setJson(null)}>
                Cancel
              </button>
              <span className="hint">Only this stage’s part of the request. Shapes the form can’t show become Custom JSON.</span>
            </div>
          </div>
        ) : (
          <StageForm stage={stage} onChange={onChange} ctx={ctx} />
        )}
        {opened && stage.enabled && !errors.length && <div className="agg-note">Each next stage runs <b>inside every {opened.label} bucket</b>.</div>}
        {info.warnings.map((w) => (
          <div key={w} className="agg-note warn">
            {w}
          </div>
        ))}
        {errors.map((e) => (
          <div key={e} className="agg-error" role="alert">
            {e}
          </div>
        ))}
      </div>
      <div className="agg-card-out">
        <OutputPanel stage={stage} index={index} preview={preview} previous={previous} stages={stages} />
      </div>
    </section>
  )
}
