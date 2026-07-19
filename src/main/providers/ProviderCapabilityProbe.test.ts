import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess, spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  createProviderCapabilityProbe,
  parseCapabilityJsonItems,
  parseCapabilityRawItems
} from './ProviderCapabilityProbe'

describe('ProviderCapabilityProbe', () => {
  it('normalizes nested JSON capability maps', () => {
    expect(
      parseCapabilityJsonItems(
        {
          mcpServers: {
            alpha: {
              enabled: true,
              description: 'Alpha server'
            }
          }
        },
        'mcp'
      )
    ).toEqual([
      {
        id: 'alpha',
        name: 'alpha',
        status: 'enabled',
        detail: 'Alpha server',
        raw: '{"enabled":true,"description":"Alpha server"}'
      }
    ])
  })

  it('normalizes raw tables while discarding ANSI headers and empty-state prose', () => {
    expect(
      parseCapabilityRawItems(
        [
          '\u001b[32mName  Status  Description\u001b[0m',
          '----------------',
          'alpha | connected | local server',
          'No MCP servers configured.',
          'MCP servers:'
        ].join('\n'),
        'mcp'
      )
    ).toEqual([
      {
        id: 'mcp-1',
        name: 'alpha',
        status: 'connected',
        detail: 'connected · local server',
        raw: 'alpha | connected | local server'
      }
    ])
  })

  it('fails closed without spawning when the configured binary cannot be resolved', async () => {
    const spawnProcess = vi.fn()
    const probe = createProviderCapabilityProbe({
      resolveGeminiBinary: async () => ({ binaryPath: null, error: 'binary unavailable' }),
      createCliEnv: vi.fn(),
      spawnProcess: spawnProcess as unknown as typeof spawn
    })

    await expect(probe.runGeminiCapabilityCommand(['mcp', 'list'])).resolves.toEqual({
      args: ['mcp', 'list'],
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      error: 'binary unavailable'
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('captures bounded process output and the terminal exit status', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => true)
    }) as unknown as ChildProcess
    const spawnProcess = vi.fn(() => child)
    const createCliEnv = vi.fn(() => ({ TEST_PATH: '/bin' }))
    const probe = createProviderCapabilityProbe({
      resolveGeminiBinary: async () => ({ binaryPath: '/tools/gemini' }),
      createCliEnv,
      spawnProcess: spawnProcess as unknown as typeof spawn
    })

    const resultPromise = probe.runGeminiCapabilityCommand(['mcp', 'list'], '/workspace')
    queueMicrotask(() => {
      stdout.write('alpha connected')
      stderr.write('diagnostic')
      child.emit('close', 0)
    })

    await expect(resultPromise).resolves.toEqual({
      args: ['mcp', 'list'],
      stdout: 'alpha connected',
      stderr: 'diagnostic',
      exitCode: 0,
      timedOut: false,
      error: undefined,
      truncated: false
    })
    expect(spawnProcess).toHaveBeenCalledWith('/tools/gemini', ['mcp', 'list'], {
      cwd: '/workspace',
      shell: false,
      env: { TEST_PATH: '/bin' }
    })
    expect(createCliEnv).toHaveBeenCalledWith({ FORCE_COLOR: '0', NO_COLOR: '1' }, '/tools/gemini')
  })
})
