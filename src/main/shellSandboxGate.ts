// Agent-shell Seatbelt sub-gate.
//
// Pure (reads only process.env), so index.ts can import it without a cycle —
// same shape as grokGate / kimiGate / mistralGate.

/**
 * Wrap the agent shell in a workspace-write Seatbelt (`sandbox-exec`).
 *
 * Default ON. It shipped OFF first and stayed there through four review rounds,
 * because the two things that make this safe to default had to be true and
 * neither was assumed:
 *
 *   1. Real toolchains still build contained. A live canary ran git, node, npm,
 *      tsc, vitest, prettier and eslint under the generated profile in a real
 *      workspace — 14/14, no failures.
 *   2. Containment never silently overrides a permission the USER granted.
 *      External write grants, including `thisRun`-duration ones, are re-granted
 *      in the profile; a run that cannot be contained refuses rather than
 *      running open; and a workspace whose paths cannot be expressed refuses
 *      the shell without taking non-spawning tools down with it.
 *
 * `TASKWRAITH_SHELL_SANDBOX=0` (or false/no/off) disables it. An UNRECOGNISED
 * value keeps containment on: the safe reading of a typo is that the operator
 * wanted the sandbox, not that they wanted an open shell.
 *
 * For a run that legitimately needs an UNcontained shell, prefer the Full
 * Access preset — a per-run, signed, user-visible decision that this module
 * already stands down for — over this variable, which moves every seat at once.
 */
export function shellSandboxEnabled(): boolean {
  const value = process.env.TASKWRAITH_SHELL_SANDBOX?.trim().toLowerCase()
  if (value === undefined || value === '') return true
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off'
}
