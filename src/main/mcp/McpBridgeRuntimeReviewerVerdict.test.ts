import { describe, expect, it, vi } from 'vitest'
import { handleMcpJsonRpcMessage } from './McpBridgeRuntime'

/**
 * C2b-ii-c — read-only / plan MCP bridge tools/call enforcement for the ONE exact
 * reviewer-verdict ensemble_bossman_control invocation (G-SINGLE / G-ADVERTISE).
 *
 * The bridge is the entire safety boundary for a read-only Grok/Cursor seat (it
 * auto-runs MCP tools with NO host gate), so tools/call is where the exact
 * {action:'submit_review_verdict', gateId, verdict} payload must be allowed through —
 * and where every other ensemble_bossman_control action / near miss must stay rejected.
 * The tool is NEVER advertised or auto-allowed; this is a per-invocation ARG check.
 *
 * "Reached the broker" (brokerRequest called) == allowed; a written JSON-RPC error with
 * brokerRequest NOT called == rejected. Both direct tools/call (outer arguments) and
 * capability_invoke (inner arguments.arguments) are covered.
 */

const SOCKET = '/tmp/taskwraith-reviewer-verdict.sock'
const TOKEN = 'token-rv'

type ToolsCallParams = { name: string; arguments?: unknown }

async function runToolsCall(params: ToolsCallParams, env: Record<string, string>) {
  const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
  const responses: Array<Record<string, unknown>> = []
  const stdout = {
    write: vi.fn((chunk: string, cb?: (error?: Error | null) => void) => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          responses.push(JSON.parse(trimmed) as Record<string, unknown>)
        } catch {
          // non-JSON frame — irrelevant to these assertions
        }
      }
      cb?.()
      return true
    })
  }
  handleMcpJsonRpcMessage(
    {
      getDefaultSocketPath: () => SOCKET,
      getAppVersion: () => '1.0.0',
      getMcpToolDefinitions: () => [],
      brokerRequest,
      env,
      cwd: () => '/repo',
      stdout: stdout as never
    },
    SOCKET,
    TOKEN,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params },
    'line'
  )
  await new Promise((resolve) => setImmediate(resolve))
  const rejected = responses.some(
    (r) => r && typeof r === 'object' && 'error' in r && !('result' in r)
  )
  return { brokerRequest, responses, rejected }
}

// Read-only Grok safe-subset seat (the A4 catastrophic auto-run seam).
const RO_SAFE = { TASKWRAITH_MCP_SAFE_SUBSET: '1', TASKWRAITH_PARENT_PROVIDER: 'grok' }
// Realistic read-only seat: safe subset AND the fixed CORE-60 profile together.
const RO_SAFE_CORE = {
  TASKWRAITH_MCP_SAFE_SUBSET: '1',
  TASKWRAITH_MCP_CORE_SUBSET: '1',
  TASKWRAITH_PARENT_PROVIDER: 'grok'
}
// Read-only seat on the gateway profile — the only way capability_invoke is reachable.
const RO_SAFE_GATEWAY = {
  TASKWRAITH_MCP_SAFE_SUBSET: '1',
  TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
  TASKWRAITH_PARENT_PROVIDER: 'grok'
}

const exactVerdict = (verdict: 'passed' | 'failed') => ({
  action: 'submit_review_verdict',
  gateId: 'g1',
  verdict
})

describe('C2b-ii-c bridge tools/call reviewer-verdict exception', () => {
  // ---- P-C6 positive: exact direct invocation passes through the read-only reject ----
  it('P-C6: exact reviewer-verdict passes read-only tools/call directly (both verdicts)', async () => {
    for (const verdict of ['passed', 'failed'] as const) {
      const { brokerRequest, rejected } = await runToolsCall(
        { name: 'ensemble_bossman_control', arguments: exactVerdict(verdict) },
        RO_SAFE
      )
      expect(rejected, `verdict=${verdict}`).toBe(false)
      expect(brokerRequest, `verdict=${verdict}`).toHaveBeenCalledOnce()
      expect(brokerRequest).toHaveBeenCalledWith(
        SOCKET,
        expect.objectContaining({ tool: 'ensemble_bossman_control' })
      )
    }
  })

  it('P-C6: exact reviewer-verdict passes under the realistic safe+CORE-60 read-only profile', async () => {
    const { brokerRequest, rejected } = await runToolsCall(
      { name: 'ensemble_bossman_control', arguments: exactVerdict('passed') },
      RO_SAFE_CORE
    )
    // bossman is a CORE-60 catalogued tool, so the core gate passes it; the safe-subset
    // gate is the one this slice unblocks for the exact payload.
    expect(rejected).toBe(false)
    expect(brokerRequest).toHaveBeenCalledOnce()
  })

  // ---- P-C6 positive: exact invocation via gateway capability_invoke inner arguments ----
  it('P-C6: exact reviewer-verdict passes via capability_invoke inner arguments', async () => {
    const { brokerRequest, rejected } = await runToolsCall(
      {
        name: 'capability_invoke',
        arguments: { name: 'ensemble_bossman_control', arguments: exactVerdict('failed') }
      },
      RO_SAFE_GATEWAY
    )
    expect(rejected).toBe(false)
    expect(brokerRequest).toHaveBeenCalledOnce()
    // The broker payload stays the OUTER gateway call — main resolves + executes the
    // target through its own approval/guard/lock/audit seams.
    expect(brokerRequest).toHaveBeenCalledWith(
      SOCKET,
      expect.objectContaining({ tool: 'capability_invoke' })
    )
  })

  // ---- N-*: every non-exact direct bossman payload stays rejected (fail-closed) ----
  it('N: non-exact / near-miss direct ensemble_bossman_control payloads stay rejected', async () => {
    const nearMisses: Array<{ label: string; args: unknown }> = [
      { label: 'no args (fail-closed)', args: undefined },
      { label: 'empty object', args: {} },
      { label: 'missing verdict', args: { action: 'submit_review_verdict', gateId: 'g1' } },
      { label: 'missing gateId', args: { action: 'submit_review_verdict', verdict: 'passed' } },
      {
        label: 'blank gateId',
        args: { action: 'submit_review_verdict', gateId: '   ', verdict: 'passed' }
      },
      {
        label: 'bad verdict enum',
        args: { action: 'submit_review_verdict', gateId: 'g1', verdict: 'waived' }
      },
      {
        label: 'extra key',
        args: { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed', reason: 'x' }
      },
      {
        label: 'privileged action set_goal',
        args: { action: 'set_goal', gateId: 'g1', verdict: 'passed' }
      },
      {
        label: 'privileged action quarantine_participant',
        args: { action: 'quarantine_participant', gateId: 'g1', verdict: 'passed' }
      },
      {
        label: 'privileged action set_review_gate',
        args: { action: 'set_review_gate', gateId: 'g1', verdict: 'passed' }
      }
    ]
    for (const { label, args } of nearMisses) {
      const { brokerRequest, rejected } = await runToolsCall(
        { name: 'ensemble_bossman_control', arguments: args },
        RO_SAFE
      )
      expect(brokerRequest, label).not.toHaveBeenCalled()
      expect(rejected, label).toBe(true)
    }
  })

  // ---- N-*: gateway capability_invoke with absent/malformed/non-exact inner args ----
  it('N: capability_invoke to bossman with absent/malformed/non-exact inner args stays rejected', async () => {
    const innerCases: Array<{ label: string; inner: unknown }> = [
      { label: 'absent inner arguments (fail-closed)', inner: undefined },
      { label: 'malformed inner (string)', inner: 'not-an-object' },
      { label: 'malformed inner (array)', inner: ['submit_review_verdict'] },
      { label: 'missing verdict', inner: { action: 'submit_review_verdict', gateId: 'g1' } },
      {
        label: 'extra key',
        inner: { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed', reason: 'x' }
      },
      { label: 'privileged action', inner: { action: 'set_goal', gateId: 'g1', verdict: 'passed' } }
    ]
    for (const { label, inner } of innerCases) {
      const { brokerRequest, rejected } = await runToolsCall(
        { name: 'capability_invoke', arguments: { name: 'ensemble_bossman_control', arguments: inner } },
        RO_SAFE_GATEWAY
      )
      expect(brokerRequest, label).not.toHaveBeenCalled()
      expect(rejected, label).toBe(true)
    }
  })

  // ---- Floor intact: the exception widens nothing else ----
  it('floor intact: the arg-scoped exception does not widen any other tool or seat', async () => {
    // A mutating tool stays rejected for a read-only seat.
    const write = await runToolsCall(
      { name: 'write_file', arguments: { path: 'x.txt', content: 'y' } },
      RO_SAFE
    )
    expect(write.brokerRequest).not.toHaveBeenCalled()
    expect(write.rejected).toBe(true)

    // A genuinely advertised read tool still passes (control — proves we didn't break the seam).
    const read = await runToolsCall({ name: 'read_file', arguments: { path: 'README.md' } }, RO_SAFE)
    expect(read.brokerRequest).toHaveBeenCalledOnce()

    // The SAME exact reviewer-verdict payload on a DIFFERENT tool name stays rejected
    // (the classifier is tool-scoped to canonical ensemble_bossman_control).
    const wrongTool = await runToolsCall(
      { name: 'ensemble_roster_edit', arguments: exactVerdict('passed') },
      RO_SAFE
    )
    expect(wrongTool.brokerRequest).not.toHaveBeenCalled()
    expect(wrongTool.rejected).toBe(true)
  })
})
