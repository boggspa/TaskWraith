import { describe, expect, it, vi } from 'vitest'
import { createAuditGatesRunner } from './AuditGatesRunner'
import type { HostCommandResult } from '../runStateTypes'

function hostResult(partial: Partial<HostCommandResult>): HostCommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    ...partial
  }
}

describe('AuditGatesRunner', () => {
  it('maps exitCode 0 to a passing gate with a terse summary', async () => {
    let counter = 0
    const runner = createAuditGatesRunner({
      runCommand: async () => hostResult({ exitCode: 0, stdout: 'ok', durationMs: 42 }),
      uuid: () => `id-${++counter}`
    })
    const [gate] = await runner.runGates(
      [{ check: 'typecheck', command: 'npm run typecheck' }],
      '/ws'
    )
    expect(gate).toEqual({
      id: 'id-1',
      check: 'typecheck',
      command: 'npm run typecheck',
      status: 'pass',
      exitCode: 0,
      summary: 'passed',
      durationMs: 42
    })
  })

  it('maps a non-zero exit to a failing gate that surfaces the output tail', async () => {
    const runner = createAuditGatesRunner({
      runCommand: async () => hostResult({ exitCode: 1, stderr: 'TS2304: Cannot find name foo' }),
      uuid: () => 'id'
    })
    const [gate] = await runner.runGates([{ check: 'typecheck', command: 'tsc' }], '/ws')
    expect(gate.status).toBe('fail')
    expect(gate.exitCode).toBe(1)
    expect(gate.summary).toBe('exit 1: TS2304: Cannot find name foo')
  })

  it('treats a timeout as a failed gate', async () => {
    const runner = createAuditGatesRunner({
      runCommand: async () => hostResult({ exitCode: null, timedOut: true, durationMs: 600_000 }),
      uuid: () => 'id'
    })
    const [gate] = await runner.runGates([{ check: 'test', command: 'npm test' }], '/ws')
    expect(gate.status).toBe('fail')
    expect(gate.summary).toBe('timed out')
    // null exitCode is omitted, not coerced.
    expect('exitCode' in gate).toBe(false)
  })

  it('converts a thrown runCommand (spawn failure) into a failed gate', async () => {
    const runner = createAuditGatesRunner({
      runCommand: async () => {
        throw new Error('spawn ENOENT')
      },
      uuid: () => 'id'
    })
    const [gate] = await runner.runGates([{ check: 'outdated', command: 'npm outdated' }], '/ws')
    expect(gate.status).toBe('fail')
    expect(gate.summary).toBe('spawn ENOENT')
    expect('exitCode' in gate).toBe(false)
  })

  it('records the combined log and references its artifact id when recordLog is provided', async () => {
    const recordLog = vi.fn(() => 'artifact-7')
    const runner = createAuditGatesRunner({
      runCommand: async () => hostResult({ exitCode: 1, stdout: 'out', stderr: 'err' }),
      uuid: () => 'id',
      recordLog
    })
    const [gate] = await runner.runGates([{ check: 'test', command: 'npm test' }], '/ws')
    expect(recordLog).toHaveBeenCalledWith({
      check: 'test',
      command: 'npm test',
      output: 'out\nerr'
    })
    expect(gate.logArtifactId).toBe('artifact-7')
  })

  it('runs checks sequentially and preserves order', async () => {
    const order: string[] = []
    let counter = 0
    const runner = createAuditGatesRunner({
      runCommand: async (command) => {
        order.push(command)
        return hostResult({ exitCode: 0 })
      },
      uuid: () => `id-${++counter}`
    })
    const gates = await runner.runGates(
      [
        { check: 'typecheck', command: 'a' },
        { check: 'test', command: 'b' },
        { check: 'supply-chain', command: 'c' }
      ],
      '/ws'
    )
    expect(order).toEqual(['a', 'b', 'c'])
    expect(gates.map((g) => g.check)).toEqual(['typecheck', 'test', 'supply-chain'])
  })

  it('runs the workspace path as the command cwd', async () => {
    const runCommand = vi.fn(async () => hostResult({ exitCode: 0 }))
    const runner = createAuditGatesRunner({ runCommand, uuid: () => 'id' })
    await runner.runGates([{ check: 'typecheck', command: 'tsc' }], '/some/workspace')
    expect(runCommand).toHaveBeenCalledWith('tsc', '/some/workspace')
  })

  it('retains exact audit command scope until the gate result is persisted', async () => {
    const events: string[] = []
    const authority = {
      auditRunId: 'audit-run-1',
      appChatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/some/workspace'
    }
    const createHostCommandProjection = vi.fn(() => ({
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        events.push('run')
        return operation()
      },
      complete: () => events.push('complete')
    }))
    const runner = createAuditGatesRunner({
      runCommand: async () => {
        events.push('command-close')
        return hostResult({ exitCode: 0 })
      },
      createHostCommandProjection,
      uuid: () => 'gate-1'
    })

    const gates = await runner.runGates(
      [{ check: 'typecheck', command: 'tsc' }],
      authority.workspacePath,
      authority,
      () => events.push('persist-gate')
    )

    expect(createHostCommandProjection).toHaveBeenCalledWith(authority)
    expect(gates.map((gate) => gate.id)).toEqual(['gate-1'])
    expect(events).toEqual(['run', 'command-close', 'persist-gate', 'complete'])
  })
})
