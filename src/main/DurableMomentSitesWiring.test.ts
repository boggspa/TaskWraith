import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * Wiring contract for the durable moment gate's sites in `index.ts`.
 *
 * The wait itself lives in `run/DurableMomentGate.ts` and is tested there:
 * its bound, its refusals, what it waits for. This file asserts only the half
 * that module cannot: that `index.ts` reaches it at each place that reports a
 * moment as done, before the report and not after.
 */
describe('durable moment gate wiring in index.ts', () => {
  const probe = new MainSourceProbe('index.ts', new URL('./index.ts', import.meta.url))

  /** The single awaited call to `name` inside `scope`. */
  function awaitedCall(scope: ts.Node, name: string): ts.CallExpression {
    const calls = probe.callsTo(scope, name)
    expect(calls).toHaveLength(1)
    expect(ts.isAwaitExpression(calls[0].parent)).toBe(true)
    return calls[0]
  }

  it("waits for a finished child run's tickets before its result is delivered to the parent", () => {
    const deliver = probe.fn('maybePropagateLinkedChildResult')
    const wait = awaitedCall(deliver, 'awaitRunFinal')
    expect(probe.argText(wait, 0)).toBe('chatId')

    const deliveries = probe.callsTo(deliver, 'enqueueSubThreadMailboxEvent')
    expect(deliveries.length).toBeGreaterThan(0)
    for (const delivery of deliveries) expect(wait.getStart()).toBeLessThan(delivery.getStart())
    // Nothing of the child is read before the wait: what it reads must be what the disk holds.
    const reads = probe.callsTo(deliver, 'getChat')
    for (const read of reads) expect(wait.getStart()).toBeLessThan(read.getStart())
  })

  it("waits for the user's answer to be on the disk before the agent's question tool returns it", () => {
    const tools = probe.fn('executeUnscopedGeminiMcpTool')
    const register = probe
      .callsTo(tools, 'register')
      .filter((call) => probe.text(call).includes('AGENT_QUESTION_TIMEOUT_MS'))
    expect(register).toHaveLength(1)
    const wait = awaitedCall(tools, 'settleUserMoment')
    expect(probe.argText(wait, 0)).toBe('context.appChatId')

    const answer = probe
      .callsTo(tools, 'mcpJson')
      .filter((call) => probe.text(call).includes("tool: 'ask_user_question'"))
      .filter((call) => probe.text(call).includes('result.answer'))
    expect(answer).toHaveLength(1)
    expect(register[0].getStart()).toBeLessThan(wait.getStart())
    expect(wait.getStart()).toBeLessThan(answer[0].getStart())
  })

  it("gives Codex's question bridge the same wait before the answers go back to Codex", () => {
    const calls = probe.callsTo(probe.fn('handleCodexServerRequest'), 'collectCodexUserInput')
    expect(calls).toHaveLength(1)
    const answered = probe.propText(calls[0], 1, 'answered')
    expect(answered).not.toBeNull()
    expect(answered).toContain('settleUserMoment(state.appChatId')
  })
})
