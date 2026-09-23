import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { FULL_MCP_ADVERTISE_TOOLS, GATEWAY_MCP_DIRECT_TOOLS } from './McpToolProfiles'
import { resolveGatewayInvocation, selectGatewayHiddenToolNames } from './McpToolGateway'
import {
  dispatchResolvedGatewayTarget,
  type GatewayTargetDispatchMarker
} from './McpGatewayTargetDispatch'

describe('dispatchResolvedGatewayTarget', () => {
  it('routes a hidden mutation through canonical approval and returns its rich result unchanged', async () => {
    const targetArguments = { path: 'old.txt', newName: 'new.txt' }
    const resolution = resolveGatewayInvocation({
      name: 'rename_path',
      arguments: targetArguments,
      definitions: createTaskWraithMcpToolDefinitions(),
      eligibleToolNames: selectGatewayHiddenToolNames({
        fullToolNames: FULL_MCP_ADVERTISE_TOOLS,
        directToolNames: GATEWAY_MCP_DIRECT_TOOLS
      })
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)

    const route = { appRunId: 'run-1', appChatId: 'chat-1' }
    const callerContext = { approvalMode: 'default', callerCwd: '/workspace' }
    const approvalRequest = vi.fn()
    const richResult = {
      text: 'renamed',
      structuredContent: { from: 'old.txt', to: 'new.txt' },
      trustedMediaRefs: [{ kind: 'image', ref: 'preview-1' }]
    }
    const executeCanonical = vi.fn(
      async (
        targetName: string,
        receivedArguments: Record<string, unknown>,
        receivedRoute: typeof route,
        parentProvider: string,
        receivedCallerContext: typeof callerContext,
        marker: GatewayTargetDispatchMarker
      ) => {
        approvalRequest(targetName, receivedCallerContext.approvalMode)
        expect(receivedArguments).toBe(resolution.arguments)
        expect(receivedArguments).toStrictEqual(targetArguments)
        expect(receivedRoute).toBe(route)
        expect(parentProvider).toBe('codex')
        expect(receivedCallerContext).toBe(callerContext)
        expect(marker).toEqual({ viaGateway: true, gatewayToolName: 'capability_invoke' })
        return richResult
      }
    )

    const result = await dispatchResolvedGatewayTarget({
      targetName: resolution.name,
      targetArguments: resolution.arguments,
      route,
      parentProvider: 'codex',
      callerContext,
      executeCanonical
    })

    expect(executeCanonical).toHaveBeenCalledOnce()
    expect(approvalRequest).toHaveBeenCalledWith('rename_path', 'default')
    expect(approvalRequest).not.toHaveBeenCalledWith('capability_invoke', expect.anything())
    expect(result).toBe(richResult)
  })

  it('preserves screenshot pixels and coordinate metadata through a hidden tool invocation', async () => {
    const targetArguments = { canvasId: 'canvas-1' }
    const resolution = resolveGatewayInvocation({
      name: 'canvas_screenshot',
      arguments: targetArguments,
      definitions: createTaskWraithMcpToolDefinitions(),
      eligibleToolNames: selectGatewayHiddenToolNames({
        fullToolNames: FULL_MCP_ADVERTISE_TOOLS,
        directToolNames: GATEWAY_MCP_DIRECT_TOOLS
      })
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    const text = 'Screen: 1200 x 800; coordinates are image pixels.'
    const screenshot = {
      text,
      content: [
        { type: 'text', text },
        { type: 'image', mimeType: 'image/png', data: 'c2NyZWVuc2hvdA==' }
      ]
    }
    const route = { appRunId: 'run-screen', appChatId: 'chat-screen' }
    const callerContext = { approvalMode: 'default', callerCwd: '/workspace' }
    const executeCanonical = vi.fn(async () => screenshot)

    const result = await dispatchResolvedGatewayTarget({
      targetName: resolution.name,
      targetArguments: resolution.arguments,
      route,
      parentProvider: 'kimi',
      callerContext,
      executeCanonical
    })

    expect(executeCanonical).toHaveBeenCalledWith(
      'canvas_screenshot',
      targetArguments,
      route,
      'kimi',
      callerContext,
      { viaGateway: true, gatewayToolName: 'capability_invoke' }
    )
    expect(result).toBe(screenshot)
    expect(result.content[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: 'c2NyZWVuc2hvdA=='
    })
  })
})
