import { describe, expect, it, vi } from 'vitest'
import {
  buildUserMcpCursorAllowRules,
  buildUserMcpCursorServerEntry,
  type UserMcpLaunchServer
} from '../UserMcpServers'
import type { EffectiveRunPermissions } from '../store/types'
import {
  assertCursorWriteMcpPosture,
  cursorMcpToolsDenied,
  resolveCursorUserMcpLaunchServers
} from './CursorMcpPolicy'

function permissions(mcpTools: 'deny' | 'ask'): EffectiveRunPermissions {
  return {
    presetId: 'custom',
    approvalMode: 'default',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools,
      subThreadDelegation: 'deny',
      canvasInteraction: 'deny',
      crossThreadRead: 'deny',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'deny'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

const userServer: UserMcpLaunchServer = {
  serverName: 'user_filesystem',
  transport: 'stdio',
  command: 'mcp-filesystem',
  args: ['/workspace']
}

describe('Cursor MCP effective-posture guard', () => {
  it('does not resolve or project user MCP config when the signed posture denies MCP', () => {
    const resolver = vi.fn(() => [userServer])
    const servers = resolveCursorUserMcpLaunchServers(permissions('deny'), resolver)

    expect(cursorMcpToolsDenied(permissions('deny'))).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
    expect(servers).toEqual([])
    expect(buildUserMcpCursorServerEntry(servers)).toEqual({})
    expect(buildUserMcpCursorAllowRules(servers)).toEqual([])
  })

  it('retains the existing user MCP projection when the canonical posture does not deny it', () => {
    const resolver = vi.fn(() => [userServer])
    const servers = resolveCursorUserMcpLaunchServers(permissions('ask'), resolver)

    expect(cursorMcpToolsDenied(permissions('ask'))).toBe(false)
    expect(resolver).toHaveBeenCalledOnce()
    expect(buildUserMcpCursorServerEntry(servers)).toHaveProperty('user_filesystem')
    expect(buildUserMcpCursorAllowRules(servers)).toEqual(['Mcp(user_filesystem:*)'])
  })

  it('rejects write mode instead of degrading when its required broker is posture-denied', () => {
    expect(() => assertCursorWriteMcpPosture(true, permissions('deny'))).toThrow(
      /write mode requires the contained TaskWraith MCP broker/i
    )
    expect(() => assertCursorWriteMcpPosture(false, permissions('deny'))).not.toThrow()
    expect(() => assertCursorWriteMcpPosture(true, permissions('ask'))).not.toThrow()
  })
})
