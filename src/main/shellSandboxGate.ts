// Agent-shell Seatbelt sub-gate.
//
// Pure (reads only process.env), so index.ts can import it without a cycle —
// same shape as grokGate / kimiGate / mistralGate.

/**
 * Wrap the agent shell in a workspace-write Seatbelt (`sandbox-exec`).
 *
 * Default OFF — a deliberate seatbelt, for the same reason
 * `grokReadOnlyMcpAdvertiseEnabled` is: turning it on changes what a real
 * toolchain is allowed to do mid-build, and the failure mode is a confusing
 * write error deep inside `npm`/`cargo`/`swift` rather than a permission card.
 * It stays gated until a live canary proves the common build paths still run
 * contained. Enabling it never widens anything: the only outcomes are "same as
 * today" and "writes outside the workspace now fail".
 *
 * Full Access runs are exempt inside `resolveShellSandboxPlan` regardless of
 * this flag — that posture is the explicit opt-in to an uncontained shell.
 */
export function shellSandboxEnabled(): boolean {
  const value = process.env.TASKWRAITH_SHELL_SANDBOX?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}
