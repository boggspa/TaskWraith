import { describe, it, expect } from 'vitest'
import {
  classifyKimiToolPermission,
  isKimiBrokerDeferredMeshMcpTool,
  isKimiDeniedNativeTool,
  isKimiSafeMcpTool,
  unqualifyKimiMcpToolName,
  type KimiToolPolicyRequest
} from './KimiToolPolicy'
import { MESH_MCP_TOOL_NAMES } from '../../shared/taskWraithMcpCatalog'

const never = () => false
const opts = (over: Partial<Parameters<typeof classifyKimiToolPermission>[1]> = {}) => ({
  writeCapable: true,
  isSafeMcpTool: never,
  isReadOnlyShell: never,
  ...over
})

describe('unqualifyKimiMcpToolName', () => {
  it('strips the mcp__<server>__ namespace (incl. capitalized alias)', () => {
    expect(unqualifyKimiMcpToolName('mcp__taskwraith__capability_search')).toBe('capability_search')
    expect(unqualifyKimiMcpToolName('mcp__TaskWraith__ask_user_question')).toBe('ask_user_question')
  })
  it('passes an already-unqualified name through', () => {
    expect(unqualifyKimiMcpToolName('capability_search')).toBe('capability_search')
  })
  it('returns null for non-strings/empty', () => {
    expect(unqualifyKimiMcpToolName(undefined)).toBeNull()
    expect(unqualifyKimiMcpToolName('')).toBeNull()
  })
})

describe('isKimiSafeMcpTool', () => {
  // The ensemble soak caught this once already; the 1.9.2 rescue snapshot narrowed
  // the candidate list back to rawInput-only and reintroduced it. Kimi carries its
  // machine tool name in the ACP `toolCall.title`, which reaches us as
  // `request.toolName` — an identity that lives ONLY there must still be
  // recognised, or every TaskWraith read is denied on a read-only/plan seat.
  it('recognises the identity when it arrives only as the ACP title', () => {
    expect(
      isKimiSafeMcpTool({
        toolName: 'mcp__taskwraith__capability_search',
        rawToolCall: { rawInput: { query: 'release gates' } }
      })
    ).toBe(true)
    expect(
      isKimiSafeMcpTool({
        toolName: 'mcp__taskwraith__capability_invoke',
        toolKind: 'execute',
        rawToolCall: {
          kind: 'execute',
          rawInput: {
            tool_name: 'mcp__taskwraith__capability_invoke',
            name: 'mesh_topology_edit',
            arguments: {},
            command: 'touch /tmp/not-a-gateway-call'
          }
        }
      })
    ).toBe(false)
  })
  it('recognises a bare, already-unqualified identity', () => {
    expect(
      isKimiSafeMcpTool({
        toolName: 'capability_search',
        rawToolCall: { rawInput: { query: 'release gates' } }
      })
    ).toBe(true)
  })
  it('ignores an unresolvable prose title rather than letting it veto a real rawInput', () => {
    expect(
      isKimiSafeMcpTool({
        toolName: 'Search the workspace',
        rawToolCall: { rawInput: { tool_name: 'mcp__taskwraith__capability_search' } }
      })
    ).toBe(true)
  })
  it('still refuses a title naming a FOREIGN mcp server, even beside a valid identity', () => {
    expect(
      isKimiSafeMcpTool({
        toolName: 'mcp__evil__read_file',
        rawToolCall: { rawInput: { tool_name: 'mcp__taskwraith__read_file', path: 'inside.ts' } }
      })
    ).toBe(false)
  })
  it('recognises a namespaced capability gateway tool as safe (the ensemble-soak bug)', () => {
    expect(
      isKimiSafeMcpTool({
        rawToolCall: {
          rawInput: { tool_name: 'mcp__taskwraith__capability_search' }
        }
      })
    ).toBe(true)
    expect(
      isKimiSafeMcpTool({
        rawToolCall: {
          rawInput: { tool_name: 'mcp__TaskWraith__capability_search' }
        }
      })
    ).toBe(true)
  })
  it('recognises only the exact sanctioned read_file name, not containing lookalikes', () => {
    const request = (tool_name: string) => ({ rawToolCall: { rawInput: { tool_name } } })
    expect(isKimiSafeMcpTool(request('mcp__taskwraith__read_file'))).toBe(true)
    expect(isKimiSafeMcpTool(request('mcp__taskwraith__not_read_file'))).toBe(false)
    expect(isKimiSafeMcpTool(request('mcp__taskwraith__read_file_suffix'))).toBe(false)
  })
  it('treats capability_invoke name as its target argument, not a rival outer identity', () => {
    expect(
      isKimiSafeMcpTool({
        toolName: 'mcp__taskwraith__capability_invoke',
        toolKind: 'execute',
        rawToolCall: {
          kind: 'execute',
          rawInput: {
            tool_name: 'mcp__taskwraith__capability_invoke',
            name: 'mesh_topology_edit',
            arguments: { sceneId: 'scene-a' }
          }
        }
      })
    ).toBe(true)
  })
  it('admits Mesh Canvas calls to the central approval broker on Ask and Plan seats', () => {
    for (const toolName of MESH_MCP_TOOL_NAMES) {
      const request: KimiToolPolicyRequest = {
        toolName: `mcp__taskwraith__${toolName}`,
        toolKind: 'edit'
      }

      expect(isKimiSafeMcpTool(request), toolName).toBe(false)
      expect(isKimiBrokerDeferredMeshMcpTool(request), toolName).toBe(true)
      expect(
        classifyKimiToolPermission(
          request,
          opts({
            writeCapable: false,
            isSafeMcpTool: isKimiSafeMcpTool,
            isBrokerDeferredMcpTool: isKimiBrokerDeferredMeshMcpTool
          })
        ),
        toolName
      ).toBe('gate')
    }
    expect(isKimiBrokerDeferredMeshMcpTool({ toolName: 'mcp__evil__mesh_topology_edit' })).toBe(
      false
    )
    expect(
      isKimiBrokerDeferredMeshMcpTool({ toolName: 'mcp__taskwraith-evil__mesh_topology_edit' })
    ).toBe(false)
    expect(isKimiBrokerDeferredMeshMcpTool({ toolName: 'mesh_topology_edit_suffix' })).toBe(false)
    expect(
      isKimiBrokerDeferredMeshMcpTool({
        toolName: 'mcp__taskwraith__mesh_topology_edit',
        rawToolCall: {
          rawInput: { tool_name: 'mcp__taskwraith__mesh_scene_delete' }
        }
      })
    ).toBe(false)
    const hostile = {
      toolName: 'mcp__taskwraith__mesh_topology_edit',
      toolKind: 'execute',
      rawToolCall: {
        kind: 'execute',
        rawInput: { command: 'touch /tmp/not-a-mesh-call' }
      }
    }
    expect(isKimiBrokerDeferredMeshMcpTool(hostile)).toBe(false)
    expect(
      classifyKimiToolPermission(
        hostile,
        opts({
          writeCapable: false,
          isSafeMcpTool: isKimiSafeMcpTool,
          isBrokerDeferredMcpTool: isKimiBrokerDeferredMeshMcpTool
        })
      )
    ).toBe('deny')
  })
  it('never lets an unknown native identity fall through to a Mesh-shaped name argument', () => {
    const futureNative = {
      toolName: 'FutureExec',
      toolKind: 'execute',
      rawToolCall: { kind: 'execute', rawInput: { name: 'mesh_topology_edit' } }
    }
    const unresolvedRawIdentity = {
      toolName: 'mcp__taskwraith__mesh_topology_edit',
      toolKind: 'execute',
      rawToolCall: {
        kind: 'execute',
        rawInput: { tool_name: 'future_unknown_tool', sceneId: 'scene-a' }
      }
    }
    for (const request of [futureNative, unresolvedRawIdentity]) {
      expect(isKimiBrokerDeferredMeshMcpTool(request)).toBe(false)
      expect(
        classifyKimiToolPermission(
          request,
          opts({
            writeCapable: false,
            isSafeMcpTool: isKimiSafeMcpTool,
            isBrokerDeferredMcpTool: isKimiBrokerDeferredMeshMcpTool
          })
        )
      ).toBe('deny')
    }
  })
  it('treats name as an argument once a primary Mesh identity exists', () => {
    expect(
      isKimiBrokerDeferredMeshMcpTool({
        toolName: 'mcp__taskwraith__mesh_topology_edit',
        rawToolCall: { rawInput: { name: 'Bash', sceneId: 'scene-a' } }
      })
    ).toBe(true)
    expect(
      isKimiDeniedNativeTool({
        toolName: 'mcp__taskwraith__mesh_topology_edit',
        rawToolCall: { rawInput: { name: 'Bash', sceneId: 'scene-a' } }
      })
    ).toBe(false)
  })
  it('recognises the tool name from rawToolCall.rawInput too', () => {
    expect(
      isKimiSafeMcpTool({
        rawToolCall: { rawInput: { tool_name: 'mcp__taskwraith__capability_search' } }
      })
    ).toBe(true)
  })
  it('does not classify a mutating tool as safe', () => {
    expect(isKimiSafeMcpTool({ toolName: 'Write' })).toBe(false)
    expect(isKimiSafeMcpTool({ toolName: 'mcp__taskwraith__ensemble_bossman_control' })).toBe(false)
  })

  it('never treats a human title or foreign MCP namespace as safe provenance', () => {
    for (const toolName of [
      'mcp__taskwraith__read_file',
      'mcp__TaskWraith__read_file',
      'mcp__evil__read_file'
    ]) {
      const request = {
        toolName,
        toolKind: 'edit',
        rawToolCall: {
          kind: 'edit',
          rawInput: { path: 'inside.ts', content: 'pwn' }
        }
      }
      expect(isKimiSafeMcpTool(request), toolName).toBe(false)
      expect(
        classifyKimiToolPermission(
          request,
          opts({ writeCapable: false, isSafeMcpTool: isKimiSafeMcpTool })
        ),
        toolName
      ).toBe('deny')
    }
  })

  it('rejects a stable safe identity that contradicts kind or write shape', () => {
    expect(
      isKimiSafeMcpTool({
        toolKind: 'edit',
        rawToolCall: {
          kind: 'edit',
          rawInput: {
            tool_name: 'mcp__taskwraith__read_file',
            path: 'inside.ts',
            content: 'pwn'
          }
        }
      })
    ).toBe(false)
  })

  it('treats rawInput.name as an identity only when both primary fields are absent', () => {
    expect(
      isKimiSafeMcpTool({
        toolKind: 'read',
        rawToolCall: {
          kind: 'read',
          rawInput: {
            tool_name: 'mcp__taskwraith__read_file',
            name: 'mcp__evil__read_file',
            path: 'inside.ts'
          }
        }
      })
    ).toBe(true)
    expect(isKimiSafeMcpTool({ rawToolCall: { rawInput: { name: 'capability_search' } } })).toBe(
      true
    )
  })
})

describe('classifyKimiToolPermission', () => {
  it('auto-allows a safe / read-only MCP tool', () => {
    const req: KimiToolPolicyRequest = {
      toolName: 'mcp__taskwraith__capability_search',
      toolKind: 'other'
    }
    expect(classifyKimiToolPermission(req, opts({ isSafeMcpTool: () => true }))).toBe('allow')
  })

  it('denies native Bash even when a legacy shell callback says read-only', () => {
    const req: KimiToolPolicyRequest = { toolName: 'Bash', toolKind: 'execute' }
    expect(classifyKimiToolPermission(req, opts({ isReadOnlyShell: () => true }))).toBe('deny')
  })

  it('denies every exact production native-tool name before callbacks or approval', () => {
    for (const toolName of [
      'FetchURL',
      'WebSearch',
      'AgentSwarm',
      'Bash',
      'Glob',
      'Grep',
      'Read',
      'Write',
      'Edit'
    ]) {
      expect(isKimiDeniedNativeTool({ toolName })).toBe(true)
      expect(
        classifyKimiToolPermission(
          { toolName, toolKind: 'read' },
          opts({ isSafeMcpTool: () => true, isReadOnlyShell: () => true })
        )
      ).toBe('deny')
    }
  })

  it('does not auto-allow an unnamed provider-native read/search kind', () => {
    expect(classifyKimiToolPermission({ toolKind: 'read' }, opts())).toBe('gate')
    expect(classifyKimiToolPermission({ toolKind: 'search' }, opts())).toBe('gate')
  })

  it('gates a non-safe broker tool on a write-capable seat', () => {
    expect(
      classifyKimiToolPermission(
        { toolName: 'mcp__taskwraith__write_file', toolKind: 'edit' },
        opts()
      )
    ).toBe('gate')
    // Unknown kind defaults to gate (fail-safe: prompt, not silent-allow).
    expect(classifyKimiToolPermission({ toolKind: 'other' }, opts())).toBe('gate')
  })

  it('denies a mutating tool on a read-only / plan seat', () => {
    expect(
      classifyKimiToolPermission(
        { toolName: 'Write', toolKind: 'edit' },
        opts({ writeCapable: false })
      )
    ).toBe('deny')
    expect(classifyKimiToolPermission({ toolKind: 'execute' }, opts({ writeCapable: false }))).toBe(
      'deny'
    )
  })

  it('auto-allows only sanctioned MCP reads on a read-only seat', () => {
    expect(classifyKimiToolPermission({ toolKind: 'read' }, opts({ writeCapable: false }))).toBe(
      'deny'
    )
    expect(
      classifyKimiToolPermission(
        { toolName: 'mcp__taskwraith__list' },
        opts({ writeCapable: false, isSafeMcpTool: () => true })
      )
    ).toBe('allow')
  })
})
