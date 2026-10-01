import type { KabanosErrorCode } from '@shared/types'

export class KabanosError extends Error {
  constructor(
    readonly code: KabanosErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'KabanosError'
  }
}
