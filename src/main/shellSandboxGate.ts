// Agent-shell Seatbelt sub-gate.
//
// Pure (reads only process.env), so index.ts can import it without a cycle —
// same shape as grokGate / kimiGate / mistralGate.

/**
 * Wrap the agent shell in a workspace-write Seatbelt (`sandbox-exec`).
 *
 * Default OFF while two reviewed defects are open: `thisRun`-duration external
 * write grants are not yet re-granted in the profile, and a login shell can
 * reassign TMPDIR past the allowed temp root. Both would silently deny writes
 * the user authorized, so the default is held until they are closed and a
 * review comes back clean.
 *
 * A live canary already ran git, node, npm, tsc, vitest, prettier and eslint
 * under the generated profile in a real workspace with no failures, so the
 * toolchain evidence for turning it on exists — it is the grant handling that
 * is not ready, not the profile.
 *
 * `TASKWRAITH_SHELL_SANDBOX=1` (or true/yes/on) opts in. Prefer the Full Access
 * preset for a run that legitimately needs an UNcontained shell: that is a
 * per-run, signed, user-visible decision, whereas this variable moves every
 * seat at once.
 */
export function shellSandboxEnabled(): boolean {
  const value = process.env.TASKWRAITH_SHELL_SANDBOX?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}
