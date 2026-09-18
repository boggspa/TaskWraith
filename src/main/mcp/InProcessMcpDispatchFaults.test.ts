import { describe, expect, it, vi } from 'vitest'
import { createInProcessMcpDispatch } from './InProcessMcpDispatch'
import type { InProcessMcpDispatchTimeout } from './InProcessMcpDispatch'
import type { McpBridgeProfileEnvironment } from './McpBridgeRoute'

/**
 * FAULT MATRIX FOR THE IN-PROCESS BROKER SEAM.
 *
 * `createInProcessMcpDispatch` takes `dispatchBrokerRequest` as an explicit
 * injected dependency, so a fault can be introduced at the exact boundary a
 * real broker failure would arrive on, with no product change and no
 * subprocess. The sibling `InProcessMcpDispatch.test.ts` covers the happy
 * route/profile paths and one rejection case (message redaction); this file
 * covers what the layer DOES under each way the broker can fail, which is the
 * part nothing pinned.
 *
 * The property that matters is not that failures are pretty — it is that every
 * fault SETTLES into a provider-visible JSON-RPC response instead of hanging a
 * turn, and that none of them leaks main-process detail. A wedged turn is the
 * expensive failure: the agent waits, the run never seals, and the user sees a
 * live "Working" chip over a dead call.
 *
 * The one deliberate exception is the timeout path whose cancellation itself
 * fails. `InProcessMcpDispatch.ts` documents that case as fail-closed on
 * purpose ("Cancellation failure is not settlement evidence"), leaving the call
 * pending for the terminal watchdog rather than reporting a completion it
 * cannot prove. That behaviour had no test; it has one here, because it is
 * exactly the kind of intentional non-settlement a later "fix the hang" pass
 * would otherwise delete in good faith.
 */

const INSTANCE_EPOCH = 'b'.repeat(48)

const PROFILE: McpBridgeProfileEnvironment = {
  safeSubset: false,
  planSubset: false,
  coreSubset: false,
  gatewaySubset: true,
  soloSubset: false,
  portableEnsembleControl: false,
  meshDirect: false,
  meshTopologyDirect: false,
  sketchDirect: false,
  orchestrationDirect: false,
  permissionOpportunityDirect: false,
  auditSubset: false
}

interface DispatchHarnessOptions {
  dispatchBrokerRequest: (request: unknown) => Promise<unknown>
  timeoutMs?: number
  onDispatchTimeout?: (input: InProcessMcpDispatchTimeout) => void | Promise<void>
}

function createHarness(options: DispatchHarnessOptions) {
  return createInProcessMcpDispatch({
    parentProvider: 'mistral',
    route: { appRunId: 'fault-run', appChatId: 'fault-chat' },
    profile: PROFILE,
    appVersion: '1.9.8',
    brokerToken: 'private-broker-token',
    instanceEpoch: INSTANCE_EPOCH,
    getMcpToolDefinitions: () => [{ name: 'read_file' }],
    ...options
  })
}

function toolCall(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'README.md' } }
  }
}

/** Resolves to the sentinel when `promise` has not settled within `ms`. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown | 'PENDING'> {
  let timer: NodeJS.Timeout | undefined
  const pending = new Promise<'PENDING'>((resolve) => {
    timer = setTimeout(() => resolve('PENDING'), ms)
  })
  try {
    return await Promise.race([promise, pending])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const SENTINEL = 'private-main-process-detail-that-must-not-escape'

describe('in-process MCP dispatch under broker faults', () => {
  const faults: Array<{ name: string; dispatchBrokerRequest: () => Promise<unknown> }> = [
    {
      name: 'rejects with an Error',
      dispatchBrokerRequest: async () => {
        throw new Error(SENTINEL)
      }
    },
    {
      name: 'rejects with a non-Error value',
      dispatchBrokerRequest: async () => {
        throw SENTINEL
      }
    },
    { name: 'resolves null', dispatchBrokerRequest: async () => null },
    { name: 'resolves undefined', dispatchBrokerRequest: async () => undefined },
    { name: 'resolves a bare string', dispatchBrokerRequest: async () => SENTINEL },
    { name: 'resolves a number', dispatchBrokerRequest: async () => 42 },
    {
      name: 'resolves an object that is not a broker response',
      dispatchBrokerRequest: async () => ({ unexpected: SENTINEL })
    },
    {
      name: 'resolves an array',
      dispatchBrokerRequest: async () => [{ unexpected: SENTINEL }]
    }
  ]

  it.each(faults)('settles a provider-visible response when the broker $name', async (fault) => {
    const dispatch = createHarness({ dispatchBrokerRequest: fault.dispatchBrokerRequest })

    // 250ms is far below the real broker timeout, so reaching a response here
    // proves the fault is handled on the spot rather than waiting one out.
    const response = await settledWithin(dispatch(toolCall(1)), 250)

    expect(response, 'broker fault left the turn hanging').not.toBe('PENDING')
    expect(response, 'broker fault produced no provider-visible response').not.toBeNull()
    expect(JSON.stringify(response), 'fault leaked main-process detail').not.toContain(SENTINEL)
  })

  it('reports a timeout as a JSON-RPC error and names the tool to the cancel hook', async () => {
    const observed: InProcessMcpDispatchTimeout[] = []
    const dispatch = createHarness({
      dispatchBrokerRequest: () => new Promise(() => {}),
      timeoutMs: 10,
      onDispatchTimeout: (input) => {
        observed.push(input)
      }
    })

    const response = await settledWithin(dispatch(toolCall(7)), 2_000)

    expect(response, 'a hung broker never timed out').not.toBe('PENDING')
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000 }
    })
    // Without the tool name the cancel hook cannot tell the run which call to
    // seal, which is how a timed-out turn still wedges downstream.
    expect(observed).toEqual([
      { appRunId: 'fault-run', appChatId: 'fault-chat', requestId: 7, toolName: 'read_file' }
    ])
  })

  it('stays pending by design when the timeout cancellation itself fails', async () => {
    const onDispatchTimeout = vi.fn(async () => {
      throw new Error(SENTINEL)
    })
    const dispatch = createHarness({
      dispatchBrokerRequest: () => new Promise(() => {}),
      timeoutMs: 10,
      onDispatchTimeout
    })

    const response = await settledWithin(dispatch(toolCall(9)), 300)

    // Deliberate fail-closed: reporting a timeout the runtime could not
    // actually cancel would claim a settlement that never happened, so the
    // call is left to the terminal watchdog instead.
    expect(response, 'failed cancellation must not fabricate a settled response').toBe('PENDING')
    expect(onDispatchTimeout).toHaveBeenCalledTimes(1)
  })

  it('renders an unrecognised broker response as an EMPTY SUCCESS, not an error', async () => {
    // CHARACTERIZATION, NOT ENDORSEMENT. Observed 2026-09-18: every broker
    // value the runtime does not recognise as a tool result — null, undefined,
    // a bare string, an arbitrary object, and a JSON-RPC error envelope
    // returned in the broker's place — renders identically as
    // `{ content: [{ type: 'text', text: '' }], isError: false }`.
    //
    // That is the silent-failure shape: the agent is told the call SUCCEEDED
    // and handed an empty string, so it proceeds on nothing rather than
    // retrying or surfacing a fault. Contrast the reject path above, which
    // correctly yields isError: true, and capability_invoke's own argument
    // rejection, which yields a real -32602. The runtime can express an error
    // here; this path just does not.
    //
    // Pinned so the behaviour is visible and a change to it is deliberate. If
    // malformed broker responses are made to surface as errors, this test
    // SHOULD fail — update it, do not delete it.
    for (const brokerValue of [
      null,
      undefined,
      SENTINEL,
      { unexpected: SENTINEL },
      { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }
    ]) {
      const dispatch = createHarness({ dispatchBrokerRequest: async () => brokerValue })
      const response = await settledWithin(dispatch(toolCall(11)), 250)

      expect(response, 'broker fault left the turn hanging').not.toBe('PENDING')
      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 11,
        result: { content: [{ type: 'text', text: '' }], isError: false }
      })
    }
  })

  it('still produces a real JSON-RPC error when the runtime itself rejects arguments', async () => {
    // The contrast case for the test above: this proves the empty-success
    // shape is a property of the unrecognised-broker-response path and not a
    // blanket inability to report errors on this transport.
    const dispatch = createHarness({ dispatchBrokerRequest: async () => ({ ok: true }) })

    const response = await settledWithin(
      dispatch({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'capability_invoke', arguments: {} }
      }),
      250
    )

    expect(response).toMatchObject({ jsonrpc: '2.0', id: 13, error: { code: -32602 } })
  })
})
