/**
 * First-call-success corpus for the Ensemble argument normalizer.
 *
 * Every row is a real miscall observed in the 2026-08-27 round. The assertion
 * is deliberately narrow: after the committed normalizer runs, the field the
 * agent actually sent must still be present under the name the handler reads.
 * Handler acceptance (the new plan/summary/steps aliases, locked_writers
 * demotion) is covered by the owning slices' suites.
 */
export interface FirstCallSuccessCase {
  name: string
  toolName: string
  input: unknown
  /** Run the input through the top-level JSON-string transport parser first. */
  jsonStringTransport?: boolean
  expected: Record<string, unknown>
}

const ROUND_PLAN_ENVELOPE = {
  action: 'set_round_plan',
  params: { planSummary: 'Review the implementation.' }
} as const

export const FIRST_CALL_SUCCESS_CORPUS: readonly FirstCallSuccessCase[] = [
  // 1. The tool description's own documented preferred shape, on both names.
  {
    name: 'envelope on the portable control name',
    toolName: 'ensemble_control',
    input: ROUND_PLAN_ENVELOPE,
    expected: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
  },
  {
    name: 'envelope on the canonical control name',
    toolName: 'ensemble_bossman_control',
    input: ROUND_PLAN_ENVELOPE,
    expected: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
  },
  // 2. The exact flat spelling the old error message demanded.
  {
    name: 'flat planSummary on the portable control name',
    toolName: 'ensemble_control',
    input: { action: 'set_round_plan', planSummary: 'Review the implementation.' },
    expected: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
  },
  {
    name: 'flat planSummary on the canonical control name',
    toolName: 'ensemble_bossman_control',
    input: { action: 'set_round_plan', planSummary: 'Review the implementation.' },
    expected: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
  },
  // 3. The natural aliases the handler now accepts — the normalizer must not strip them.
  {
    name: 'plan alias survives normalization',
    toolName: 'ensemble_control',
    input: { action: 'set_round_plan', plan: 'Review the implementation.' },
    expected: { action: 'set_round_plan', plan: 'Review the implementation.' }
  },
  {
    name: 'summary alias survives normalization',
    toolName: 'ensemble_control',
    input: { action: 'set_round_plan', summary: 'Review the implementation.' },
    expected: { action: 'set_round_plan', summary: 'Review the implementation.' }
  },
  {
    name: 'steps alias survives normalization',
    toolName: 'ensemble_control',
    input: { action: 'set_round_plan', steps: 'Review the implementation.' },
    expected: { action: 'set_round_plan', steps: 'Review the implementation.' }
  },
  // 4. Snake_case folds to the camelCase field the handler reads, keeping the original.
  {
    name: 'plan_summary folds to planSummary',
    toolName: 'ensemble_control',
    input: { action: 'set_round_plan', plan_summary: 'Review the implementation.' },
    expected: {
      action: 'set_round_plan',
      plan_summary: 'Review the implementation.',
      planSummary: 'Review the implementation.'
    }
  },
  // 5. A whole call encoded as a JSON string is parsed before normalization.
  {
    name: 'JSON-string transport on the portable control name',
    toolName: 'ensemble_control',
    input: JSON.stringify(ROUND_PLAN_ENVELOPE),
    jsonStringTransport: true,
    expected: { action: 'set_round_plan', planSummary: 'Review the implementation.' }
  },
  // 6. A mixed locked_writers fan-out: only the keyed target is a writer; the
  // normalizer must preserve the scope map exactly so the orchestrator can
  // demote the unkeyed target to a read lane instead of erroring.
  {
    name: 'mixed locked_writers fan-out keeps only keyed scopes',
    toolName: 'ensemble_fanout',
    input: {
      prompt: 'Implement the slice.',
      targets: ['@Work3', '@Scout1'],
      mode: 'locked_writers',
      writeScopes: { Work3: ['src/main/services/EnsembleOrchestrator.ts'] }
    },
    expected: {
      prompt: 'Implement the slice.',
      targets: ['@Work3', '@Scout1'],
      mode: 'locked_writers',
      writeScopes: { Work3: ['src/main/services/EnsembleOrchestrator.ts'] }
    }
  },
  // 7. The latent merge-vs-replace bug: an envelope that omits action must not
  // drop the outer action.
  {
    name: 'outer action survives an envelope that omits it',
    toolName: 'ensemble_control',
    input: {
      action: 'assign_work',
      params: { targetParticipantId: 'p7', objective: 'Ship the slice.' }
    },
    expected: {
      action: 'assign_work',
      targetParticipantId: 'p7',
      objective: 'Ship the slice.'
    }
  }
]
