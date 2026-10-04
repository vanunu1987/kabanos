import { useEffect, useState } from 'react'
import type { Folder } from '@shared/library'
import { api } from '../../api'
import { Modal } from '../../components/Modal'
import { useApp } from '../../store'

/** Title + folder + tags picker used by "Save to library" (Index view) and "Save to folder…" (Workspace). */
export function SaveQueryModal({ connectionId, initial, onSave, onClose }: { connectionId: string; initial: { title: string; folderId: string | null; tags: string[] }; onSave(v: { title: string; folderId: string | null; tags: string[] }): void; onClose(): void }) {
  const conn = useApp((s) => s.connections.find((c) => c.id === connectionId))
  const [folders, setFolders] = useState<Folder[]>([])
  const [title, setTitle] = useState(initial.title)
  const [folderId, setFolderId] = useState<string | null>(initial.folderId)
  const [tags, setTags] = useState(initial.tags.map((t) => `#${t}`).join(' '))
  const [newFolder, setNewFolder] = useState('')

  useEffect(() => {
    void api.library.folders(connectionId).then((f) => {
      setFolders(f)
      if (!initial.folderId && f[0]) setFolderId(f[0].id)
    })
  }, [initial.folderId, connectionId])

  const save = async () => {
    let fid = folderId
    if (newFolder.trim()) fid = (await api.library.createFolder(connectionId, newFolder.trim(), null)).id
    onSave({ title: title.trim(), folderId: fid, tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean) })
  }
  const paths = folderPaths(folders)

  return (
    <Modal
      title={conn ? `Save to ${conn.name}’s library` : 'Save to library'}
      onClose={onClose}
      actions={
        <>
          <button className="btn md" onClick={onClose}>
            Cancel
          </button>
          <button className="btn md primary" onClick={save} disabled={!title.trim() || (!folderId && !newFolder.trim())}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="q-title">Name</label>
        <input id="q-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Top cities by listings" onKeyDown={(e) => e.key === 'Enter' && save()} />
      </div>
      <div className="field">
        <label htmlFor="q-folder">Folder</label>
        {folders.length > 0 && (
          <select id="q-folder" className="select" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value || null)} disabled={!!newFolder.trim()}>
            {paths.map((f) => (
              <option key={f.id} value={f.id}>
                {f.path}
              </option>
            ))}
          </select>
        )}
        <input className="input" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder={folders.length ? 'or a new folder name' : 'New folder name'} aria-label="New folder" />
      </div>
      <div className="field">
        <label htmlFor="q-tags">Tags</label>
        <input id="q-tags" className="input mono" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#relevance #ops" />
      </div>
    </Modal>
  )
}

export function folderPaths(folders: Folder[]): Array<{ id: string; path: string; depth: number }> {
  const byParent = new Map<string | null, Folder[]>()
  for (const f of folders) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f])
  const out: Array<{ id: string; path: string; depth: number }> = []
  const walk = (parent: string | null, prefix: string, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name
      out.push({ id: f.id, path, depth })
      walk(f.id, path, depth + 1)
    }
  }
  walk(null, '', 0)
  return out
}
