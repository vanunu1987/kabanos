import type { ReactNode } from 'react'

/** Loading / error / content switch for query results. */
export function Async<T>({ query, children }: { query: { data?: T; error: unknown; isLoading: boolean }; children(data: T): ReactNode }) {
  if (query.isLoading) {
    return (
      <div className="loading">
        <span className="spin" /> Loading…
      </div>
    )
  }
  if (query.error) return <div className="error-box">{(query.error as Error).message}</div>
  if (query.data === undefined) return null
  return <>{children(query.data)}</>
}
