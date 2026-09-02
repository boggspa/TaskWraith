import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('Codex host-hook P1 integration', () => {
  it('rejects Codex RPC when settleCodexNativeApprovalRequest throws', () => {
    const requests = between(
      'function handleCodexServerRequest(message: any)',
      'async function settleCodexNativeApprovalRequest('
    )
    expect(requests).toContain('void settleCodexNativeApprovalRequest(')
    // Same rejection shape as the adjacent user-input path: never leave the RPC hanging.
    expect(requests).toMatch(
      /settleCodexNativeApprovalRequest\([\s\S]*?\)\s*\.catch\s*\(\s*\(?\s*error/
    )
    expect(requests).toContain('respondingClient.reject(message.id, reason)')
  })

  it('gates withHostToolHooks to provider-native commandExecution/fileChange only', () => {
    const settle = between(
      'async function settleCodexNativeApprovalRequest(',
      'function maybeRequestCodexHostRerun('
    )
    expect(settle).toContain('withHostToolHooks')
    expect(settle).toContain('isMcpAutoAllowedForRun')
    // Non-native (MCP / elicitation) must settle without entering withHostToolHooks.
    expect(settle).toMatch(
      /if\s*\(\s*!?[\w.]*(?:isCodexProviderNative|isProviderNative|providerNative)[\w.]*\s*\)/
    )
    const skipHooksReturn = settle.search(
      /if\s*\(\s*![\w.]*(?:isCodexProviderNative|isProviderNative|providerNative)[\w.]*\s*\)[\s\S]{0,200}?return/
    )
    const hookCall = settle.indexOf('await withHostToolHooks')
    expect(skipHooksReturn).toBeGreaterThanOrEqual(0)
    expect(hookCall).toBeGreaterThan(skipHooksReturn)
    expect(settle).toMatch(/structuralApproval\.kind\s*===\s*'resolved'/)
  })

  it('stashes hostHookToolName on deferred Codex native ask registration', () => {
    const settle = between(
      'async function settleCodexNativeApprovalRequest(',
      'function maybeRequestCodexHostRerun('
    )
    expect(settle).toContain('registerCodex(approvalId,')
    expect(settle).toMatch(/registerCodex\(\s*approvalId\s*,\s*\{[\s\S]*?hostHookToolName/)
    expect(settle).toMatch(
      /outcomeFromResult:\s*\(outcome\)\s*=>\s*\(outcome\s*===\s*'deferred'\s*\?\s*null\s*:\s*outcome\)/
    )
  })

  it('uses the shared exact-surface window disclosure for Codex canvas_eval', () => {
    const settle = between(
      'async function settleCodexNativeApprovalRequest(',
      'function maybeRequestCodexHostRerun('
    )
    expect(settle).toMatch(
      /gateService\s*===\s*'canvasEval'[\s\S]*?appendCanvasEvalApprovalWindowDisclosure\(formatted\.body\)/
    )
    expect(settle).toMatch(/body:\s*codexApprovalBody,[\s\S]*?preview:\s*formatted\.preview/)
  })
})
