import { describe, expect, it } from 'vitest'
import { treeCounts, type ClusterTree, type IndexSummary, type TemplateSummary } from '../meta'

const idx = (name: string, over: Partial<IndexSummary> = {}): IndexSummary => ({ name, health: 'green', status: 'open', docs: 0, storeBytes: 0, primaries: 1, replicas: 0, hidden: name.startsWith('.'), ...over })
const tpl = (name: string, kind: 'index' | 'component', managed = false): TemplateSummary => ({ name, kind, patterns: [], composedOf: [], dataStream: false, managed, body: {} })

describe('treeCounts', () => {
  it('matches what the tree shows with "Hide system" on', () => {
    const t: ClusterTree = {
      health: 'green',
      nodes: 3,
      indices: [idx('jobs_v7'), idx('skills_v1'), idx('.kibana_1'), idx('.ds-logs-x-000001', { hidden: true, dataStream: 'logs-x' })],
      aliases: [
        { name: 'jobs_alias_r', indices: [{ index: 'jobs_v7', isWriteIndex: false, filter: false }] },
        { name: '.kibana', indices: [{ index: '.kibana_1', isWriteIndex: true, filter: false }] },
        { name: '.security', indices: [{ index: '.security-7', isWriteIndex: false, filter: false }] }
      ],
      dataStreams: [
        { name: 'my-stream', indices: [], health: 'green', hidden: false },
        { name: 'ilm-history-7', indices: [], health: 'green', hidden: true }
      ],
      templates: [tpl('jobs', 'index'), tpl('logs', 'index', true), tpl('metrics-apm.app@template', 'index'), tpl('agentless', 'index', true), tpl('base', 'component'), tpl('logs@mappings', 'component', true)],
      fetchedAt: 0
    }
    expect(treeCounts(t)).toEqual({
      shown: { indices: 2, dataStreams: 1, aliases: 1, indexTemplates: 1, componentTemplates: 1 },
      system: { indices: 2, dataStreams: 1, aliases: 2, indexTemplates: 3, componentTemplates: 1 }
    })
  })
})
