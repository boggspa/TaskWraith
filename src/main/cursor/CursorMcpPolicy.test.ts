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
  cursorTaskWraithBrokerAttachAllowed,
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
      sketchCanvas: 'deny',
      meshCanvas: 'deny',
      simulatorCanvas: 'deny',
      crossThreadRead: 'deny',
      threadMessage: 'deny',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'deny',
      webBrowsing: 'deny'
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

  it('rejects a legacy broker-dependent qualification posture when MCP is denied', () => {
    expect(() => assertCursorWriteMcpPosture(true, permissions('deny'))).toThrow(
      /broker-dependent Cursor qualification posture cannot run/i
    )
    expect(() => assertCursorWriteMcpPosture(false, permissions('deny'))).not.toThrow()
    expect(() => assertCursorWriteMcpPosture(true, permissions('ask'))).not.toThrow()
  })

  it('allows TaskWraith broker attach on Plan even when mcpTools is deny', () => {
    const planDenied = {
      ...permissions('deny'),
      presetId: 'plan' as const,
      approvalMode: 'plan' as const,
      readOnly: true
    }
    expect(cursorMcpToolsDenied(planDenied)).toBe(true)
    expect(cursorTaskWraithBrokerAttachAllowed(planDenied)).toBe(true)
    // Custom + mcpTools deny still blocks attach (user MCP and generic deny).
    expect(cursorTaskWraithBrokerAttachAllowed(permissions('deny'))).toBe(false)
    expect(cursorTaskWraithBrokerAttachAllowed(permissions('ask'))).toBe(true)
  })
})
