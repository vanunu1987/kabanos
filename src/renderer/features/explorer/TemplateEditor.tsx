import { useState } from 'react'
import { removeField, type Mapping } from '@shared/mappingEdit'
import { flattenMapping, type TemplateSummary } from '@shared/meta'
import type { ConnectionConfig } from '@shared/types'
import { api, KabanosError } from '../../api'
import { refreshConnection } from '../../queries'
import { useApp } from '../../store'
import { reason } from './indexActions'
import { CodeEditor } from '../../components/CodeEditor'
import { Modal } from '../../components/Modal'
import { FieldModal, JsonModal, type FieldTarget } from './MappingEditor'
import { MappingTable } from './MappingTable'

type Body = { template?: { mappings?: Mapping; settings?: Record<string, unknown> }; [k: string]: unknown }

/** GET returns timestamps the cluster manages (ES 9); PUT rejects them, also when pasted back in. */
function withoutSystemKeys(b: Body): Body {
  const { created_date_millis: _c, modified_date_millis: _m, created_date: _cd, modified_date: _md, ...rest } = b
  return rest
}

/**
 * A template's own mapping with add / edit / delete. Templates only shape indices created later,
 * so every change is a plain PUT of the whole template — no reindex.
 */
export function TemplateMappingEditor({ conn, t }: { conn: ConnectionConfig; t: TemplateSummary }) {
  const body = withoutSystemKeys((t.body ?? {}) as Body)
  const mapping: Mapping = body.template?.mappings ?? {}
  const fields = flattenMapping(mapping)
  const [modal, setModal] = useState<{ kind: 'add' } | { kind: 'edit'; path: string } | { kind: 'json' } | null>(null)
  const path = `${t.kind === 'index' ? '_index_template' : '_component_template'}/${encodeURIComponent(t.name)}`
  const analysis = (body.template?.settings as { index?: { analysis?: { analyzer?: object } }; analysis?: { analyzer?: object } } | undefined) ?? {}
  const target: FieldTarget = { kind: 'template', name: t.name, fields, analyzers: Object.keys(analysis.index?.analysis?.analyzer ?? analysis.analysis?.analyzer ?? {}) }

  const put = async (next: Body, ok: string): Promise<string | null> => {
    try {
      const res = await api.cluster.request({ connectionId: conn.id, method: 'PUT', path, body: JSON.stringify(withoutSystemKeys(next)) })
      if (res.status >= 400) return reason(res.body)
      await refreshConnection(conn.id)
      useApp.getState().showToast(ok)
      setModal(null)
      return null
    } catch (e) {
      if (e instanceof KabanosError && e.code === 'NOT_CONFIRMED') return 'Not saved — confirmation declined'
      return (e as Error).message
    }
  }
  const withMapping = (m: Mapping): Body => ({ ...body, template: { ...(body.template ?? {}), mappings: m } })
  const submit = (next: Mapping, ok: string) => (JSON.stringify(next) === JSON.stringify(mapping) ? Promise.resolve('Nothing changed') : put(withMapping(next), ok))
  const del = async (field: string) => {
    if (!confirm(`Delete ${field} from template ${t.name}?\n\nIndices created from now on won't map it. Existing indices keep it.`)) return
    const err = await put(withMapping(removeField(mapping, field)), `Deleted ${field} from ${t.name}`)
    if (err) useApp.getState().showToast(err)
  }

  return (
    <>
      <MappingTable
        fields={fields}
        raw={mapping}
        fill
        onEditField={t.managed ? undefined : (p) => setModal({ kind: 'edit', path: p })}
        toolbar={
          t.managed ? (
            <span className="hint" title="Managed by the stack — changes would be overwritten">Built-in template · read-only</span>
          ) : (
            <>
              <button className="btn xs" onClick={() => setModal({ kind: 'json' })}>
                Edit template JSON
              </button>
              <button className="btn xs primary" onClick={() => setModal({ kind: 'add' })}>
                + Add field
              </button>
            </>
          )
        }
      />
      {t.kind === 'index' && t.composedOf.length > 0 && <div className="hint tpl-note">Indices also get the fields of {t.composedOf.join(', ')} — edit those component templates to change them.</div>}
      {modal?.kind === 'add' && <FieldModal target={target} mapping={mapping} onClose={() => setModal(null)} submit={submit} />}
      {modal?.kind === 'edit' && <FieldModal target={target} mapping={mapping} editPath={modal.path} onClose={() => setModal(null)} submit={submit} onDelete={() => void del(modal.path)} />}
      {modal?.kind === 'json' && (
        <JsonModal
          mapping={body}
          title={`Edit ${t.kind === 'index' ? 'index' : 'component'} template ${t.name}`}
          note={`The whole PUT ${path} body: ${t.kind === 'index' ? 'index_patterns, priority, composed_of, ' : ''}template.settings / mappings / aliases. Applies to indices created from now on.`}
          saveLabel="Save template"
          submit={(next) => put(next as Body, `Saved template ${t.name}`)}
          onClose={() => setModal(null)}
        />
      )}
    </>
  )
}

const STARTERS = {
  index: (name: string) => ({
    index_patterns: [`${name || 'logs'}-*`],
    priority: 100,
    template: {
      settings: { number_of_shards: 1, number_of_replicas: 1 },
      mappings: { properties: { '@timestamp': { type: 'date' }, message: { type: 'text' } } },
      aliases: {}
    },
    composed_of: [],
    _meta: { description: '' }
  }),
  component: () => ({ template: { mappings: { properties: {} } }, _meta: { description: '' } })
}

/** Create an index or component template from a JSON body (PUT _index_template / _component_template). */
export function CreateTemplateModal({ conn, kind, existing, onClose, onCreated }: { conn: ConnectionConfig; kind: 'index' | 'component'; existing: string[]; onClose(): void; onCreated(name: string): void }) {
  const [name, setName] = useState('')
  const [text, setText] = useState(() => JSON.stringify(STARTERS[kind](''), null, 2))
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameError = !name.trim()
    ? null
    : !/^[a-z0-9][a-z0-9._-]*$/.test(name.trim())
      ? 'Use lowercase letters, numbers, dots, dashes and underscores'
      : existing.includes(name.trim())
        ? 'A template with that name exists — open it to edit it'
        : null

  const create = async () => {
    setError(null)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch (e) {
      return setError(`Invalid JSON: ${(e as Error).message}`)
    }
    setBusy(true)
    try {
      const n = name.trim()
      const res = await api.cluster.request({ connectionId: conn.id, method: 'PUT', path: `${kind === 'index' ? '_index_template' : '_component_template'}/${encodeURIComponent(n)}`, body: JSON.stringify(body) })
      if (res.status >= 400) return setError(reason(res.body))
      await refreshConnection(conn.id)
      useApp.getState().showToast(`Created ${kind} template ${n}`)
      onCreated(n)
    } catch (e) {
      setError(e instanceof KabanosError && e.code === 'NOT_CONFIRMED' ? 'Not created — confirmation declined' : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={kind === 'index' ? 'New index template' : 'New component template'}
      width={720}
      onClose={onClose}
      actions={
        <>
          {error && <span className="hint error left">{error}</span>}
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" disabled={busy || !name.trim() || !!nameError} onClick={create}>
            {busy ? 'Creating…' : 'Create template'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="tpl-name">Name</label>
        <input
          id="tpl-name"
          className="input mono"
          autoFocus
          value={name}
          placeholder={kind === 'index' ? 'logs-template' : 'base-settings'}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value)
            // Until the body is edited, keep the starter's index pattern in step with the name.
            if (!touched && kind === 'index') setText(JSON.stringify(STARTERS.index(e.target.value.trim().replace(/[-_]?template$/, '')), null, 2))
          }}
        />
        {nameError && <span className="hint error">{nameError}</span>}
      </div>
      <span className="hint">
        {kind === 'index'
          ? 'Applies to indices created from now on whose names match index_patterns. composed_of lists component templates to include.'
          : 'A reusable block of settings, mappings and aliases that index templates include through composed_of.'}
      </span>
      <div className="editor-box" style={{ height: 360 }}>
        <CodeEditor
          value={text}
          onChange={(v) => {
            setTouched(true)
            setText(v)
          }}
          path={`template://new/${kind}`}
        />
      </div>
    </Modal>
  )
}
