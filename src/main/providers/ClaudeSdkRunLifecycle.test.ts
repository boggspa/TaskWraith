import { describe, expect, it, vi } from 'vitest'
import { settleClaudeSdkTerminal } from './ClaudeSdkRunLifecycle'

describe('settleClaudeSdkTerminal', () => {
  it('settles and confirms the exact run when terminal projection throws', () => {
    const order: string[] = []
    const projectionError = new Error('renderer detached')
    const onError = vi.fn(() => order.push('diagnostic'))
    const runManager = {
      getClaimedTerminalStatus: vi.fn(() => undefined),
      finish: vi.fn(() => order.push('finish')),
      confirmTerminalStatus: vi.fn(() => order.push('confirm'))
    }

    expect(
      settleClaudeSdkTerminal({
        runManager,
        runId: 'run-1',
        status: 'completed',
        project: () => {
          order.push('project')
          throw projectionError
        },
        onError
      })
    ).toBe('completed')
    expect(order).toEqual(['project', 'diagnostic', 'finish', 'confirm'])
    expect(onError).toHaveBeenCalledWith('projection', projectionError)
    expect(runManager.finish).toHaveBeenCalledWith('run-1', 'completed')
    expect(runManager.confirmTerminalStatus).toHaveBeenCalledWith('run-1', 'completed')
  })

  it('preserves a graph terminal claim over the SDK outcome', () => {
    const runManager = {
      getClaimedTerminalStatus: vi.fn(() => 'cancelled' as const),
      finish: vi.fn(),
      confirmTerminalStatus: vi.fn()
    }

    expect(
      settleClaudeSdkTerminal({
        runManager,
        runId: 'run-2',
        status: 'completed',
        project: vi.fn()
      })
    ).toBe('cancelled')
    expect(runManager.finish).toHaveBeenCalledWith('run-2', 'cancelled')
    expect(runManager.confirmTerminalStatus).toHaveBeenCalledWith('run-2', 'cancelled')
  })

  it('confirms and returns without replay risk when the lifecycle finish hook throws', () => {
    const finishError = new Error('finish failed')
    const onError = vi.fn()
    const runManager = {
      getClaimedTerminalStatus: vi.fn(() => undefined),
      finish: vi.fn(() => {
        throw finishError
      }),
      confirmTerminalStatus: vi.fn()
    }

    expect(
      settleClaudeSdkTerminal({
        runManager,
        runId: 'run-3',
        status: 'failed',
        project: vi.fn(),
        onError
      })
    ).toBe('failed')
    expect(onError).toHaveBeenCalledWith('finish', finishError)
    expect(runManager.confirmTerminalStatus).toHaveBeenCalledWith('run-3', 'failed')
  })
})
