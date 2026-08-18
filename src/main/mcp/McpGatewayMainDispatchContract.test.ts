import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const executorStart = indexSource.indexOf('async function executeGeminiMcpTool(')
const executorEnd = indexSource.indexOf('\nasync function startGeminiMcpBroker()', executorStart)
const executorSource = indexSource.slice(executorStart, executorEnd)
const canonicalDispatchStart = executorSource.indexOf(
  'const argumentPreflight = validateMcpToolArgumentsBeforeApproval('
)
const gatewayDispatchSource = executorSource.slice(0, canonicalDispatchStart)
const canonicalDispatchSource = executorSource.slice(canonicalDispatchStart)

describe('main capability gateway dispatch contract', () => {
  it('unwraps the gateway before wrapper-level route, approval, or lock decisions', () => {
    expect(executorStart).toBeGreaterThan(-1)
    expect(executorEnd).toBeGreaterThan(executorStart)
    expect(canonicalDispatchStart).toBeGreaterThan(-1)
    expect(gatewayDispatchSource).toContain('if (isCapabilityGatewayToolName(toolName))')
    expect(gatewayDispatchSource).toContain('resolveGatewayInvocation({')
    expect(gatewayDispatchSource).not.toContain('previewForGeminiMcpTool(')
    expect(gatewayDispatchSource).not.toContain('requestAgenticServiceApproval(')
    expect(gatewayDispatchSource).not.toContain('workspaceLockMcpAdmissionCoordinator.admit({')
    // Guards the assertion above against going vacuous: the workspace-lock
    // admission seam must exist somewhere in the executor, just never ahead of
    // the gateway unwrap.
    expect(executorSource).toContain('workspaceLockMcpAdmissionCoordinator.admit({')
  })

  it('hands the exact target route and caller context to the executable dispatch seam', () => {
    expect(gatewayDispatchSource).toMatch(
      /return dispatchResolvedGatewayTarget\(\{\s*targetName: resolution\.name,\s*targetArguments: resolution\.arguments,\s*route: effectiveRoute,\s*parentProvider,\s*callerContext,\s*executeCanonical: executeGeminiMcpTool\s*\}\)/s
    )
  })

  it('keeps the canonical target safeguards and rich-result path downstream', () => {
    for (const seam of [
      'validateMcpToolArgumentsBeforeApproval(',
      'validateMutatingMcpRoute(toolName, effectiveRoute)',
      'validateMcpCallerWorkspace({',
      'previewForGeminiMcpTool(toolName, args, cwd, context, parentProvider)',
      'applyMcpWriteLockApprovalContext(approvalPreview, context, toolName, args, cwd)',
      'requestAgenticServiceApproval(',
      'networkAccessBlockedToolName(',
      'workspaceLockMcpAdmissionCoordinator.admit({',
      'imageToolCallBudget.tryConsume(',
      'finalRichResult?.trustedMediaRefs'
    ]) {
      expect(canonicalDispatchSource, seam).toContain(seam)
    }
    // The pinned literal used to carry the argument ordering too. The call now
    // takes a third argument across several lines, so the ordering is asserted
    // on its own: the tool name first, the caller's effective permissions
    // second — never the reverse, which would silently evaluate the block
    // against the wrong posture.
    const networkBlockCalls =
      canonicalDispatchSource.match(/networkAccessBlockedToolName\([^)]*\)/gs) ?? []
    expect(networkBlockCalls.length).toBeGreaterThan(0)
    for (const call of networkBlockCalls) {
      expect(call, 'networkAccessBlockedToolName argument ordering').toMatch(
        /^networkAccessBlockedToolName\(\s*[A-Za-z_$][\w.$]*,\s*context\.effectivePermissions\b/s
      )
    }
    expect(canonicalDispatchSource.indexOf('validateMcpToolArgumentsBeforeApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')
    )
    expect(canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('workspaceLockMcpAdmissionCoordinator.admit({')
    )
  })

  it('resolves every brokered shell cwd through the workspace scope before execution', () => {
    const scopeResolution = canonicalDispatchSource.indexOf('cwd = resolveScopedDirectory(')
    const shellExecution = canonicalDispatchSource.indexOf("if (toolName === 'run_shell_command')")
    // Anchored on the call head, not the full argument list: the brokered shell
    // also forwards a session release-lease approval, so the call is no longer
    // two-arity. The contract being guarded is the ordering, not the arity.
    const hostCommand = canonicalDispatchSource.indexOf('runHostCommand(command, cwd')

    expect(scopeResolution).toBeGreaterThan(-1)
    expect(hostCommand).toBeGreaterThan(-1)
    expect(canonicalDispatchSource.slice(scopeResolution, shellExecution)).toContain(
      'String(args.cwd || args.working_directory || args.workdir || \'\')'
    )
    expect(scopeResolution).toBeLessThan(shellExecution)
    expect(shellExecution).toBeLessThan(hostCommand)
  })
})
