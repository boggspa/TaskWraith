export interface CodexClientRunCohortLease<T> {
  readonly resource: T
  release(): Promise<void>
}

interface ActiveCohort<T> {
  readonly compatibilityKey: string
  readonly resource: T
  readonly owners: Set<string>
  readonly close: () => Promise<void>
  readonly afterClose: () => Promise<void>
  accepting: boolean
  closing: Promise<void> | null
}

/**
 * Shares one already-compatible Codex app-server across distinct native
 * threads while retaining an exact final teardown boundary.
 *
 * Compatibility is decided by the caller from the full process-lifetime
 * configuration. A mismatched or contended cohort is never retargeted in
 * place: callers close admission, wait for its last owner, then perform the
 * ordinary serialized owner transition.
 */
export class CodexClientRunCohortRegistry<T> {
  private active: ActiveCohort<T> | null = null

  tryJoin(ownerId: string, compatibilityKey: string): CodexClientRunCohortLease<T> | null {
    const owner = normalizedIdentity(ownerId, 'owner')
    const key = normalizedIdentity(compatibilityKey, 'compatibility key')
    const cohort = this.active
    if (!cohort || !cohort.accepting || cohort.compatibilityKey !== key) return null
    if (cohort.owners.has(owner)) {
      throw new Error(`Codex run ${owner} already owns the compatible client cohort.`)
    }
    cohort.owners.add(owner)
    return this.leaseFor(cohort, owner)
  }

  /** Borrow the current process for a configuration-neutral read-only RPC. */
  tryBorrow(ownerId: string): CodexClientRunCohortLease<T> | null {
    const owner = normalizedIdentity(ownerId, 'owner')
    const cohort = this.active
    if (!cohort || !cohort.accepting) return null
    if (cohort.owners.has(owner)) {
      throw new Error(`Codex run ${owner} already owns the compatible client cohort.`)
    }
    cohort.owners.add(owner)
    return this.leaseFor(cohort, owner)
  }

  open(
    ownerId: string,
    compatibilityKey: string,
    resource: T,
    close: () => Promise<void>,
    afterClose: () => Promise<void> | void = () => undefined
  ): CodexClientRunCohortLease<T> {
    const owner = normalizedIdentity(ownerId, 'owner')
    const key = normalizedIdentity(compatibilityKey, 'compatibility key')
    if (this.active) throw new Error('A Codex client cohort is already active.')
    const cohort: ActiveCohort<T> = {
      compatibilityKey: key,
      resource,
      owners: new Set([owner]),
      close,
      afterClose: async () => afterClose(),
      accepting: true,
      closing: null
    }
    this.active = cohort
    return this.leaseFor(cohort, owner)
  }

  stopAccepting(): void {
    if (this.active) this.active.accepting = false
  }

  private leaseFor(cohort: ActiveCohort<T>, owner: string): CodexClientRunCohortLease<T> {
    let released = false
    return {
      resource: cohort.resource,
      release: async () => {
        if (released) return
        released = true
        if (this.active !== cohort || !cohort.owners.delete(owner)) {
          throw new Error(`Codex run ${owner} lost its exact client cohort ownership.`)
        }
        if (cohort.owners.size > 0) return
        cohort.accepting = false
        cohort.closing ??= (async () => {
          try {
            await cohort.close()
          } finally {
            if (this.active === cohort) this.active = null
            await cohort.afterClose()
          }
        })()
        await cohort.closing
      }
    }
  }
}

function normalizedIdentity(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Codex client cohort requires an exact ${label}.`)
  return normalized
}
