import { useEffect, useMemo, useState } from 'react'
import { maskUrlPassword } from '@shared/connectionUrl'
import type { AuthKind, ColorTag, TestResult } from '@shared/types'
import { api } from '../../api'
import { EngineBadge } from '../../components/EngineBadge'
import { Icon } from '../../shell/icons'
import { COLORS, useApp } from '../../store'
import { ConnectionsSidebar } from './ConnectionsSidebar'
import { awsFromHost, draftFrom, emptyDraft, suggestName, toInput, tryDecodeCloudId, tryParseUrl, type Draft } from './draft'

const AUTH_TABS: Array<{ kind: AuthKind; label: string; disabled?: string }> = [
  { kind: 'url', label: 'From URL' },
  { kind: 'basic', label: 'Basic' },
  { kind: 'apikey', label: 'API key' },
  { kind: 'sigv4', label: 'AWS SigV4' },
  { kind: 'cloudid', label: 'Cloud ID' },
  { kind: 'none', label: 'None' }
]
const COLOR_NAMES: ColorTag[] = ['amber', 'red', 'teal', 'blue', 'green']
const DEFAULT_FOLDERS = ['Production', 'Staging', 'Local']

type TestState = { state: 'idle' } | { state: 'running' } | ({ state: 'done' } & TestResult)

export function ConnectionsScreen() {
  const connections = useApp((s) => s.connections)
  const editingId = useApp((s) => s.editingId)
  const formNonce = useApp((s) => s.formNonce)
  const editing = connections.find((c) => c.id === editingId)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const [advanced, setAdvanced] = useState(false)
  const [urlFocused, setUrlFocused] = useState(false)
  const [busy, setBusy] = useState(false)

  // Reset the form when switching between connections (not on every list refresh).
  useEffect(() => {
    setDraft(editing ? draftFrom(editing) : emptyDraft())
    setTest({ state: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, formNonce])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value }
      // An *.amazonaws.com endpoint implies SigV4 with its region and service.
      if (key === 'url') {
        const aws = awsFromHost(tryParseUrl(String(value)).parsed?.host ?? '')
        if (aws && !d.awsRegion) Object.assign(next, { authKind: 'sigv4', awsRegion: aws.region, awsService: aws.service })
      }
      // Production folder or red tag implies production, until the user sets it explicitly.
      if (!next.prodTouched && (key === 'folder' || key === 'color')) next.isProd = next.folder === 'Production' || next.color === 'red'
      return next
    })

  const url = useMemo(() => tryParseUrl(draft.url), [draft.url])
  const cloud = useMemo(() => tryDecodeCloudId(draft.cloudId), [draft.cloudId])
  const folders = useMemo(() => [...new Set([...DEFAULT_FOLDERS, ...connections.map((c) => c.folder)])], [connections])

  const validation = ((): string | null => {
    if (draft.authKind === 'cloudid') return cloud.error ?? (draft.cloudId.trim() ? null : 'Enter a Cloud ID')
    if (!draft.url.trim()) return 'Enter a connection URL'
    if (url.error) return url.error
    if (draft.authKind === 'sigv4' && !draft.awsRegion.trim()) return 'Enter the AWS region'
    return null
  })()

  const runTest = async () => {
    setTest({ state: 'running' })
    try {
      const result = await api.connections.test({ input: toInput(draft) })
      setTest({ state: 'done', ...result })
    } catch (e) {
      setTest({ state: 'done', ok: false, error: (e as Error).message })
    }
  }

  const save = async (connect: boolean) => {
    setBusy(true)
    try {
      const saved = await api.connections.save(toInput(draft))
      const { refresh, edit, openTab, setView, showToast } = useApp.getState()
      if (connect) {
        try {
          await api.connections.connect(saved.id)
          await refresh()
          openTab(saved.id)
          setView('explorer')
        } catch (e) {
          await refresh()
          edit(saved.id)
          setTest({ state: 'done', ok: false, error: (e as Error).message })
        }
      } else {
        await refresh()
        edit(saved.id)
        showToast('Connection saved')
      }
    } catch (e) {
      setTest({ state: 'done', ok: false, error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editing || !confirm(`Delete connection "${editing.name}"? Its stored credentials are removed too.`)) return
    await api.connections.remove(editing.id)
    const { refresh, edit, closeTab } = useApp.getState()
    closeTab(editing.id)
    edit(null)
    await refresh()
  }

  const pickCa = async () => {
    const path = await api.connections.pickCaFile()
    if (path) set('caPath', path)
  }

  const passwordPlaceholder = draft.hasPassword ? 'Stored in Keychain — leave blank to keep' : ''
  const apiKeyPlaceholder = draft.hasApiKey ? 'Stored in Keychain — leave blank to keep' : 'id:key or the base64 "encoded" value'
  const detected = test.state === 'done' && test.ok ? test.detected : editing?.detected

  return (
    <>
      <ConnectionsSidebar />
      <main className="main">
        <div className="conn-page">
          <div className="conn-form">
            <div>
              <h1>{editing ? editing.name : 'New connection'}</h1>
              <p className="lede">
                Paste a cluster URL. Username and password inside the URL are split out and stored in the macOS Keychain — never in plain text.
              </p>
            </div>

            {draft.authKind === 'cloudid' ? (
              <div className="field">
                <label htmlFor="cloudid">Cloud ID</label>
                <input id="cloudid" className={`url-input${cloud.error ? ' invalid' : ''}`} value={draft.cloudId} onChange={(e) => set('cloudId', e.target.value)} placeholder="my-deployment:ZXUtd2VzdC0xLmF3cy5mb3VuZC5pbyQ…" spellCheck={false} />
                {cloud.error ? <span className="hint error">{cloud.error}</span> : cloud.esUrl && <span className="hint mono">→ {cloud.esUrl}</span>}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="url">Connection URL</label>
                <div className="row">
                  <div className="url-wrap">
                    {/* The input always holds the raw URL; when unfocused, an overlay shows it with the password masked. */}
                    <input
                      id="url"
                      className={`url-input${url.error ? ' invalid' : ''}${!urlFocused && url.parsed?.password ? ' masked' : ''}`}
                      value={draft.url}
                      onFocus={() => setUrlFocused(true)}
                      onBlur={() => setUrlFocused(false)}
                      onChange={(e) => set('url', e.target.value)}
                      placeholder="https://user:password@host:9200"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {!urlFocused && url.parsed?.password && (
                      <span className="url-mask mono" aria-hidden>
                        {maskUrlPassword(draft.url)}
                      </span>
                    )}
                  </div>
                  <button className="btn tall" onClick={async () => set('url', (await navigator.clipboard.readText()).trim())}>
                    Paste from clipboard
                  </button>
                </div>
                {url.error && <span className="hint error">{url.error}</span>}
                {url.parsed && (
                  <div className="parts">
                    <Part label="Scheme" value={url.parsed.scheme} />
                    <Part label="Host" value={url.parsed.host + url.parsed.pathPrefix} wide />
                    <Part label="Port" value={`${url.parsed.port}${url.parsed.portExplicit ? '' : ' (default)'}`} />
                    <Part label="User" value={url.parsed.username ?? (draft.authKind === 'basic' ? draft.username || '—' : '—')} />
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <div className="field-label">Authentication</div>
              <div role="group" aria-label="Authentication method" className="segmented">
                {AUTH_TABS.map((t) => (
                  <button key={t.kind} className={draft.authKind === t.kind ? 'on' : ''} onClick={() => set('authKind', t.kind)} disabled={!!t.disabled} title={t.disabled}>
                    {t.label}
                  </button>
                ))}
              </div>
              <AuthFields draft={draft} set={set} passwordPlaceholder={passwordPlaceholder} apiKeyPlaceholder={apiKeyPlaceholder} urlHasCreds={!!url.parsed?.username} />
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="cname">Name</label>
                <input id="cname" className="input" value={draft.name} placeholder={suggestName(draft) || 'Search · Production'} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="folder">Folder</label>
                <input id="folder" className="input" list="folders" value={draft.folder} onChange={(e) => set('folder', e.target.value)} />
                <datalist id="folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="engine">Engine</label>
                <select id="engine" className="select" value={draft.engine} onChange={(e) => set('engine', e.target.value as Draft['engine'])}>
                  <option value="auto">Auto-detect (Elasticsearch / OpenSearch)</option>
                  <option value="elasticsearch">Elasticsearch</option>
                  <option value="opensearch">OpenSearch</option>
                </select>
              </div>
              <div className="field">
                <div className="field-label">Color tag</div>
                <div className="swatches">
                  {COLOR_NAMES.map((c) => (
                    <button key={c} aria-label={c} aria-pressed={draft.color === c} className={`swatch${draft.color === c ? ' on' : ''}`} style={{ background: COLORS[c] }} onClick={() => set('color', c)} />
                  ))}
                  <button className={`icon-btn`} aria-pressed={draft.favorite} title={draft.favorite ? 'Remove from favorites' : 'Add to favorites'} style={{ color: draft.favorite ? 'var(--accent)' : undefined, marginLeft: 6 }} onClick={() => set('favorite', !draft.favorite)}>
                    {Icon.star(16, draft.favorite)}
                  </button>
                </div>
              </div>
            </div>

            <div className="panel">
              <label className="check">
                <input type="checkbox" checked={draft.isProd} onChange={(e) => setDraft((d) => ({ ...d, isProd: e.target.checked, prodTouched: true }))} />
                <span>
                  Production <span className="sub">— warning stripe on the tab, confirm before any write</span>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.tlsVerify} onChange={(e) => set('tlsVerify', e.target.checked)} />
                Verify TLS certificate
              </label>
              <div className="inline">
                <span>Custom CA certificate</span>
                <button className="btn sm" onClick={pickCa}>
                  Choose file…
                </button>
                <span className="mono" style={{ fontSize: 12 }}>
                  {draft.caPath ? draft.caPath.split('/').pop() : 'none'}
                </span>
                {draft.caPath && (
                  <button className="link-btn" onClick={() => set('caPath', '')}>
                    Clear
                  </button>
                )}
              </div>
              <button className={`disclosure${advanced ? ' open' : ''}`} onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
                {Icon.chevronRight()}Advanced — SSH tunnel / proxy, fingerprint pinning, timeouts, compression, default headers, read-only mode
              </button>
              {advanced && <Advanced draft={draft} set={set} />}
            </div>

            <TestStatus test={test} />

            <div className="actions">
              {editing && (
                <button className="btn danger left" onClick={remove}>
                  Delete
                </button>
              )}
              <button className="btn" onClick={runTest} disabled={!!validation || test.state === 'running'} title={validation ?? undefined}>
                Test connection
              </button>
              <button className="btn" onClick={() => save(false)} disabled={!!validation || busy} title={validation ?? undefined}>
                Save
              </button>
              <button className="btn primary" onClick={() => save(true)} disabled={!!validation || busy} title={validation ?? undefined}>
                Save &amp; connect
              </button>
            </div>
          </div>

          <div className="aside">
            <div className="eyebrow">Engine detection</div>
            <div className="info-card">
              <div className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>
                GET /
              </div>
              <div>
                Reads <span className="code-str">version.distribution</span>. When it says <span className="code-str">opensearch</span> the tab gets an OS badge, autocomplete
                switches to OpenSearch endpoints, and user management uses the Security plugin API.
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className="badge es lg">ES 7.x · 8.x · 9.x</span>
                <span className="badge os lg">OS 1.x · 2.x · 3.x</span>
              </div>
            </div>
            {detected && (
              <>
                <div className="eyebrow" style={{ marginTop: 12 }}>
                  Detected
                </div>
                <div className="info-card">
                  <dl className="kv" style={{ margin: 0 }}>
                    <dt>Engine</dt>
                    <dd>
                      <EngineBadge conn={{ detected, engine: 'auto' }} />
                    </dd>
                    <dt>Version</dt>
                    <dd>{detected.version}</dd>
                    {detected.clusterName && (
                      <>
                        <dt>Cluster</dt>
                        <dd>{detected.clusterName}</dd>
                      </>
                    )}
                    {detected.flavor !== 'default' && (
                      <>
                        <dt>Flavor</dt>
                        <dd>{detected.flavor === 'aws' ? 'Amazon OpenSearch (compat mode)' : 'Serverless'}</dd>
                      </>
                    )}
                  </dl>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </>
  )
}

function Part({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`part${wide ? ' wide' : ''}`}>
      <span className="part-label">{label}</span>
      <span className="part-value" title={value}>
        {value}
      </span>
    </div>
  )
}

type Setter = <K extends keyof Draft>(key: K, value: Draft[K]) => void

function AuthFields({ draft, set, passwordPlaceholder, apiKeyPlaceholder, urlHasCreds }: { draft: Draft; set: Setter; passwordPlaceholder: string; apiKeyPlaceholder: string; urlHasCreds: boolean }) {
  const basicFields = (
    <div className="grid-2">
      <div className="field">
        <label htmlFor="user">Username</label>
        <input id="user" className="input" value={draft.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="pass">Password</label>
        <input id="pass" className="input" type="password" value={draft.password} placeholder={passwordPlaceholder} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
      </div>
    </div>
  )
  const apiKeyField = (
    <div className="field">
      <label htmlFor="apikey">API key</label>
      <input id="apikey" className="input mono" type="password" value={draft.apiKey} placeholder={apiKeyPlaceholder} onChange={(e) => set('apiKey', e.target.value)} autoComplete="off" />
    </div>
  )
  switch (draft.authKind) {
    case 'url':
      return (
        <span className="hint">
          {urlHasCreds
            ? draft.hasPassword
              ? 'Using the username from the URL. The stored password is kept unless you type a new one in the URL.'
              : 'Username and password are taken from the URL.'
            : 'No credentials in the URL — the cluster will be called anonymously. Add user:password@ or pick Basic / API key.'}
        </span>
      )
    case 'basic':
      return basicFields
    case 'apikey':
      return apiKeyField
    case 'sigv4':
      return (
        <div className="grid-3">
          <div className="field">
            <label htmlFor="aws-region">Region</label>
            <input id="aws-region" className="input mono" value={draft.awsRegion} onChange={(e) => set('awsRegion', e.target.value)} placeholder="eu-west-1" />
          </div>
          <div className="field">
            <label htmlFor="aws-service">Service</label>
            <select id="aws-service" className="select" value={draft.awsService} onChange={(e) => set('awsService', e.target.value as Draft['awsService'])}>
              <option value="es">OpenSearch Service (es)</option>
              <option value="aoss">OpenSearch Serverless (aoss)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="aws-profile">AWS profile</label>
            <input id="aws-profile" className="input mono" value={draft.awsProfile} onChange={(e) => set('awsProfile', e.target.value)} placeholder="default chain" />
          </div>
          <span className="hint" style={{ gridColumn: 'span 3' }}>
            Credentials come from your AWS setup (environment, ~/.aws profiles, SSO, instance role) — kabanos never stores them.
          </span>
        </div>
      )
    case 'cloudid':
      return (
        <>
          {apiKeyField}
          <span className="hint">Or use a username and password instead of an API key:</span>
          {basicFields}
        </>
      )
    default:
      return null
  }
}

function Advanced({ draft, set }: { draft: Draft; set: Setter }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
      <div className="field">
        <label htmlFor="fp">CA / certificate SHA-256 fingerprint</label>
        <input id="fp" className="input mono" value={draft.fingerprint} onChange={(e) => set('fingerprint', e.target.value)} placeholder="AA:BB:CC:… (printed by Elasticsearch 8 on first start)" spellCheck={false} />
        <span className="hint">When set, the connection is trusted only if the server's certificate chain contains this fingerprint — works with self-signed clusters.</span>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="timeout">Request timeout (seconds)</label>
          <input id="timeout" className="input" type="number" min={1} max={3600} value={draft.timeoutSec} onChange={(e) => set('timeoutSec', Number(e.target.value) || 30)} />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <label className="check" style={{ height: 38 }}>
            <input type="checkbox" checked={draft.compression} onChange={(e) => set('compression', e.target.checked)} />
            Accept gzip-compressed responses
          </label>
        </div>
      </div>
      <div className="field">
        <label htmlFor="headers">Default headers</label>
        <textarea id="headers" className="input mono" style={{ height: 70, padding: 10, resize: 'vertical' }} value={draft.headers} onChange={(e) => set('headers', e.target.value)} placeholder={'X-Tenant: search\nX-Custom: value'} spellCheck={false} />
      </div>
      <label className="check">
        <input type="checkbox" checked={draft.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
        <span>
          Read-only mode <span className="sub">— block everything except reads (GET/HEAD, _search, _count, …)</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.sshEnabled} onChange={(e) => set('sshEnabled', e.target.checked)} />
        <span>
          Connect through an SSH tunnel <span className="sub">— for clusters only reachable from a bastion host</span>
        </span>
      </label>
      {draft.sshEnabled && (
        <div className="ssh-box">
          <div className="grid-3">
            <div className="field">
              <label htmlFor="ssh-host">SSH host</label>
              <input id="ssh-host" className="input mono" value={draft.sshHost} onChange={(e) => set('sshHost', e.target.value)} placeholder="bastion.corp" />
            </div>
            <div className="field">
              <label htmlFor="ssh-port">Port</label>
              <input id="ssh-port" className="input mono" type="number" value={draft.sshPort} onChange={(e) => set('sshPort', Number(e.target.value) || 22)} />
            </div>
            <div className="field">
              <label htmlFor="ssh-user">SSH user</label>
              <input id="ssh-user" className="input mono" value={draft.sshUser} onChange={(e) => set('sshUser', e.target.value)} />
            </div>
          </div>
          <div role="group" aria-label="SSH authentication" className="segmented">
            {(['key', 'agent', 'password'] as const).map((a) => (
              <button key={a} className={draft.sshAuth === a ? 'on' : ''} onClick={() => set('sshAuth', a)}>
                {a === 'key' ? 'Private key' : a === 'agent' ? 'SSH agent' : 'Password'}
              </button>
            ))}
          </div>
          {draft.sshAuth === 'key' && (
            <div className="grid-2">
              <div className="field">
                <label htmlFor="ssh-key">Key file</label>
                <input id="ssh-key" className="input mono" value={draft.sshKeyPath} onChange={(e) => set('sshKeyPath', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ssh-pp">Key passphrase</label>
                <input id="ssh-pp" className="input" type="password" value={draft.sshPassphrase} onChange={(e) => set('sshPassphrase', e.target.value)} placeholder={draft.hasSshPassphrase ? 'Stored in Keychain — leave blank to keep' : 'none'} />
              </div>
            </div>
          )}
          {draft.sshAuth === 'password' && (
            <div className="field">
              <label htmlFor="ssh-pass">SSH password</label>
              <input id="ssh-pass" className="input" type="password" value={draft.sshPassword} onChange={(e) => set('sshPassword', e.target.value)} placeholder={draft.hasSshPassword ? 'Stored in Keychain — leave blank to keep' : ''} />
            </div>
          )}
          <span className="hint">The cluster URL above is resolved from the SSH host. TLS is still verified against the cluster's own hostname.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="proxy">HTTP(S) proxy</label>
        <input id="proxy" className="input mono" value={draft.proxy} onChange={(e) => set('proxy', e.target.value)} placeholder="http://proxy.corp:3128 (optional)" disabled={draft.sshEnabled} />
      </div>
    </div>
  )
}

function TestStatus({ test }: { test: TestState }) {
  if (test.state === 'idle') return null
  if (test.state === 'running')
    return (
      <div className="status pending" role="status">
        <span className="spin" />
        <span>Testing connection…</span>
      </div>
    )
  if (!test.ok)
    return (
      <div className="status err" role="alert">
        <span className="dot" style={{ width: 10, height: 10, borderRadius: 5, background: 'var(--red)' }} />
        <div className="status-text">
          <span className="status-title">Connection failed</span>
          <span className="status-sub">{test.error}</span>
        </div>
      </div>
    )
  const d = test.detected!
  const h = test.health
  const engineName = d.engine === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'
  const parts = [
    d.clusterName && `cluster ${d.clusterName}`,
    h && `status ${h.status}`,
    h && `${h.nodes} node${h.nodes === 1 ? '' : 's'}`,
    h?.indices !== undefined && plural(h.indices, 'index', 'indices'),
    h?.aliases !== undefined && plural(h.aliases, 'alias', 'aliases'),
    h?.templates !== undefined && plural(h.templates, 'index template', 'index templates')
  ].filter(Boolean)
  const color = h?.status === 'yellow' ? 'var(--yellow)' : h?.status === 'red' ? 'var(--red)' : 'var(--green)'
  return (
    <div className="status ok" role="status">
      <span className="dot" style={{ width: 10, height: 10, borderRadius: 5, background: color }} />
      <div className="status-text">
        <span className="status-title">
          Connected · {engineName} {d.version}
          {test.ms !== undefined && <span style={{ color: 'var(--ok-text)', fontWeight: 400 }}> · {test.ms} ms</span>}
        </span>
        <span className="status-sub">{parts.join(' · ')}</span>
      </div>
    </div>
  )
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
