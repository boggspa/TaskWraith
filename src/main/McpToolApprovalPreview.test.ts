import { describe, expect, it, vi } from 'vitest'
import type { GeminiToolContext } from './runStateTypes'
import {
  createMcpToolApprovalPreviewer,
  type McpToolApprovalPreviewDependencies
} from './McpToolApprovalPreview'
import { MEDIA_EDITING_TOOL_NAMES, type TaskWraithMcpToolName } from './TaskWraithMcpTools'

const context = {
  scope: 'workspace',
  cwd: '/repo',
  workspacePath: '/repo'
} as GeminiToolContext

function dependencies(
  overrides: Partial<McpToolApprovalPreviewDependencies> = {}
): McpToolApprovalPreviewDependencies {
  return {
    mediaEditingTools: new Set(MEDIA_EDITING_TOOL_NAMES),
    providerDisplayName: (provider) => provider.toUpperCase(),
    optionalString: (value) => (typeof value === 'string' && value.trim() ? value : undefined),
    isRecord: (value): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    ollamaShellApprovalPreviewMetadata: (command) => ({
      riskLabels: [`risk:${command}`]
    }),
    ollamaTextDiffPreview: (path, before, after) =>
      `diff:${path}:${before === null ? 'null' : before}:${after}`,
    previewPath: (_context, path) => `preview:${path}`,
    readApprovalPreviewFileContent: () => 'before',
    getAttachedWindowMeta: () => ({
      applicationName: 'Code',
      bundleID: 'com.example.code',
      title: 'TaskWraith'
    }),
    ...overrides
  }
}

describe('createMcpToolApprovalPreviewer', () => {
  it('routes every canonical media tool to the dedicated mediaEditing service', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())
    for (const toolName of MEDIA_EDITING_TOOL_NAMES) {
      expect(preview(toolName, {}, '/repo', context).service).toBe('mediaEditing')
    }
  })

  it.each([
    ['audio_analyze', 'analysis'],
    ['audio_render_wav', 'render'],
    ['audio_mix', 'edit']
  ] as const)('keeps %s on the dedicated mediaEditing gate', (toolName, action) => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      toolName,
      { sourcePath: 'track.wav', intent: 'inspect audio' },
      '/repo',
      context,
      'claude'
    )

    expect(preview).toMatchObject({
      title: `Approve CLAUDE media ${action}`,
      service: 'mediaEditing',
      preview: { kind: 'tool', toolName, intent: 'inspect audio' }
    })
    expect(preview.body).toBe(`Intent: inspect audio\n\n${toolName} track.wav`)
  })

  it('shows who a draft addresses and states that nothing is sent', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'Weekly update', body: 'Here it is.' },
      '/repo',
      context,
      'claude'
    )
    expect(preview.title).toBe('Approve CLAUDE Outlook draft')
    // The ceiling is on the prompt itself, not just in documentation.
    expect(preview.body).toContain('Saves a DRAFT — nothing is sent.')
    expect(preview.body).toContain('To: bob@example.com')
    expect(preview.body).toContain('Subject: Weekly update')
    expect(preview.preview).toMatchObject({
      kind: 'tool',
      toolName: 'outlook_create_draft',
      params: { to: ['bob@example.com'], cc: [], subject: 'Weekly update' }
    })
  })

  it('shows every address the draft will carry, including cc and array recipients', () => {
    // Both are ways a prompt could disagree with what is written: a string
    // coercion renders an array as empty, and an unrendered cc is a silent
    // extra recipient. Either one turns the approval into a lie.
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      {
        to: ['bob@example.com', 'carol@example.com'],
        cc: 'exfil@attacker.example',
        subject: 'Weekly update',
        body: 'Here it is.'
      },
      '/repo',
      context,
      'claude'
    )
    expect(preview.body).toContain('To: bob@example.com, carol@example.com')
    expect(preview.body).toContain('Cc: exfil@attacker.example')
    expect(preview.preview).toMatchObject({
      params: {
        to: ['bob@example.com', 'carol@example.com'],
        cc: ['exfil@attacker.example']
      }
    })
  })

  it('renders no Cc line when the draft has none', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'S', body: 'B' },
      '/repo',
      context
    )
    expect(preview.body).not.toContain('Cc:')
  })

  it('states that a calendar entry sends no invitations', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_event',
      { subject: 'Focus block', startIso: '2026-08-01T09:00', endIso: '2026-08-01T10:00' },
      '/repo',
      context
    )
    expect(preview.body).toContain('no attendees, so no invitations are sent')
    expect(preview.body).toContain('2026-08-01T09:00 → 2026-08-01T10:00')
  })

  it('names the mailbox scope for Outlook reads', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_search_messages',
      { query: 'invoice' },
      '/repo',
      context
    )
    expect(preview.title).toContain('Outlook read')
    expect(preview.body).toContain('invoice')
    // `toolName` is the key the run-level network deny classifies on; naming
    // it anything else opts these network reads out of the offline switch.
    expect(preview.preview).toMatchObject({
      kind: 'tool',
      toolName: 'outlook_search_messages'
    })
  })

  it('names every Outlook tool under the key the network kill switch reads', () => {
    const previewer = createMcpToolApprovalPreviewer(dependencies())
    for (const toolName of [
      'outlook_list_messages',
      'outlook_search_messages',
      'outlook_get_message',
      'outlook_list_events',
      'outlook_create_draft',
      'outlook_create_event'
    ] as const) {
      expect(previewer(toolName, {}, '/repo', context).preview).toMatchObject({ toolName })
    }
  })

  it('adds Ollama shell risk metadata without changing the shell gate', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'run_shell_command',
      { command: 'rm -rf dist', reason: 'clean output' },
      '/repo',
      context,
      'ollama'
    )

    expect(preview).toEqual({
      title: 'Approve OLLAMA shell command',
      body: 'Intent: clean output\n\nrm -rf dist\n/repo\n\nThis command cannot be represented as exact file locks. If approved, this invocation runs once outside a workspace sandbox and without workspace locks; it may race active writers.',
      service: 'shellCommands',
      preview: {
        kind: 'command',
        command: 'rm -rf dist',
        cwd: '/repo',
        executionBoundary: 'taskwraith-host-unsandboxed-one-shot',
        workspaceMutationContainment: 'none-explicit-user-one-shot',
        riskLabels: ['risk:rm -rf dist'],
        intent: 'clean output'
      }
    })
  })

  it('keeps a proven read-only shell command on the ordinary host boundary', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'run_shell_command',
      { command: 'ls -la' },
      '/repo',
      context,
      'codex'
    )

    expect(preview.body).not.toContain('without workspace locks')
    expect(preview.preview).toMatchObject({
      executionBoundary: 'taskwraith-host'
    })
    expect(preview.preview).not.toHaveProperty('workspaceMutationContainment')
  })

  it('routes background-process termination through shellCommands with its exact target', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'kill_background_process',
      { processId: 'bg-7', signal: 'SIGKILL', intent: 'stop stale server' },
      '/repo',
      context,
      'claude'
    )

    expect(preview).toEqual({
      title: 'Approve CLAUDE background process termination',
      body: 'Intent: stop stale server\n\nbg-7 (SIGKILL)',
      service: 'shellCommands',
      preview: {
        kind: 'tool',
        toolName: 'kill_background_process',
        params: { processId: 'bg-7', signal: 'SIGKILL', intent: 'stop stale server' },
        intent: 'stop stale server'
      }
    })
  })

  it('renders provider-specific write previews and preserves the raw plan path', () => {
    const deps = dependencies()
    const preview = createMcpToolApprovalPreviewer(deps)(
      'write_file',
      { path: 'notes.md', content: 'after' },
      '/repo',
      context,
      'ollama'
    )

    expect(preview).toMatchObject({
      title: 'Approve OLLAMA file write',
      body: 'preview:notes.md',
      service: 'fileChanges',
      preview: {
        kind: 'fileChange',
        toolName: 'write_file',
        planArtifactRawPath: 'notes.md',
        changes: [{ kind: 'write', path: 'preview:notes.md' }],
        patchPreview: 'diff:preview:notes.md:before:after'
      }
    })
  })

  it('keeps non-Ollama replace previews bounded and human-readable', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'replace',
      { path: 'notes.md', old_string: 'old', new_string: 'new' },
      '/repo',
      context,
      'codex'
    )

    expect(preview.preview.patchPreview).toBe('--- old_string\nold\n+++ new_string\nnew')
    expect(preview.preview.changes).toEqual([{ kind: 'replace', path: 'preview:notes.md' }])
  })

  it('surfaces the image generation endpoint and bounds the prompt preview', () => {
    const prompt = 'x'.repeat(2_100)
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'image_generate',
      { provider: 'xai', prompt },
      '/repo',
      context,
      'kimi'
    )

    expect(preview).toMatchObject({
      title: 'Approve KIMI image generation',
      service: 'fileChanges'
    })
    expect(preview.body).toBe(`Generate via api.x.ai\nPrompt: ${'x'.repeat(2_000)}`)
  })

  it('projects path moves as two explicit file changes', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'move_path',
      { from: 'old.txt', to: 'new.txt', summary: 'reorganize' },
      '/repo',
      context
    )

    expect(preview).toMatchObject({
      title: 'Approve GEMINI path move',
      body: 'Intent: reorganize\n\npreview:old.txt -> preview:new.txt',
      service: 'fileChanges',
      preview: {
        changes: [
          { kind: 'move', path: 'preview:old.txt' },
          { kind: 'move', path: 'preview:new.txt' }
        ]
      }
    })
  })

  it.each([
    ['git_push', 'externalPublish'],
    ['git_create_pr', 'externalPublish'],
    ['git_stage', 'fileChanges'],
    ['git_commit', 'fileChanges']
  ] as const)('routes %s to %s', (toolName, service) => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(toolName, {}, '/repo', context)
    expect(preview.service).toBe(service)
  })

  it('summarizes workspace board plans without copying the full card payload', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'workspace_board_apply_plan',
      { plan: { boardId: 'board-1', name: 'Ship', cards: [{ secret: 'a' }, { secret: 'b' }] } },
      '/repo',
      context,
      'grok'
    )

    expect(preview).toMatchObject({
      title: 'Approve GROK workspace board update',
      body: 'Ship\n2 card proposals',
      service: 'mcpTools',
      preview: { params: { boardId: 'board-1', name: 'Ship', cards: 2 } }
    })
  })

  it('uses the current attached-window metadata for capture and appwatch prompts', () => {
    const getAttachedWindowMeta = vi.fn(dependencies().getAttachedWindowMeta)
    const preview = createMcpToolApprovalPreviewer(dependencies({ getAttachedWindowMeta }))

    expect(preview('attached_window_capture', {}, '/repo', context).body).toBe('Code: TaskWraith')
    expect(preview('appwatch_frames', {}, '/repo', context)).toMatchObject({
      title: 'Pull live frame batch',
      body: 'Code: TaskWraith',
      service: 'mcpTools'
    })
    expect(getAttachedWindowMeta).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['canvas_click', 'canvasInteraction'],
    ['canvas_key', 'canvasInteraction'],
    ['canvas_scroll', 'canvasInteraction'],
    ['canvas_hover', 'canvasInteraction'],
    ['canvas_select', 'canvasInteraction'],
    ['canvas_sketch_update', 'sketchCanvas'],
    ['canvas_eval', 'canvasEval'],
    ['mesh_scene_present', 'meshCanvas'],
    ['tw_recall_read', 'crossThreadRead'],
    ['cancel_subthread', 'subThreadDelegation']
  ] as const)('keeps %s on its dedicated approval service', (toolName, service) => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      toolName,
      {},
      '/repo',
      context,
      'claude'
    )
    expect(preview.service).toBe(service)
  })

  it('routes canvas_open(driver=device) to simulatorCanvas, not mcpTools', () => {
    const previewer = createMcpToolApprovalPreviewer(dependencies())
    expect(
      previewer(
        'canvas_open',
        { url: 'http://localhost:3000' },
        '/repo',
        context,
        'claude'
      ).service
    ).toBe('mcpTools')
    expect(
      previewer(
        'canvas_open',
        { driver: 'device', bundleId: 'com.example.App' },
        '/repo',
        context,
        'claude'
      ).service
    ).toBe('simulatorCanvas')
  })

  it('falls back to a provider-labelled generic MCP approval', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'git_status' as TaskWraithMcpToolName,
      { porcelain: true },
      '/repo',
      context,
      'codex'
    )
    expect(preview).toEqual({
      title: 'Approve CODEX tool call',
      body: 'git_status',
      service: 'mcpTools',
      preview: {
        kind: 'tool',
        toolName: 'git_status',
        params: { porcelain: true }
      }
    })
  })
})

describe('outlook approval discloses what it cannot show', () => {
  it('states the number of body characters it is not rendering', () => {
    // The executor accepts 100k; showing a silent 8k prefix would let an
    // innocuous opening stand in for anything that follows it.
    const body = 'a'.repeat(20_000)
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'S', body },
      '/repo',
      context
    )
    expect(preview.body).toContain('12,000 more characters WILL BE WRITTEN but are not shown')
    // Structured too, so the renderer can show it where the agent's own text
    // cannot imitate it.
    expect(preview.preview).toMatchObject({ params: { hiddenBodyCharacters: 12_000 } })
    // …and the shown prefix is exactly the prefix, with no notice spliced in.
    expect((preview.preview as { params: { body: string } }).params.body).toBe('a'.repeat(8_000))
  })

  it('counts against what will actually be written, not the raw argument', () => {
    // The executor clamps a draft body to 100k, so measuring the argument
    // overstated a 200k body by a full 100k.
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'S', body: 'x'.repeat(200_000) },
      '/repo',
      context
    )
    expect(preview.preview).toMatchObject({ params: { hiddenBodyCharacters: 92_000 } })
  })

  it('counts code points, and never cuts a surrogate pair in half', () => {
    const body = 'a' + '\u{1F600}'.repeat(19_999)
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'S', body },
      '/repo',
      context
    )
    // 20,000 code points in, 8,000 shown.
    expect(preview.preview).toMatchObject({ params: { hiddenBodyCharacters: 12_000 } })
    const shown = (preview.preview as { params: { body: string } }).params.body
    const lastUnit = shown.charCodeAt(shown.length - 1)
    expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false)
  })

  it('shows a whitespace-only subject as written rather than as absent', () => {
    // `optionalString` treats whitespace as absent; the executor does not
    // trim, so "(no subject)" was shown while 4,000 newlines were written.
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: '\n'.repeat(4_000), body: 'B' },
      '/repo',
      context
    )
    expect(preview.body).not.toContain('(no subject)')
  })

  it('clamps preview fields to the caps the executor enforces', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_event',
      {
        subject: 's'.repeat(200_000),
        startIso: '2026-08-01T09:00',
        endIso: '2026-08-01T10:00',
        location: 'l'.repeat(50_000)
      },
      '/repo',
      context
    )
    const params = (preview.preview as { params: { subject: string; location: string } }).params
    expect(params.subject).toHaveLength(4_000)
    expect(params.location).toHaveLength(4_000)
  })

  it('shows a short body verbatim with no disclosure noise', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_draft',
      { to: 'bob@example.com', subject: 'S', body: 'Short and complete.' },
      '/repo',
      context
    )
    expect(preview.body).toContain('Short and complete.')
    expect(preview.body).not.toContain('not shown here')
  })

  it('shows the location and body a calendar entry will carry', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'outlook_create_event',
      {
        subject: 'Focus block',
        startIso: '2026-08-01T09:00',
        endIso: '2026-08-01T10:00',
        location: 'Room 4',
        body: 'Agenda: everything.'
      },
      '/repo',
      context
    )
    expect(preview.body).toContain('Room 4')
    expect(preview.body).toContain('Agenda: everything.')
    expect(preview.preview).toMatchObject({
      params: { location: 'Room 4', body: 'Agenda: everything.' }
    })
  })

  it('clamps an agent-authored intent so it cannot inflate any approval card', () => {
    const preview = createMcpToolApprovalPreviewer(dependencies())(
      'run_shell_command',
      { command: 'ls', intent: 'x'.repeat(5_000) },
      '/repo',
      context
    )
    expect(preview.body.length).toBeLessThan(1_000)
    expect((preview.preview as { intent: string }).intent).toHaveLength(600)
  })
})
