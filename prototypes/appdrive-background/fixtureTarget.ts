/**
 * Harness-owned fixture target identity.
 * Real CGEventPostToPid may only target a fixture PID created by the harness,
 * and only under explicit user invocation — never production app PIDs by default.
 */

export type FixtureTarget = {
  kind: 'harness_fixture'
  /** Synthetic app id used in reports (not a real macOS bundle authority). */
  appId: string
  appLabel: string
  /** When null, dry-run/observe-only; live post requires a harness-owned pid. */
  pid: number | null
  ownedByHarness: true
}

export const DEFAULT_FIXTURE_TARGET: FixtureTarget = {
  kind: 'harness_fixture',
  appId: 'com.taskwraith.harness.AppDriveFixture',
  appLabel: 'AppDrive Interference Fixture',
  pid: null,
  ownedByHarness: true
}

export function isHarnessOwnedFixture(target: {
  ownedByHarness?: boolean
  kind?: string
  pid?: number | null
}): boolean {
  return target.kind === 'harness_fixture' && target.ownedByHarness === true
}
