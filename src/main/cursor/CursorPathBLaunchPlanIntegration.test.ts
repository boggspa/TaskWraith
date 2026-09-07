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

  it('threads signed effectivePermissions into pre-spawn broker policy and the launch plan', () => {
    const policyCall = cursorRunSource.slice(
      cursorRunSource.indexOf('const cursorBrokerPolicy = resolveCursorPathBBrokerPolicy({'),
      cursorRunSource.indexOf('let cursorGlobalBrokerRegistryLease')
    )
    const planCall = cursorRunSource.slice(
      cursorRunSource.indexOf('const cursorLaunchPlan = buildCursorPathBLaunchPlan({'),
      cursorRunSource.indexOf('payload.prompt = cursorLaunchPlan.prompt')
    )

    expect(policyCall).toContain('effectivePermissions: payload.effectivePermissions')
    expect(planCall).toContain('effectivePermissions: payload.effectivePermissions')
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
    expect(cursorRunSource).toContain('configurationKey: workspaceConfigBaseKey')
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
    expect(cursorRunSource).toContain('buildCursorMcpBridgeUnavailableWarning({')
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
    expect(cursorRunSource).toContain('execFileCursorMcpBoundToParentRoute({')
    expect(indexSource).toContain('attachCursorBrokerParentRouteIfNeeded({')
  })

  it('derives native-only seal evidence from the same launch-plan builder', () => {
    expect(evidenceSource).toContain('const launchPlan = buildCursorPathBLaunchPlan({')
    expect(evidenceSource).toContain('const argvTemplate = buildCursorPathBLaunchPlan({')
    expect(evidenceSource).toContain("brokerOutcome: 'not-requested' as const")
  })
})

describe('Cursor prompt delivery is stdin, never argv', () => {
  it('hands the plan prompt to a one-shot stdin plan instead of a positional', () => {
    // cursor-agent silently exits 0 with no stdout/stderr past a 465,459-byte
    // total-argv ceiling, so a positional prompt loses the whole turn. The
    // prompt must reach the child over stdin, and stdin must CLOSE (the turn
    // runs on EOF) rather than being held open like pi's RPC channel.
    expect(cursorRunSource).toContain(
      'stdinPlan: { initialLines: [cursorLaunchPlan.prompt], endAfterInitialWrite: true }'
    )
  })
})

describe('Cursor stdin prompt delivery is crash-safe', () => {
  it('swallows an EPIPE on the child stdin the prompt is written to', () => {
    // The prompt is now up to ~1MB of buffered stdin, so a child that exits
    // early (rejected model, failed login) leaves unflushed bytes. EPIPE arrives
    // as a stream 'error' EVENT — invisible to a try/catch around write()/end()
    // — and unhandled it would take down the Electron main process.
    expect(indexSource).toContain("child.stdin?.on('error', () => {")
  })
})

describe('Cursor workspace config lease is keyed by CONTENT, not seat posture', () => {
  it('does not fragment the workspace overlay lease by posture label', () => {
    // The lease key is `<base>:intent-sha256:<digest>` and the digest already
    // encodes the exact installed bytes (allow rules, deny rules, MCP entry).
    // Prefixing it with a posture LABEL additionally split seats that install
    // byte-identical config, so a second seat waited out the first seat's whole
    // turn for no policy reason at all. Seats whose config genuinely differs
    // still serialize — that separation is load-bearing containment, because
    // `.cursor/cli.json` is workspace-global and its allow rules are what bound
    // a bridged read-only seat running in Cursor's DEFAULT mode.
    expect(cursorRunSource).not.toContain('cursorWorkspaceConfigurationKey(\n')
    expect(cursorRunSource).toContain(
      'const workspaceConfigBaseKey = cursorWorkspaceConfigurationKey()'
    )
    expect(cursorRunSource).toContain('configurationKey: workspaceConfigBaseKey')
  })
})
