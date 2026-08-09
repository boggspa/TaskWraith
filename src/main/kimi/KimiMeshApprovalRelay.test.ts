import { describe, expect, it } from 'vitest'
import { KimiMeshApprovalRelay, kimiMeshArgumentsFromAcpToolCall } from './KimiMeshApprovalRelay'

describe('KimiMeshApprovalRelay', () => {
  it('consumes one exact route/tool/argument receipt and ignores key order', () => {
    const relay = new KimiMeshApprovalRelay(() => 1_000)
    expect(
      relay.issue({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_topology_edit',
        arguments: {
          sceneId: 'scene-a',
          expectedRevision: 2,
          operations: [{ operation: 'move_vertices', vertices: [] }]
        }
      })
    ).toBe(true)
    expect(
      relay.consume({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_topology_edit',
        arguments: {
          operations: [{ vertices: [], operation: 'move_vertices' }],
          expectedRevision: 2,
          sceneId: 'scene-a'
        }
      })
    ).toBe(true)
    expect(
      relay.consume({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_topology_edit',
        arguments: {
          sceneId: 'scene-a',
          expectedRevision: 2,
          operations: [{ operation: 'move_vertices', vertices: [] }]
        }
      })
    ).toBe(false)
  })

  it('accepts nested MCP arguments but rejects replay, route drift, and argument drift', () => {
    let now = 5_000
    const relay = new KimiMeshApprovalRelay(() => now, 100)
    const issue = () =>
      relay.issue({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    expect(issue()).toBe(true)
    expect(
      relay.consume({
        appRunId: 'run-b',
        appChatId: 'chat-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    ).toBe(false)
    expect(
      relay.consume({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-b' }
      })
    ).toBe(false)
    expect(
      relay.consume({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    ).toBe(true)

    expect(issue()).toBe(true)
    now = 5_100
    expect(
      relay.consume({
        appRunId: 'run-a',
        appChatId: 'chat-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    ).toBe(false)
  })

  it('fails closed without a complete route or JSON tool input', () => {
    const relay = new KimiMeshApprovalRelay()
    expect(
      relay.issue({
        appRunId: 'run-a',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    ).toBe(false)
    expect(
      relay.issue({
        appRunId: '',
        appChatId: '',
        toolName: 'mesh_scene_present',
        arguments: { sceneId: 'scene-a' }
      })
    ).toBe(false)
  })

  it('extracts the exact bounded arguments shown on the outer approval card', () => {
    expect(
      kimiMeshArgumentsFromAcpToolCall('mesh_topology_edit', {
        rawInput: {
          tool_name: 'mcp__taskwraith__mesh_topology_edit',
          name: 'mesh_topology_edit',
          operations: [{ vertices: ['v2', 'v1'], operation: 'move_vertices' }],
          sceneId: 'scene-a',
          expectedRevision: 2
        }
      })
    ).toEqual({
      expectedRevision: 2,
      operations: [{ operation: 'move_vertices', vertices: ['v2', 'v1'] }],
      sceneId: 'scene-a'
    })
    expect(
      kimiMeshArgumentsFromAcpToolCall('mesh_scene_present', {
        rawInput: {
          tool_name: 'mcp__taskwraith__mesh_scene_present',
          arguments: { sceneId: 'scene-a' }
        }
      })
    ).toEqual({ sceneId: 'scene-a' })
    expect(kimiMeshArgumentsFromAcpToolCall('mesh_scene_present', null)).toBeNull()
  })
})
