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
    expect(gatewayDispatchSource).not.toContain('acquireMcpWorkspaceMutation({')
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
      'networkAccessBlockedToolName(toolName, context.effectivePermissions)',
      'acquireMcpWorkspaceMutation({',
      'imageToolCallBudget.tryConsume(',
      'finalRichResult?.trustedMediaRefs'
    ]) {
      expect(canonicalDispatchSource, seam).toContain(seam)
    }
    expect(canonicalDispatchSource.indexOf('validateMcpToolArgumentsBeforeApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')
    )
    expect(canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('acquireMcpWorkspaceMutation({')
    )
  })

  it('resolves every brokered shell cwd through the workspace scope before execution', () => {
    const scopeResolution = canonicalDispatchSource.indexOf('const cwd = resolveScopedDirectory(')
    const shellExecution = canonicalDispatchSource.indexOf("if (toolName === 'run_shell_command')")
    const hostCommand = canonicalDispatchSource.indexOf('runHostCommand(command, cwd)')

    expect(scopeResolution).toBeGreaterThan(-1)
    expect(canonicalDispatchSource.slice(scopeResolution, shellExecution)).toContain(
      'String(args.cwd || args.working_directory || args.workdir || \'\')'
    )
    expect(scopeResolution).toBeLessThan(shellExecution)
    expect(shellExecution).toBeLessThan(hostCommand)
  })
})
