export interface MainNativeActionLease {
  release(): void
}

/** Main-owned quit admission. Consent waits occur before acquisition. */
export class MainNativeActionGate {
  private closed = false
  private readonly operations = new Set<symbol>()
  private readonly waiters = new Set<() => void>()

  beginShutdown(): void {
    this.closed = true
  }

  tryEnter(label: string): MainNativeActionLease | null {
    if (this.closed) return null
    const token = Symbol(label)
    this.operations.add(token)
    return {
      release: () => {
        if (!this.operations.delete(token) || this.operations.size !== 0) return
        for (const resolve of this.waiters) resolve()
        this.waiters.clear()
      }
    }
  }

  /** Close admission first to establish a final-producer boundary. */
  join(): Promise<void> {
    if (!this.closed)
      return Promise.reject(new Error('Close native action admission before joining'))
    if (this.operations.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiters.add(resolve))
  }

  snapshot(): { closed: boolean; inFlight: number } {
    return { closed: this.closed, inFlight: this.operations.size }
  }
}
