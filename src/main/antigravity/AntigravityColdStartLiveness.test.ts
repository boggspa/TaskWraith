import { describe, expect, it } from 'vitest'
import { emitAntigravityColdStartInit } from './AntigravityColdStartLiveness'

describe('emitAntigravityColdStartInit', () => {
  it('emits a paired tool_use/tool_result with the liveness message', () => {
    const sent: Array<{
      sender: unknown
      provider: string
      payload: Record<string, unknown>
      route: unknown
    }> = []
    const sender = { id: 'sender' } as unknown as Electron.WebContents
    const route = { appRunId: 'run-1', appChatId: 'chat-1' }

    emitAntigravityColdStartInit(
      (s, provider, payload, r) => {
        sent.push({ sender: s, provider, payload, route: r })
      },
      sender,
      route
    )

    expect(sent).toHaveLength(2)
    const [toolUse, toolResult] = sent
    for (const event of sent) {
      expect(event.sender).toBe(sender)
      expect(event.provider).toBe('antigravity')
      expect(event.route).toBe(route)
    }
    expect(toolUse.payload.type).toBe('tool_use')
    expect(toolUse.payload.tool_name).toBe('antigravity_init')
    expect(toolResult.payload.type).toBe('tool_result')
    expect(toolResult.payload.tool_name).toBe('antigravity_init')
    expect(toolResult.payload.status).toBe('success')
    // The pair must share one id so the orchestrator pairs the result back to
    // the call instead of surfacing an orphan card.
    expect(toolResult.payload.tool_id).toBe(toolUse.payload.tool_id)
    expect(String(toolResult.payload.output)).toContain('Initializing AntiGravity project')
  })
})
