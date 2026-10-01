import type { HttpMethod } from '@shared/types'
import { api, KabanosError } from '../../api'
import { refreshConnection } from '../../queries'
import { useApp } from '../../store'

/**
 * Run an index-level admin request. Production confirmation happens in main;
 * a declined confirmation is silent, errors surface as a toast.
 */
export async function runIndexAction(connectionId: string, method: HttpMethod, path: string, done: string): Promise<boolean> {
  const { showToast } = useApp.getState()
  try {
    const res = await api.cluster.request({ connectionId, method, path })
    if (res.status >= 400) {
      showToast(`${method} ${path} failed: ${reason(res.body)}`)
      return false
    }
    showToast(done)
    await refreshConnection(connectionId)
    return true
  } catch (e) {
    if (e instanceof KabanosError && e.code === 'NOT_CONFIRMED') return false
    showToast((e as Error).message)
    return false
  }
}

export function reason(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { reason?: string; type?: string } | string }
    return typeof j.error === 'string' ? j.error : (j.error?.reason ?? j.error?.type ?? body.slice(0, 160))
  } catch {
    return body.slice(0, 160)
  }
}
