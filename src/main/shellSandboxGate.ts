// Agent-shell Seatbelt sub-gate.
//
// Pure (reads only process.env), so index.ts can import it without a cycle —
// same shape as grokGate / kimiGate / mistralGate.

/**
 * Wrap the agent shell in a workspace-write Seatbelt (`sandbox-exec`).
 *
 * Default ON since 2026-09-03, after a live canary ran git, node, npm, tsc,
 * vitest, prettier and eslint under the generated profile in a real workspace
 * with no failures — the evidence the earlier default-OFF posture was waiting
 * for. It was gated because the failure mode of a too-tight profile is a
 * confusing write error deep inside a build rather than a permission card.
 *
 * `TASKWRAITH_SHELL_SANDBOX=0` (or false/no/off) turns it back off, which is the
 * escape hatch if a toolchain the canary did not cover needs to write outside
 * the workspace. Prefer the Full Access preset for a run that legitimately
 * needs an uncontained shell: that is a per-run, signed, user-visible decision,
 * whereas this variable silently disables containment for every seat at once.
 */
export function shellSandboxEnabled(): boolean {
  const value = process.env.TASKWRAITH_SHELL_SANDBOX?.trim().toLowerCase()
  if (value === undefined || value === '') return true
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}
