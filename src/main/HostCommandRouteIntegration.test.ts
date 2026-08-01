import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const ollamaSource = readFileSync(new URL('./ollama/OllamaProvider.ts', import.meta.url), 'utf8')
const auditGateSource = readFileSync(new URL('./audit/AuditGatesRunner.ts', import.meta.url), 'utf8')

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('host command route/history integration', () => {
  it('registers before admission/spawn and resolves timeout or error only from actual close', () => {
    const runner = between(mainSource, 'function runHostCommand(', 'function codexNeedsApprovalGate(')
    const registered = runner.indexOf('hostCommandOperations.register(')
    const admitted = runner.indexOf('historyClearAdmissionBlocked(')
    const liveBundleGuard = runner.indexOf('runningAppBundleMutationBlockReason({')
    const spawned = runner.indexOf('child = spawn(')
    const childError = runner.indexOf("child.on('error'")
    const childClose = runner.indexOf("child.on('close'")
    const timeout = runner.indexOf('timeout = setTimeout(')

    expect(registered).toBeLessThan(admitted)
    expect(admitted).toBeLessThan(liveBundleGuard)
    expect(liveBundleGuard).toBeLessThan(spawned)
    expect(childError).toBeLessThan(childClose)
    expect(runner.slice(childError, childClose)).not.toContain('resolveCommand(')
    expect(childClose).toBeLessThan(timeout)
    expect(runner.slice(timeout)).toContain("signalChild('SIGTERM')")
    expect(runner.slice(timeout)).toContain("signalChild('SIGKILL')")
    expect(runner.slice(timeout)).not.toContain('resolveCommand(')
  })

  it('retains Codex reruns and every brokered workspace command through result projection', () => {
    const rerun = between(
      mainSource,
      'async function runApprovedHostCommand(',
      'function syncCodexGoalCapabilityMetadata('
    )
    expect(rerun).toContain("source: 'codex-host-rerun'")
    expect(rerun).toContain('runWithHostCommandProjectionScope(')
    expect(rerun.indexOf("type: 'tool_result'")).toBeLessThan(
      rerun.indexOf('completeHostCommandTerminalProjection(')
    )

    const mcp = between(mainSource, 'async function executeGeminiMcpTool(', 'async function startGeminiMcpBroker(')
    expect(mcp).toContain("source: 'brokered-mcp'")
    expect(mcp).toContain('runHostCommand(command, cwd)')
    expect(mcp).toContain('workspaceToolExecutors.executeWorkspaceMcpTool')
    expect(mcp).toContain('completeHostCommandTerminalProjection(hostCommandProjection)')
  })

  it('holds Ollama and audit projections until their durable/UI result seams', () => {
    const ollamaLoop = between(
      ollamaSource,
      'const toolExecutionRequest: OllamaToolExecutionRequest',
      'const truncatedOutput = truncateOllamaToolResultOutput('
    )
    expect(ollamaLoop).toContain('hostCommandProjection.run(executeTool)')
    expect(ollamaLoop.indexOf("type: 'tool_result'")).toBeLessThan(
      ollamaLoop.indexOf('hostCommandProjection?.complete()')
    )

    const auditLoop = between(
      auditGateSource,
      'for (const { check, command } of checks)',
      'return results'
    )
    expect(auditLoop).toContain('hostCommandProjection.run(runCommand)')
    expect(auditLoop.indexOf('projectGate?.(gate)')).toBeLessThan(
      auditLoop.indexOf('hostCommandProjection?.complete()')
    )
    const auditWiring = between(
      mainSource,
      'runGates: createAuditGatesRunner({',
      'getPolicy: () => AppStore.getSettings().auditOrchestration'
    )
    expect(auditWiring).toContain("source: 'audit-gate'")
    expect(auditWiring).toContain('appRunId: authority.auditRunId')
    expect(auditWiring).toContain('appChatId: authority.appChatId')
  })

  it('cancels and joins host commands behind retained broad and scoped admission gates', () => {
    const broad = between(
      mainSource,
      'type BroadHistoryDeletionHolds = {',
      'const clearBroadChatHistory = (workspaceId?: string)'
    )
    expect(broad).toContain('hostCommandPurge: BroadHistoryStrictAttempt')
    expect(broad.indexOf('historyGateHeld = true')).toBeLessThan(
      broad.indexOf('hostCommandOperations.beginCancellation(')
    )
    expect(broad).toContain('await holds.hostCommandPurge.promise')

    const scoped = between(
      mainSource,
      'type ChatHistoryMutationAuthority = {',
      'const beginEnsembleHistoryClear = (chatId: string)'
    )
    expect(scoped.indexOf('historyClearAdmissionGate.beginChat(chatId)')).toBeLessThan(
      scoped.indexOf('hostCommandOperations.beginCancellation(')
    )
    expect(scoped).toContain('retained.hostCommandCompletion')
    expect(scoped).toContain('historyClearAdmissionGate.endChat(chatId)')
  })
})
