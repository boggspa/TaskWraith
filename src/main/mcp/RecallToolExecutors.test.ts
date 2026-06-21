import { describe, expect, it } from 'vitest'
import {
  RECALL_MCP_TOOL_NAMES,
  createRecallToolExecutors,
  isRecallMcpToolName
} from './RecallToolExecutors'

describe('isRecallMcpToolName', () => {
  it('matches the recall family and nothing else', () => {
    for (const name of RECALL_MCP_TOOL_NAMES) expect(isRecallMcpToolName(name)).toBe(true)
    expect(isRecallMcpToolName('canvas_open')).toBe(false)
    expect(isRecallMcpToolName('run_timeline')).toBe(false)
    expect(isRecallMcpToolName('tw_recall_unknown')).toBe(false)
  })
})

describe('createRecallToolExecutors (slice 1 — inert)', () => {
  it('returns a not-implemented error for every recall verb', async () => {
    const { executeRecallTool } = createRecallToolExecutors()
    for (const name of RECALL_MCP_TOOL_NAMES) {
      const result = await executeRecallTool(name, {}, {}, 'claude')
      expect(result.isError).toBe(true)
      expect(result.text).toContain('not implemented')
    }
  })
})
