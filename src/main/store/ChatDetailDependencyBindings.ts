import type { ToolDetailDependency } from './ToolActivityDetailDurability'

/** One admitted save's side channel; never attach this object to persistence DTOs. */
export function createChatDetailDependencyBindings() {
  const held = new Set<ToolDetailDependency>()
  let sealed = false
  return {
    hasDependencies(): boolean {
      return held.size > 0
    },
    collect(dependencies: readonly ToolDetailDependency[]): void {
      if (sealed) throw new Error('Detail dependency binding is sealed')
      for (const dependency of dependencies) held.add(dependency)
    },
    seal(): void {
      sealed = true
    },
    journalDependencies() {
      return [...held].flatMap((dependency) => [...dependency.journalDependencies()])
    },
    flushSync(): void {
      const failures: unknown[] = []
      for (const dependency of held) {
        try {
          dependency.flushSync()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Chat detail synchronous drain failed')
    },
    async awaitDurable(): Promise<void> {
      // Observe every failure without returning while another dependency can
      // still own an in-flight write. Keep tokens available for a retry.
      const results = await Promise.allSettled(
        [...held].map((dependency) => Promise.resolve().then(() => dependency.awaitDurable()))
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length)
        throw new AggregateError(failures, 'Chat detail dependencies did not become durable')
    }
  }
}
