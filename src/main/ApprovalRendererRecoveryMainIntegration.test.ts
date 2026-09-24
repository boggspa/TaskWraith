import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function positionsOf(source: string, needle: string): number[] {
  const positions: number[] = []
  let offset = 0
  while (offset < source.length) {
    const position = source.indexOf(needle, offset)
    if (position < 0) break
    positions.push(position)
    offset = position + needle.length
  }
  return positions
}

describe('approval renderer recovery main integration', () => {
  it('publishes both native Codex card shapes before sending them to the renderer', () => {
    const publishNeedle = 'approvalService?.publishRendererApprovalRequest(approvalPayload)'
    const sendNeedle = "safeSendToSender(state.sender, 'agent-approval-request', approvalPayload)"
    const publishPositions = positionsOf(mainSource, publishNeedle)
    const sendPositions = positionsOf(mainSource, sendNeedle)

    expect(publishPositions).toHaveLength(2)
    expect(sendPositions).toHaveLength(2)
    for (const [index, publishPosition] of publishPositions.entries()) {
      expect(publishPosition).toBeLessThan(sendPositions[index])
      expect(sendPositions[index] - publishPosition).toBeLessThan(200)
    }
    expect(mainSource).not.toContain('publishRendererApprovalRequest(durableApprovalPayload)')
  })
})
