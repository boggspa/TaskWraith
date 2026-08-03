import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function codexRequestHandlerSource(): string {
  const start = indexSource.indexOf('function handleCodexServerRequest(message: any)')
  const end = indexSource.indexOf('\nfunction maybeRequestCodexHostRerun(', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('Codex host user-input wiring', () => {
  it('routes the exact host method through the shared question registry before approvals', () => {
    const source = codexRequestHandlerSource()
    const hostBranchStart = source.indexOf('if (isCodexUserInputRequestMethod(method))')
    const genericApprovalStart = source.indexOf('const approvalId =', hostBranchStart)
    expect(hostBranchStart).toBeGreaterThanOrEqual(0)
    expect(genericApprovalStart).toBeGreaterThan(hostBranchStart)

    const hostBranch = source.slice(hostBranchStart, genericApprovalStart)
    expect(hostBranch).toContain('collectCodexUserInput(params')
    expect(hostBranch).toContain("source: 'codex-host'")
    expect(hostBranch).toContain("safeSendToSender(rendererSender, 'agent-question-requested'")
    expect(hostBranch).toContain('respondingClient.respond(message.id, result.response)')
    expect(hostBranch).toContain('respondingClient.reject(message.id, result.reason)')
    expect(hostBranch).not.toContain('registerCodex(')
    expect(hostBranch).not.toContain('scheduleApprovalTimeout(')
  })
})
