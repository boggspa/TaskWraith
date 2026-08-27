import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  dismissMeshCanvasView,
  MeshCanvasPanel,
  MeshCanvasPanelStatus,
  toMeshSceneSummary
} from './MeshCanvasPanel'

describe('toMeshSceneSummary', () => {
  it('decodes a renderer-safe summary and ignores unrelated payload fields', () => {
    expect(
      toMeshSceneSummary({
        sceneId: 'mesh-a',
        title: 'Material study',
        nodeCount: 3,
        importCount: 1,
        primitiveCount: 2,
        editableCount: 1,
        backgroundColor: '#102030',
        updatedAt: '2026-07-27T12:00:00.000Z',
        presentedAt: '2026-07-27T12:01:00.000Z',
        workspacePath: '/not-renderer-data'
      })
    ).toEqual({
      sceneId: 'mesh-a',
      title: 'Material study',
      nodeCount: 3,
      importCount: 1,
      primitiveCount: 2,
      editableCount: 1,
      backgroundColor: '#102030',
      updatedAt: '2026-07-27T12:00:00.000Z',
      presentedAt: '2026-07-27T12:01:00.000Z'
    })
  })

  it('rejects a missing scene id and supplies safe display defaults', () => {
    expect(toMeshSceneSummary(null)).toBeNull()
    expect(toMeshSceneSummary({ title: 'Missing id' })).toBeNull()
    expect(toMeshSceneSummary({ sceneId: 'mesh-b' })).toEqual({
      sceneId: 'mesh-b',
      title: 'Mesh scene',
      nodeCount: 0,
      importCount: 0,
      primitiveCount: 0,
      editableCount: 0,
      backgroundColor: '#171a21',
      updatedAt: ''
    })
  })
})

describe('MeshCanvasPanel (static render)', () => {
  it('offers the local Mesh Canvas surface with a non-destructive dismiss action', () => {
    const html = renderToStaticMarkup(
      <MeshCanvasPanel chatId="chat-mesh-static" onDismiss={() => undefined} />
    )
    expect(html).toContain('Mesh Canvas')
    expect(html).toContain('Human and agent-built 3D scenes stay local to this chat.')
    expect(html).toContain('Import 3D scene or model')
    expect(html).toContain('Import scene package')
    expect(html).toContain('Dismiss')
    expect(html).toContain('Dismiss Mesh Canvas without deleting the scene or its files')
    expect(html).toContain('taskwraith.mesh-scene.json')
    expect(html).toContain('No Mesh Canvas scene has been created in this chat yet.')
    expect(html).not.toContain('Delete')
    expect(html).not.toContain('twmesh://')
  })

  it('replaces the empty state with an error when no scene can be viewed', () => {
    const html = renderToStaticMarkup(
      <MeshCanvasPanelStatus
        hasView={false}
        hasScenes={false}
        issue="The Mesh Canvas scene is unavailable."
      />
    )
    expect(html).toContain('The Mesh Canvas scene is unavailable.')
    expect(html).not.toContain('No Mesh Canvas scene has been created in this chat yet.')
  })

  it('does not expose the scene-deletion IPC from the dismiss control', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/MeshCanvasPanel.tsx'),
      'utf8'
    )
    expect(source).toContain('await dismissMeshCanvasView({')
    expect(source).toContain('api.closePresentation(targetChatId, sceneId)')
    expect(source).toContain('useImperativeHandle(ref, () => ({ dismiss }), [dismiss])')
    expect(source).toContain('onDismiss()')
    expect(source).not.toContain('api.deleteScene(')
    expect(source).not.toContain('mesh-canvas-delete')
  })

  it('closes a presentation before every dismiss entry point returns home', async () => {
    const order: string[] = []
    const closePresentation = vi.fn(async () => {
      order.push('close-presentation')
    })
    const refresh = vi.fn(async () => {
      order.push('refresh')
    })
    const onDismiss = vi.fn(() => {
      order.push('dismiss')
    })

    await dismissMeshCanvasView({
      chatId: 'chat-mesh',
      sceneId: 'scene-1',
      isPresented: true,
      closePresentation,
      refresh,
      onIssue: vi.fn(),
      onDismiss
    })

    expect(order).toEqual(['close-presentation', 'refresh', 'dismiss'])
    expect(closePresentation).toHaveBeenCalledWith('chat-mesh', 'scene-1')
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
