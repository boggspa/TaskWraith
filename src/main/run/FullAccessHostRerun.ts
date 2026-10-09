import { settleFullAccessNativeDecision } from './FullAccessNativeDecision'

export type FullAccessHostRerunOutcome =
  | 'executed'
  | 'not-started'
  | 'cancelled'
  | 'not-full-access'
  | 'failed'

/** Permission and execution are distinct: always report the actual rerun outcome. */
export async function runFullAccessHostRerun(
  input: Omit<Parameters<typeof settleFullAccessNativeDecision>[0], 'execute'> & {
    execute: () => Promise<boolean>
    onOutcome: (outcome: FullAccessHostRerunOutcome) => void
  }
): Promise<FullAccessHostRerunOutcome> {
  let started = false
  try {
    const decision = await settleFullAccessNativeDecision({
      ...input,
      execute: async () => {
        started = await input.execute()
      }
    })
    const outcome = decision === 'accepted' ? (started ? 'executed' : 'not-started') : decision
    input.onOutcome(outcome)
    return outcome
  } catch (error) {
    input.onOutcome('failed')
    throw error
  }
}
