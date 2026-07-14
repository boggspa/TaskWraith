import type { ExternalPathGrant } from './store/types'

/**
 * Process-epoch authority for `thisRun` external-path grants.
 *
 * The HMAC secret intentionally survives restarts so durable `thisThread`
 * grants remain readable. A run-only capability must not: its exact signature
 * is registered only when this main-process instance issues it. A fresh app
 * process starts with an empty registry, so replaying an old token together
 * with its old run id fails even though its historical HMAC still verifies.
 */
export class ExternalPathGrantExecutionRegistry {
  private readonly liveThisRunSignatures = new Map<string, string>()

  registerIssued(grant: ExternalPathGrant): void {
    if (
      grant.duration !== 'thisRun' ||
      grant.bindingVersion !== 2 ||
      !grant.appRunId?.trim() ||
      !grant.signature?.trim()
    ) {
      return
    }
    this.liveThisRunSignatures.set(grant.signature, grant.appRunId.trim())
  }

  allowsExecution(grant: ExternalPathGrant): boolean {
    if (grant.duration !== 'thisRun') return true
    const signature = grant.signature?.trim()
    const runId = grant.appRunId?.trim()
    return Boolean(
      grant.bindingVersion === 2 &&
        signature &&
        runId &&
        this.liveThisRunSignatures.get(signature) === runId
    )
  }

  revokeRun(runId: string): void {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) return
    for (const [signature, registeredRunId] of this.liveThisRunSignatures) {
      if (registeredRunId === normalizedRunId) this.liveThisRunSignatures.delete(signature)
    }
  }
}
