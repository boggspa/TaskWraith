import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const evidenceSource = readFileSync(
  new URL('../scheduling/SealEvidenceCursor.ts', import.meta.url),
  'utf8'
)
const cursorRunSource = indexSource.slice(
  indexSource.indexOf('async function runCursorProvider'),
  indexSource.indexOf('// ── Pi coding agent')
)

describe('Cursor Path-B production/evidence integration', () => {
  it('spawns the immutable plan argv and applies its final prompt/tool facts', () => {
    expect(cursorRunSource).toContain('const cursorLaunchPlan = buildCursorPathBLaunchPlan({')
    expect(cursorRunSource).toContain('payload.prompt = cursorLaunchPlan.prompt')
    expect(cursorRunSource).toContain(
      'payload.taskWraithMcpAdvertised = cursorLaunchPlan.taskWraithMcpAdvertised'
    )
    expect(cursorRunSource).toContain('const args = [...cursorLaunchPlan.argv]')
    expect(cursorRunSource).not.toContain('buildContainedCursorReadOnlyArgv(')
    expect(cursorRunSource).not.toContain('buildContainedCursorWriteArgv(')
  })

  it('holds the global broker registry before the workspace overlay and releases in reverse', () => {
    const globalAcquire = cursorRunSource.indexOf('cursorGlobalBrokerRegistryLeases.acquire({')
    const workspaceAcquire = cursorRunSource.indexOf('cursorWorkspaceConfigLeases.acquire({')
    const releaseHelper = cursorRunSource.slice(
      cursorRunSource.indexOf('const releaseCursorConfigurationLeases'),
      cursorRunSource.indexOf('let cursorMcpBridgeActive')
    )

    expect(globalAcquire).toBeGreaterThanOrEqual(0)
    expect(workspaceAcquire).toBeGreaterThan(globalAcquire)
    expect(releaseHelper.indexOf('await workspaceLease?.release()')).toBeGreaterThanOrEqual(0)
    expect(releaseHelper.indexOf('await globalLease?.release()')).toBeGreaterThan(
      releaseHelper.indexOf('await workspaceLease?.release()')
    )
    expect(cursorRunSource).toContain('onComplete: releaseCursorConfigurationLeases')
    expect(cursorRunSource).toContain(
      'canonicalRegistryResourcePath:\n          canonicalExternalGrantPath(globalMcpPath) || canonicalPath(globalMcpPath)'
    )
    expect(cursorRunSource).toContain(
      'const workspaceConfigTransaction = createVerifiedCursorWorkspaceConfigTransaction('
    )
    expect(cursorRunSource).toContain('configurationKey: workspacePostureKey')
    expect(cursorRunSource).toContain(
      'configurationKey: workspaceConfigTransaction.configurationKey'
    )
    expect(cursorRunSource).toContain('install: workspaceConfigTransaction.install')
    expect(cursorRunSource).toContain(
      'onInstallFailure: workspaceConfigTransaction.onInstallFailure'
    )
  })

  it('uses physical registry identity and surfaces unverified cleanup without excluding Cursor', () => {
    const aliasHelper = indexSource.slice(
      indexSource.indexOf('function cursorWorkspaceMcpAliasesGlobalRegistry'),
      indexSource.indexOf('async function runCursorProvider')
    )
    const releaseHelper = cursorRunSource.slice(
      cursorRunSource.indexOf('const releaseCursorConfigurationLeases'),
      cursorRunSource.indexOf('let cursorMcpBridgeActive')
    )

    expect(aliasHelper.match(/canonicalExternalGrantPath\(/g)).toHaveLength(2)
    expect(releaseHelper).toContain("receipt?.cleanup?.outcome === 'cleanup-failed'")
    expect(releaseHelper).toContain("title: 'Cursor configuration cleanup not verified'")
    expect(releaseHelper).toContain('Cursor remains available')
  })

  it('makes global registry install failure visible while retaining native-only fallback', () => {
    expect(cursorRunSource).toContain('createCursorGlobalBrokerRegistrationTransaction({')
    expect(cursorRunSource).toContain(
      'onInstallFailure: globalBrokerRegistrationTransaction.onInstallFailure'
    )
    expect(cursorRunSource).toContain('Registry recovery outcome:')
    expect(cursorRunSource).toContain(
      'error instanceof CursorGlobalBrokerRegistryLeaseAbortedError'
    )
  })

  it('projects a missing binary before lifecycle settlement and quiesces MCP approval on abort', () => {
    const missingBinary = cursorRunSource.slice(
      cursorRunSource.indexOf('if (!resolved.binaryPath)'),
      cursorRunSource.indexOf("if (!providerTransportLaunchAuthorized('cursor'")
    )
    expect(missingBinary).toContain('settleVisibleProviderSetupFailure({')
    expect(indexSource).toContain('await runCursorMcpEnable({')
  })

  it('derives native-only seal evidence from the same launch-plan builder', () => {
    expect(evidenceSource).toContain('const launchPlan = buildCursorPathBLaunchPlan({')
    expect(evidenceSource).toContain('const argvTemplate = buildCursorPathBLaunchPlan({')
    expect(evidenceSource).toContain("brokerOutcome: 'not-requested' as const")
  })
})
