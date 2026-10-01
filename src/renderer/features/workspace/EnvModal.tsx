import { useEffect, useState } from 'react'
import type { Environment } from '@shared/library'
import { api } from '../../api'
import { Modal } from '../../components/Modal'

type Draft = { id?: string; name: string; vars: Environment['vars'] }

/** Environments: named sets of {{variables}}. Secret values are encrypted and never shown again. */
export function EnvModal({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const [envs, setEnvs] = useState<Environment[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const reload = async () => setEnvs(await api.env.list())
  useEffect(() => {
    void reload()
  }, [])

  const save = async () => {
    if (!draft) return
    await api.env.save(draft)
    await reload()
    setDraft(null)
    onChanged()
  }

  return (
    <Modal
      title="Environments"
      width={640}
      onClose={onClose}
      actions={
        draft ? (
          <>
            <button className="btn md" onClick={() => setDraft(null)}>
              Back
            </button>
            <button className="btn md primary" onClick={save} disabled={!draft.name.trim()}>
              Save environment
            </button>
          </>
        ) : (
          <>
            <button className="btn md" onClick={() => setDraft({ name: '', vars: [{ key: '', value: '', secret: false }] })}>
              New environment
            </button>
            <button className="btn md primary" onClick={onClose}>
              Done
            </button>
          </>
        )
      }
    >
      {!draft ? (
        <>
          <span>
            Use <span className="mono ts">{'{{name}}'}</span> anywhere in a request path or body. Values are filled in when the request runs, using the environment picked in the
            workspace toolbar.
          </span>
          {envs.length === 0 && <span className="hint">No environments yet.</span>}
          {envs.map((e) => (
            <div key={e.id} className="inline-row between env-row">
              <span>
                <b>{e.name}</b> <span className="hint">· {e.vars.length} variables</span>
              </span>
              <span style={{ display: 'flex', gap: 10 }}>
                <button className="link" onClick={() => setDraft({ id: e.id, name: e.name, vars: e.vars })}>
                  Edit
                </button>
                <button
                  className="link danger-text"
                  onClick={async () => {
                    if (!confirm(`Delete environment "${e.name}"?`)) return
                    await api.env.remove(e.id)
                    await reload()
                    onChanged()
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </>
      ) : (
        <>
          <input className="input" autoFocus placeholder="Environment name (e.g. prod)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Environment name" />
          <div className="env-vars">
            {draft.vars.map((v, i) => (
              <div key={i} className="env-var">
                <input className="input mono" placeholder="name" value={v.key} onChange={(e) => setDraft({ ...draft, vars: draft.vars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} aria-label="Variable name" />
                <input
                  className="input mono"
                  type={v.secret ? 'password' : 'text'}
                  placeholder={v.secret && v.key && !v.value ? 'stored — leave blank to keep' : 'value'}
                  value={v.value}
                  onChange={(e) => setDraft({ ...draft, vars: draft.vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  aria-label="Variable value"
                />
                <label className="check" title="Encrypt with the Keychain and hide the value">
                  <input type="checkbox" checked={v.secret} onChange={(e) => setDraft({ ...draft, vars: draft.vars.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)) })} />
                  secret
                </label>
                <button className="icon-btn xs" aria-label="Remove variable" onClick={() => setDraft({ ...draft, vars: draft.vars.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <button className="link left" onClick={() => setDraft({ ...draft, vars: [...draft.vars, { key: '', value: '', secret: false }] })}>
            + Add variable
          </button>
        </>
      )}
    </Modal>
  )
}
