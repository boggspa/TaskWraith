import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-mcp-preview-security-test'
  }
}))

import { createMcpToolApprovalPreviewer } from './McpToolApprovalPreview'
import { taskWraithToolAgenticService } from './NativeApprovalPolicy'
import { PermissionService } from './PermissionService'
import { RunManager } from './RunManager'
import { classifyTool } from './ToolClassTaxonomy'
import { MCP_AUTO_ALLOWED_TOOLS } from './mcp/McpAutoAllowedTools'
import type { GeminiToolContext } from './runStateTypes'
import type { AppSettings } from './store/types'

describe('kill_background_process approval boundary', () => {
  it('agrees across classifiers and cannot inherit a generic mcpTools workspace grant', () => {
    const preview = createMcpToolApprovalPreviewer({
      mediaEditingTools: new Set(),
      providerDisplayName: () => 'Claude',
      optionalString: (value) => (typeof value === 'string' && value.trim() ? value : undefined),
      isRecord: (value): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object' && !Array.isArray(value)),
      ollamaShellApprovalPreviewMetadata: () => ({}),
      ollamaTextDiffPreview: () => '',
      previewPath: (_context, path) => path,
      readApprovalPreviewFileContent: () => null,
      getAttachedWindowMeta: () => null
    })(
      'kill_background_process',
      { processId: 'bg-7' },
      '/repo',
      {
        scope: 'workspace',
        cwd: '/repo',
        workspacePath: '/repo'
      } as GeminiToolContext,
      'claude'
    )

    expect(preview.service).toBe('shellCommands')
    expect(taskWraithToolAgenticService('kill_background_process')).toBe('shellCommands')
    expect(classifyTool('kill_background_process')).toBe('workspace_write')
    expect(MCP_AUTO_ALLOWED_TOOLS.has('kill_background_process')).toBe(false)

    const settings = {
      agenticServices: {
        shellCommands: 'deny',
        fileChanges: 'ask',
        externalPublish: 'ask',
        mcpTools: 'workspace',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        crossThreadRead: 'ask',
        mediaEditing: 'ask',
        mediaRecording: 'deny',
        canvasEval: 'ask',
        networkAccess: 'allow'
      },
      agenticWorkspaceGrants: [
        {
          id: 'generic-mcp-grant',
          provider: 'claude',
          service: 'mcpTools',
          workspacePath: '/repo',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z'
        }
      ]
    } as AppSettings
    const permissionService = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set()
    })

    expect(
      permissionService.resolvePermission('claude', 'mcpTools', '/repo', undefined, settings)
    ).toMatchObject({
      decision: 'allow',
      workspaceGrantAllowed: true
    })
    expect(
      permissionService.resolvePermission('claude', preview.service, '/repo', undefined, settings)
    ).toMatchObject({
      decision: 'deny',
      workspaceGrantAllowed: false,
      sessionGrantAllowed: false
    })
  })
})
