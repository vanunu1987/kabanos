import { QueryClient, useQuery } from '@tanstack/react-query'
import { api } from './api'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } }
})

export const keys = {
  tree: (id: string) => ['tree', id] as const,
  index: (id: string, name: string) => ['index', id, name] as const,
  alias: (id: string, name: string) => ['alias', id, name] as const,
  fields: (id: string, target: string) => ['fields', id, target] as const
}

export function useTree(connectionId: string) {
  return useQuery({ queryKey: keys.tree(connectionId), queryFn: () => api.meta.tree(connectionId) })
}
export function useIndexDetail(connectionId: string, name: string) {
  return useQuery({ queryKey: keys.index(connectionId, name), queryFn: () => api.meta.index(connectionId, name) })
}
export function useAliasDetail(connectionId: string, name: string) {
  return useQuery({ queryKey: keys.alias(connectionId, name), queryFn: () => api.meta.alias(connectionId, name) })
}
export function useFields(connectionId: string, target: string | undefined) {
  return useQuery({ queryKey: keys.fields(connectionId, target ?? ''), queryFn: () => api.meta.fields(connectionId, target!), enabled: !!target, staleTime: 60_000 })
}

/** Force-reload everything for a connection (manual refresh or after a write). */
export async function refreshConnection(connectionId: string): Promise<void> {
  await api.meta.tree(connectionId, true)
  await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === connectionId })
}
