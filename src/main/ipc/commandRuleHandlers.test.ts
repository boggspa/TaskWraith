import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'

import type { CommandRule } from '../store/types'
import { registerCommandRuleHandlers } from './commandRuleHandlers'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => mockedHandle.mockReset())

function handlerFor(channel: string) {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1]
  if (!handler) throw new Error(`Missing handler ${channel}`)
  return handler as (event: unknown, ...args: unknown[]) => unknown
}

function rule(): CommandRule {
  return {
    schemaVersion: 1,
    id: 'rule-1',
    kind: 'brokered_shell_exact_argv',
    workspaceId: 'workspace-1',
    primaryWorkspacePath: '/repo',
    primaryWorkspaceRealPath: '/real/repo',
    cwdRelativePath: '.',
    executableRealPath: '/usr/bin/grep',
    executableSha256: 'a'.repeat(64),
    argv: ['TODO', 'src'],
    parserVersion: 'static-shell-argv-v1',
    fingerprint: 'b'.repeat(64),
    signatureVersion: 'hmac-sha256-v1',
    signature: 'c'.repeat(64),
    riskClass: 'host_exact_unsandboxed',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  }
}

describe('commandRuleHandlers', () => {
  it('lists only renderer-safe rule fields and requires main renderer authority', () => {
    const assertMainRendererSender = vi.fn()
    registerCommandRuleHandlers({
      service: { list: () => [rule()], remove: vi.fn() },
      assertMainRendererSender
    })

    const result = handlerFor('command-rules:list')({})
    expect(assertMainRendererSender).toHaveBeenCalledOnce()
    expect(result).toEqual([
      expect.objectContaining({
        id: 'rule-1',
        executablePath: '/usr/bin/grep',
        argv: ['TODO', 'src']
      })
    ])
    expect(JSON.stringify(result)).not.toContain('signature')
    expect(JSON.stringify(result)).not.toContain('executableSha256')
  })

  it('derives the complete removal binding from the signed main-owned rule', () => {
    const remove = vi.fn(() => true)
    registerCommandRuleHandlers({
      service: { list: () => [rule()], remove },
      assertMainRendererSender: vi.fn()
    })

    expect(handlerFor('command-rules:remove')({}, 'rule-1')).toMatchObject({ ok: true })
    expect(remove).toHaveBeenCalledWith({
      id: 'rule-1',
      workspaceId: 'workspace-1',
      workspacePath: '/real/repo'
    })
    expect(handlerFor('command-rules:remove')({}, 'missing')).toEqual({
      ok: false,
      error: 'Command rule was not found.'
    })
  })
})
