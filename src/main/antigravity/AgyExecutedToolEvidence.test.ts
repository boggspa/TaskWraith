import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { recordAgyExecutedTool } from './AgyExecutedToolEvidence'

const reporter = () => ({ executed: vi.fn().mockReturnValue(true) })

describe('recordAgyExecutedTool', () => {
  it('records a succeeded transcript result against the native surface', () => {
    const receipt = reporter()
    expect(
      recordAgyExecutedTool(receipt, {
        type: 'tool_result',
        tool_name: 'view_file',
        status: 'success'
      })
    ).toBe(true)
    expect(receipt.executed).toHaveBeenCalledWith('native', 'view_file')
  })

  it('ignores a request, because being allowed to call a tool is not running it', () => {
    const receipt = reporter()
    expect(
      recordAgyExecutedTool(receipt, {
        type: 'tool_use',
        tool_name: 'view_file',
        status: 'success'
      })
    ).toBe(false)
    expect(receipt.executed).not.toHaveBeenCalled()
  })

  it('ignores a failed result, which proves the tool did not do what was asked', () => {
    const receipt = reporter()
    expect(
      recordAgyExecutedTool(receipt, {
        type: 'tool_result',
        tool_name: 'view_file',
        status: 'error'
      })
    ).toBe(false)
    expect(receipt.executed).not.toHaveBeenCalled()
  })

  it('ignores an unnamed or blank tool, and a result with no status at all', () => {
    const receipt = reporter()
    expect(recordAgyExecutedTool(receipt, { type: 'tool_result', status: 'success' })).toBe(false)
    expect(
      recordAgyExecutedTool(receipt, { type: 'tool_result', tool_name: '   ', status: 'success' })
    ).toBe(false)
    expect(recordAgyExecutedTool(receipt, { type: 'tool_result', tool_name: 'x' })).toBe(false)
    expect(receipt.executed).not.toHaveBeenCalled()
  })

  it('tolerates a run with no receipt, a missing event, and a throwing reporter', () => {
    const success = { type: 'tool_result', tool_name: 'view_file', status: 'success' }
    expect(recordAgyExecutedTool(null, success)).toBe(false)
    expect(recordAgyExecutedTool(reporter(), null)).toBe(false)
    expect(
      recordAgyExecutedTool(
        {
          executed: () => {
            throw new Error('reporting blew up')
          }
        },
        success
      )
    ).toBe(false)
  })
})

describe('the agy lane feeds the receipt from the transcript, not from the hook', () => {
  const mainSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

  it('records executions from the brain transcript emit callback', () => {
    const start = mainSource.indexOf(
      'const brainTranscriptMonitor = new AgyBrainTranscriptMonitor('
    )
    expect(start).toBeGreaterThan(-1)
    const construction = mainSource.slice(start, mainSource.indexOf('\n  })\n', start))
    expect(construction).toContain('recordAgyExecutedTool(agyToolReceipt')
  })

  it('never claims an execution from a hook allow, which fires before the tool runs', () => {
    const start = mainSource.indexOf('async function runAntigravityAgyProvider(')
    const rest = mainSource.slice(start)
    const region = rest.slice(0, rest.indexOf('\n}\n'))
    const hookAllows = region.split('\n').filter((line) => /decision: 'allow'/.test(line))

    // Guards the assertion below against a vacuous pass if the hook is restructured.
    expect(hookAllows.length).toBeGreaterThan(0)
    expect(region).not.toMatch(/decision: 'allow'[^\n]*\n[^\n]*executed\(/)
  })
})
