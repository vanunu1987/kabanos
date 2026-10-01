import type { KabanosApi } from '@shared/ipc'

export class KabanosError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'KabanosError'
  }
}

/** Typed client over the preload's single invoke channel: `api.connections.list()` → `'connections.list'`. */
export const api = new Proxy({} as KabanosApi, {
  get: (_t, ns: string) =>
    new Proxy(
      {},
      {
        get:
          (_t2, name: string) =>
          async (...args: unknown[]) => {
            const res = await window.kabanosIpc.invoke(`${ns}.${name}`, args)
            if (!res.ok) throw new KabanosError(res.error.code, res.error.message)
            return res.value
          }
      }
    )
})
