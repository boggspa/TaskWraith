import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installIpcValidation, validateIpcArgs, IPC_ARGUMENT_SCHEMAS } from './IpcValidation'
import { HOST_CLI_TOOL_IDS } from '../shared/hostCliToolCatalog'

describe('IpcValidation', () => {
  it('runs renderer authorization before dispatching a validated invocation', async () => {
    type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const handlers = new Map<string, InvokeHandler>()
    const ipcMain = {
      handle: vi.fn((channel: string, listener: InvokeHandler) => {
        handlers.set(channel, listener)
      })
    } as unknown as IpcMain
    const authorize = vi.fn(() => {
      throw new Error('secondary renderer denied')
    })
    const listener = vi.fn()
    installIpcValidation(ipcMain, authorize)
    ipcMain.handle('update-settings', listener)

    const event = { sender: { id: 42 } } as unknown as IpcMainInvokeEvent
    await expect(
      Promise.resolve().then(() => handlers.get('update-settings')!(event, {}))
    ).rejects.toThrow('secondary renderer denied')
    expect(authorize).toHaveBeenCalledWith('update-settings', event)
    expect(listener).not.toHaveBeenCalled()
  })

  // `installIpcValidation` wraps EVERY `ipcMain.handle(channel, …)` and
  // calls `validateIpcArgs`, which THROWS "No IPC schema registered for
  // <channel>" when the channel is missing from IPC_ARGUMENT_SCHEMAS — so
  // the handler crashes the first time it's invoked. This has bitten
  // twice as a latent runtime crash (external-path:pick-and-persist in
  // EW71, fx-rates:get later). This test statically extracts every
  // handled channel and asserts each is registered, so the whole class is
  // caught at build time instead of by users. Extracted handlers may use the
  // injected `ipc` alias and locally-declared channel constants, so the scan
  // resolves those forms too; only matching literal `ipcMain.handle` calls is
  // exactly how the Host projection bridge escaped this invariant.
  //
  // The handlers originally all lived in index.ts. As the IPC god-module is
  // broken up into per-domain modules under `src/main/ipc/`, the scan must
  // follow them — otherwise an extracted channel silently leaves this
  // invariant. So we scan index.ts, every `*.ts` (non-test) file under
  // `src/main/ipc/`, and the separately factored canvas IPC module.
  it('registers an arg schema for every ipcMain.handle channel', () => {
    const sources = [readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')]
    const ipcDir = join(process.cwd(), 'src/main/ipc')
    if (existsSync(ipcDir)) {
      for (const entry of readdirSync(ipcDir)) {
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
        sources.push(readFileSync(join(ipcDir, entry), 'utf8'))
      }
    }
    sources.push(readFileSync(join(process.cwd(), 'src/main/canvas/CanvasEmbedIpc.ts'), 'utf8'))
    const handled = new Set<string>()
    const unresolvedConstants = new Set<string>()
    const constantRe = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"`]([^'"`]+)['"`]/g
    const handleRe = /\b(?:ipcMain|ipc)\.handle\(\s*(?:['"`]([^'"`]+)['"`]|([A-Z][A-Z0-9_]*))/g
    for (const source of sources) {
      const constants = new Map<string, string>()
      constantRe.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = constantRe.exec(source)) !== null) {
        constants.set(match[1], match[2])
      }
      handleRe.lastIndex = 0
      while ((match = handleRe.exec(source)) !== null) {
        const channel = match[1] || constants.get(match[2])
        if (!channel) {
          unresolvedConstants.add(match[2])
          continue
        }
        // Skip dynamically-composed channel names (template interpolation);
        // those can't be statically registered.
        if (channel.includes('${')) continue
        handled.add(channel)
      }
    }
    expect([...unresolvedConstants]).toEqual([])
    expect(handled.size).toBeGreaterThan(0)
    const missing = [...handled].filter((channel) => !(channel in IPC_ARGUMENT_SCHEMAS)).sort()
    expect(missing).toEqual([])
  })

  it('shape-gates the Host projection bridge', () => {
    expect(() => validateIpcArgs('host-projection:snapshot', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('host-projection:command-submit', [
        { type: 'host.command', commandId: 'command-1' }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('host-projection:command-submit', [])).toThrow(/object/)
    expect(() => validateIpcArgs('host-projection:command-submit', ['command-1'])).toThrow(/object/)
    expect(() =>
      validateIpcArgs('host-projection:receipt-lookup', [{ commandId: 'command-1' }])
    ).not.toThrow()
    expect(() => validateIpcArgs('host-projection:receipt-lookup', [[]])).toThrow(/object/)
  })

  it('registers Canvas handlers only after the validation wrapper is installed', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    expect(main.indexOf('installIpcValidation(ipcMain')).toBeGreaterThanOrEqual(0)
    expect(main.indexOf('registerCanvasEmbedIpc(ipcMain')).toBeGreaterThan(
      main.indexOf('installIpcValidation(ipcMain')
    )
  })

  it('requires an exact scheduled task id for cancellation', () => {
    expect(() =>
      validateIpcArgs('cancel-scheduled-task', ['task-1', 'Cancelled from test.'])
    ).not.toThrow()
    expect(() => validateIpcArgs('cancel-scheduled-task', [''])).toThrow(/non-empty/)
  })

  it("accepts the 'agents' wildcard only for workspace-grant removal", () => {
    // PermissionService stores consolidated grants under provider 'agents';
    // the removal channel must accept that value or those rows are
    // irrevocable from the grant lists.
    expect(() =>
      validateIpcArgs('remove-agentic-workspace-grant', ['agents', '/repo', 'fileChanges'])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('remove-agentic-workspace-grant', ['claude', '/repo', 'fileChanges'])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('remove-agentic-workspace-grant', ['martians', '/repo', 'fileChanges'])
    ).toThrow(/known provider or 'agents'/)
    // Minting still names the requesting provider, and provider-admission
    // channels must never accept the wildcard.
    expect(() =>
      validateIpcArgs('upsert-agentic-workspace-grant', ['agents', '/repo', 'fileChanges'])
    ).toThrow(/known provider/)
    expect(() => validateIpcArgs('provider:open-login-terminal', ['agents'])).toThrow(
      /known provider/
    )
  })

  it('shape-gates the execution graph command surface', () => {
    expect(() => validateIpcArgs('execution-graphs:diagnostics', [])).not.toThrow()
    expect(() => validateIpcArgs('execution-graphs:list', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('execution-graphs:get', [{ graphId: 'graph-1', revision: 1 }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('execution-runs:list', [{ workspaceId: 'workspace-1' }])
    ).not.toThrow()
    expect(() => validateIpcArgs('execution-runs:get', ['execution-1'])).not.toThrow()
    expect(() => validateIpcArgs('execution-runs:events', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('execution-runs:append-stack-step', ['invalid'])).toThrow(/object/)
    expect(() => validateIpcArgs('execution-runs:cancel', ['execution-1'])).not.toThrow()
    expect(() => validateIpcArgs('execution-runs:formalize', [{}])).not.toThrow()
  })

  it('registers the Project reference-proposal review boundary', () => {
    expect(() => validateIpcArgs('projects:list-reference-proposals', ['project-a'])).not.toThrow()
    expect(() => validateIpcArgs('projects:list-reference-proposals', ['   '])).toThrow(/non-empty/)
    expect(() =>
      validateIpcArgs('projects:review-reference-proposal', [
        { projectId: 'project-a', proposalId: 'proposal-a', decision: 'approve' }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('projects:review-reference-proposal', ['nope'])).toThrow(/object/)
  })

  it('validates Canvas open payloads and embedded bounds deeply', () => {
    expect(() =>
      validateIpcArgs('canvas:open-window', [
        {
          url: 'http://localhost:5173',
          originAllowlist: ['http://localhost:5173'],
          chatId: 'chat-1'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('canvas:open-sketch-window', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('canvas:set-bounds', ['canvas-1', { x: 1, y: 2, width: 800, height: 600 }])
    ).not.toThrow()

    expect(() => validateIpcArgs('canvas:open-window', [{ chatId: '../settings' }])).toThrow(
      /safe chat id/
    )
    expect(() => validateIpcArgs('canvas:open-sketch-window', [{ url: 'https://x.test' }])).toThrow(
      /unknown field/
    )
    expect(() =>
      validateIpcArgs('canvas:set-bounds', ['canvas-1', { x: '1', y: 2, width: 800, height: 600 }])
    ).toThrow(/bounds.x must be a finite number/)
    expect(() =>
      validateIpcArgs('canvas:set-bounds', ['canvas-1', { x: 1, y: 2, width: -1, height: 600 }])
    ).toThrow(/dimensions must be non-negative/)
    expect(() => validateIpcArgs('canvas:set-visible', ['canvas-1', 'false'])).toThrow(/boolean/)
  })

  it('requires chat-scoped native-window IPC and an exact positive generation for detach', () => {
    expect(() => validateIpcArgs('attach-window:pick', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('attach-window:status', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('attach-window:detach', ['chat-1', 7])).not.toThrow()
    expect(() =>
      validateIpcArgs('attach-window:control-session', ['chat-1', 'pause'])
    ).not.toThrow()

    expect(() => validateIpcArgs('attach-window:pick', ['../settings'])).toThrow(/safe chat id/)
    expect(() => validateIpcArgs('attach-window:status', [])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('attach-window:control-session', ['chat-1', ''])).toThrow(
      /non-empty/
    )
    for (const invalidGeneration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateIpcArgs('attach-window:detach', ['chat-1', invalidGeneration])).toThrow(
        /positive safe integer/
      )
    }
    expect(() => validateIpcArgs('attach-window:detach', ['chat-1', 7, 'extra'])).toThrow(
      /too many arguments/
    )
    expect(() =>
      validateIpcArgs('attach-window:control-session', ['chat-1', 'pause', 'extra'])
    ).toThrow(/too many arguments/)
  })

  it('accepts only display-only sticky AppWatch resume hints', () => {
    const stash = {
      chatId: 'chat-1',
      windowMeta: {
        title: 'Editor',
        bundleID: 'com.example.Editor',
        applicationName: 'Editor'
      },
      attachedAt: '2026-07-28T03:00:00.000Z',
      wasStreaming: true
    }
    expect(() => validateIpcArgs('sticky-appwatch:get', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('sticky-appwatch:stash', [stash])).not.toThrow()
    expect(() => validateIpcArgs('sticky-appwatch:clear', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('sticky-appwatch:stash', [{ ...stash, pid: 1234 }])).toThrow(
      /unknown field pid/
    )
    expect(() =>
      validateIpcArgs('sticky-appwatch:stash', [
        { ...stash, windowMeta: { ...stash.windowMeta, windowID: 77 } }
      ])
    ).toThrow(/unknown field windowID/)
  })

  it('registers and shape-gates the main-window Mesh Canvas surface', () => {
    expect(() => validateIpcArgs('mesh-scene:list-chat', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('mesh-scene:view', ['chat-1', 'scene-1'])).not.toThrow()
    expect(() => validateIpcArgs('mesh-scene:import-user-model', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('mesh-scene:import-user-package', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('mesh-scene:delete', ['chat-1', 'scene-1'])).not.toThrow()
    expect(() => validateIpcArgs('mesh-scene:import-user-model', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('mesh-scene:import-user-package', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('mesh-scene:view', ['chat-1', ''])).toThrow(/non-empty/)
  })

  // Explicit pin for the human-collaboration channels: the generic scan above
  // already catches an unregistered channel, but these 13 shipped unregistered
  // (feature DOA + red build), so we hard-pin them so a future drop is named.
  it('registers every human-collaboration IPC channel', () => {
    const collabChannels = [
      'human-collaboration:create-share',
      'human-collaboration:copy-invite',
      'human-collaboration:list-shares',
      'human-collaboration:revoke-share',
      'human-collaboration:consume-invite',
      'human-collaboration:append-comment',
      'human-collaboration:projection',
      'human-collaboration:promote-comment',
      'human-collaboration-runtime:begin-admission',
      'human-collaboration-runtime:confirm-sas',
      'human-collaboration-runtime:subscribe-projection',
      'human-collaboration-runtime:append-comment',
      'human-collaboration-runtime:receive-frame',
      'human-collaboration-runtime:disconnect'
    ]
    for (const channel of collabChannels) {
      expect(channel in IPC_ARGUMENT_SCHEMAS, `${channel} must be registered`).toBe(true)
    }
  })

  it('accepts optional provider usage refresh options', () => {
    expect(() => validateIpcArgs('get-agent-rate-limits', ['claude'])).not.toThrow()
    expect(() =>
      validateIpcArgs('get-agent-rate-limits', ['claude', { force: true }])
    ).not.toThrow()
    expect(() => validateIpcArgs('get-agent-rate-limits', ['claude', 'force'])).toThrow(/object/)
    expect(() => validateIpcArgs('get-codex-usage-snapshot', [])).not.toThrow()
    expect(() => validateIpcArgs('get-codex-usage-snapshot', [{ force: true }])).not.toThrow()
    expect(() => validateIpcArgs('get-codex-usage-snapshot', ['force'])).toThrow(/object/)
  })

  it('validates the work-lock projection channel payload shapes', () => {
    expect(() => validateIpcArgs('work-locks:list', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('work-locks:list', [{ workspacePath: '/repo', chatId: 'chat-1' }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('work-locks:subscribe', [
        { workspacePath: '/repo', chatId: 'chat-1', subscriptionId: 'sub-1' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('work-locks:unsubscribe', [{ subscriptionId: 'sub-1' }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('work-locks:force-release-recovery', [
        { lockId: 'lock-1', workspacePath: '/repo', chatId: 'chat-1' }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('work-locks:list', ['repo'])).toThrow(/object/)
    expect(() => validateIpcArgs('work-locks:subscribe', [])).toThrow(/object/)
    expect(() => validateIpcArgs('work-locks:force-release-recovery', [])).toThrow(/object/)
    expect(() => validateIpcArgs('work-locks:force-release-recovery', ['lock-1'])).toThrow(/object/)
  })

  it('accepts registered and chat-scoped external diff targets', () => {
    expect(() => validateIpcArgs('get-diff', ['/tmp/workspace'])).not.toThrow()
    expect(() =>
      validateIpcArgs('get-diff', [{ repoPath: '/tmp/external-repo', chatId: 'chat-1' }])
    ).not.toThrow()
    expect(() => validateIpcArgs('get-diff', [{ repoPath: 'relative', chatId: 'chat-1' }])).toThrow(
      /absolute workspace path/
    )
    expect(() =>
      validateIpcArgs('get-diff', [{ repoPath: '/tmp/external-repo', chatId: '../settings' }])
    ).toThrow(/safe chat id/)
  })

  it('accepts valid run-agent payloads', () => {
    expect(() =>
      validateIpcArgs('run-agent', [
        {
          scope: 'workspace',
          provider: 'gemini',
          workspace: '/tmp/workspace',
          prompt: 'hello',
          imagePaths: []
        }
      ])
    ).not.toThrow()
  })

  it('accepts global run-agent payloads without workspace paths', () => {
    expect(() => validateIpcArgs('create-global-chat', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('run-agent', [
        {
          scope: 'global',
          provider: 'codex',
          appChatId: 'chat-global-1',
          prompt: 'plan a system-wide task'
        }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('run-agent', [
        {
          scope: 'global',
          provider: 'codex',
          prompt: 'missing chat id'
        }
      ])
    ).toThrow(/chat/)
    expect(() =>
      validateIpcArgs('run-agent', [
        {
          scope: 'global',
          provider: 'codex',
          appChatId: '../settings',
          prompt: 'unsafe chat id'
        }
      ])
    ).toThrow(/safe chat id/)
  })

  it('rejects invalid providers and relative workspaces', () => {
    expect(() =>
      validateIpcArgs('run-agent', [
        { provider: 'bad', workspace: '/tmp/workspace', prompt: 'hello' }
      ])
    ).toThrow(/known provider/)
    expect(() =>
      validateIpcArgs('run-agent', [{ provider: 'gemini', workspace: 'relative', prompt: 'hello' }])
    ).toThrow(/absolute workspace/)
  })

  it('accepts Grok at the IPC trust boundary by default (flag lifted)', () => {
    // 1.0.6 — the experimental gate has been lifted: Grok is a first-class
    // provider admitted at the IPC boundary with no env opt-in.
    expect(() =>
      validateIpcArgs('run-agent', [
        { provider: 'grok', workspace: '/tmp/workspace', prompt: 'hello' }
      ])
    ).not.toThrow()
  })

  it('keeps accepting Grok even with the removed kill-switch env var set', () => {
    // The eligibility gate was removed 2026-06: Grok is permanently first-class,
    // so the old TASKWRAITH_DISABLE_GROK env var no longer hides it. Regression
    // guard against anyone reintroducing a provider-eligibility gate.
    const previous = process.env.TASKWRAITH_DISABLE_GROK
    process.env.TASKWRAITH_DISABLE_GROK = '1'
    try {
      expect(() =>
        validateIpcArgs('run-agent', [
          { provider: 'grok', workspace: '/tmp/workspace', prompt: 'hello' }
        ])
      ).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_DISABLE_GROK
      else process.env.TASKWRAITH_DISABLE_GROK = previous
    }
  })

  it('accepts Cursor structurally at IPC before downstream live admission', () => {
    // Historical Cursor payloads remain decodable; run normalization rejects
    // Cursor through the separate canonical live-provider gate.
    expect(() =>
      validateIpcArgs('run-agent', [
        { provider: 'cursor', workspace: '/tmp/workspace', prompt: 'hello' }
      ])
    ).not.toThrow()
  })

  it('accepts antigravity structurally at IPC before downstream live admission', () => {
    expect(() =>
      validateIpcArgs('run-agent', [
        { provider: 'antigravity', workspace: '/tmp/workspace', prompt: 'hello' }
      ])
    ).not.toThrow()
  })

  it('accepts provider CLI upgrade terminal requests for CLI-backed providers', () => {
    for (const provider of ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'mistral']) {
      expect(() => validateIpcArgs('provider:open-upgrade-terminal', [provider])).not.toThrow()
    }
    expect(() => validateIpcArgs('provider:open-upgrade-terminal', ['bad'])).toThrow(
      /known provider/
    )
  })

  it('bounds host CLI tool ids and mirrors the shared catalog exactly', () => {
    for (const channel of ['host-tool:open-install-terminal', 'host-tool:status']) {
      for (const id of HOST_CLI_TOOL_IDS) {
        expect(() => validateIpcArgs(channel, [id])).not.toThrow()
      }
      // A host tool is not a provider, and vice versa — neither id set may leak
      // into the other's channel.
      expect(() => validateIpcArgs(channel, ['codex'])).toThrow(/host CLI tool/)
      expect(() => validateIpcArgs(channel, [''])).toThrow(/host CLI tool/)
      expect(() => validateIpcArgs(channel, [null])).toThrow(/host CLI tool/)
    }
    // Drift guard: IpcValidation mirrors the catalog rather than importing it,
    // so a new catalog entry would otherwise be silently rejected at the gate.
    for (const id of HOST_CLI_TOOL_IDS) {
      expect(() => validateIpcArgs('host-tool:status', [id])).not.toThrow()
    }
  })

  it('keeps structural Cursor decoding independent of the removed kill switch', () => {
    // The obsolete flag does not alter historical IPC decoding. It also cannot
    // make Cursor live; downstream admission remains unconditionally closed.
    const previous = process.env.TASKWRAITH_DISABLE_CURSOR
    process.env.TASKWRAITH_DISABLE_CURSOR = '1'
    try {
      expect(() =>
        validateIpcArgs('run-agent', [
          { provider: 'cursor', workspace: '/tmp/workspace', prompt: 'hello' }
        ])
      ).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_DISABLE_CURSOR
      else process.env.TASKWRAITH_DISABLE_CURSOR = previous
    }
  })

  it('validates approval actions and external grant access', () => {
    expect(() => validateIpcArgs('respond-agent-approval', ['approval-1', 'accept'])).not.toThrow()
    expect(() =>
      validateIpcArgs('respond-agent-approval', ['approval-1', 'useProviderNative'])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('respond-agent-approval', ['approval-1', 'useTaskWraithSubthread'])
    ).not.toThrow()
    expect(() => validateIpcArgs('respond-agent-approval', ['approval-1', 'maybe'])).toThrow(
      /approval action/
    )
    expect(() => validateIpcArgs('select-external-path-grant', ['execute'])).toThrow(
      /read or write/
    )
  })

  // Regression test for the bug discovered 2026-05-16: the Phase B6
  // ComposerService extraction added a `compose-run` IPC handler but
  // forgot to register a schema in IPC_SCHEMAS, which made the
  // IpcValidation layer throw `No IPC schema registered for
  // compose-run` on every Send-message attempt. Pin the schema's
  // presence so the same bug can't sneak back.
  it('accepts compose-run payloads', () => {
    expect(() =>
      validateIpcArgs('compose-run', [
        {
          chatId: 'chat-1',
          provider: 'gemini',
          scope: 'workspace',
          workspace: '/tmp/workspace',
          userInput: 'hello'
        }
      ])
    ).not.toThrow()
    // Non-object args still rejected.
    expect(() => validateIpcArgs('compose-run', ['just a string'])).toThrow()
  })

  it('accepts post-blackboard-entry payloads', () => {
    expect(() =>
      validateIpcArgs('post-blackboard-entry', [
        {
          chatId: 'chat-1',
          value: 'Keep the synthesis concise.',
          key: 'synthesis-style',
          category: 'decision',
          scope: 'session',
          ttlMinutes: 60
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('post-blackboard-entry', ['just a string'])).toThrow(/object/)
  })

  it('accepts delete-blackboard-entry payloads', () => {
    expect(() =>
      validateIpcArgs('delete-blackboard-entry', [
        {
          chatId: 'chat-1',
          entryId: 'blackboard-1'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('delete-blackboard-entry', ['just a string'])).toThrow(/object/)
  })

  it('accepts clear-blackboard-entries payloads', () => {
    expect(() =>
      validateIpcArgs('clear-blackboard-entries', [
        {
          chatId: 'chat-1'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('clear-blackboard-entries', ['just a string'])).toThrow(/object/)
  })

  // Regression test for the bug reported 2026-05-28 (1.0.6-EW69): the
  // composer workspace-manager add flows (proactive folder grant +
  // attach-known-workspace-as-secondary) go through
  // `external-path:pick-and-persist`, which was never registered in
  // IPC_ARGUMENT_SCHEMAS — so installIpcValidation threw "No IPC schema
  // registered for external-path:pick-and-persist" the moment any add
  // fired. Pin the schema's presence + object-arg shape.
  it('accepts external-path:pick-and-persist payloads', () => {
    expect(() =>
      validateIpcArgs('external-path:pick-and-persist', [{ chatId: 'chat-1', access: 'read' }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('external-path:pick-and-persist', [
        { chatId: 'chat-1', access: 'write', path: '/tmp/workspace' }
      ])
    ).not.toThrow()
    // Non-object args still rejected.
    expect(() => validateIpcArgs('external-path:pick-and-persist', ['nope'])).toThrow()
  })

  it('accepts chat-bound external-path revoke payloads', () => {
    expect(() =>
      validateIpcArgs('external-path:revoke', [
        { chatId: 'chat-1', grantIds: ['grant-1', 'grant-2'] }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('external-path:revoke', ['nope'])).toThrow()
  })

  it('rejects unsafe chat ids for chat persistence IPC', () => {
    expect(() => validateIpcArgs('get-chat-list', [])).not.toThrow()
    expect(() => validateIpcArgs('get-chat-list', ['workspace-1'])).not.toThrow()
    expect(() => validateIpcArgs('get-pinned-messages', [])).not.toThrow()
    expect(() => validateIpcArgs('get-pinned-messages', ['workspace-1'])).not.toThrow()
    expect(() => validateIpcArgs('get-chat', ['../settings'])).toThrow(/safe chat id/)
    expect(() => validateIpcArgs('delete-chat', ['../settings'])).toThrow(/safe chat id/)
    expect(() =>
      validateIpcArgs('save-clipboard-image-attachment', ['chat-1', 'intent-token'])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('save-clipboard-image-attachment', ['../settings', 'intent-token'])
    ).toThrow(/safe chat id/)
    expect(() =>
      validateIpcArgs('rebind-chat-workspace', [
        {
          chatId: 'chat-1',
          scope: 'workspace',
          workspaceId: 'test-3',
          workspacePath: '/Users/chrisizatt/Documents/Test 3'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('rebind-chat-workspace', ['chat-1'])).toThrow()
    expect(() =>
      validateIpcArgs('save-chat', [
        {
          appChatId: '../settings',
          scope: 'global',
          provider: 'gemini',
          title: 'Traversal',
          createdAt: 1,
          updatedAt: 1,
          archived: false,
          messages: [],
          runs: []
        }
      ])
    ).toThrow(/safe chat id/)
  })

  it('accepts ensemble and sub-thread chat IPC payloads', () => {
    expect(() => validateIpcArgs('create-ensemble-chat', [])).not.toThrow()
    expect(() => validateIpcArgs('create-ensemble-chat', [undefined])).not.toThrow()
    expect(() =>
      validateIpcArgs('create-ensemble-chat', [
        { workspaceId: 'workspace-1', workspacePath: '/tmp/workspace' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('run-ensemble-round', [
        { chatId: 'ensemble-1', prompt: 'Review this change', mode: 'normal' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('steer-queued-ensemble-prompt', [
        { chatId: 'ensemble-1', index: 1, textPrefix: 'Queued prompt' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('remove-queued-ensemble-prompt', [
        { chatId: 'ensemble-1', index: 1, textPrefix: 'Queued prompt' }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('cancel-ensemble-round', ['ensemble-1'])).not.toThrow()
    expect(() => validateIpcArgs('skip-ensemble-read-fanout', ['ensemble-1'])).not.toThrow()
    expect(() =>
      validateIpcArgs('skip-ensemble-fanout-lane', ['ensemble-1', 'lane-round-1-reader-1'])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('promote-queued-job-for-steer', [
        { runId: 'run-1', ownerToken: 'owner-1', chatId: 'chat-1' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('lease-promoted-steer-job', [{ runId: 'run-1', ownerToken: 'owner-1' }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('fallback-promoted-steer-job', [
        { runId: 'run-1', ownerToken: 'owner-1', reason: 'timeout' }
      ])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('create-sub-thread', [
        {
          parentChatId: 'parent-1',
          provider: 'claude',
          delegationPrompt: 'Read this module and report risks.',
          returnResultToParent: true,
          workspaceId: 'workspace-1',
          workspacePath: '/tmp/workspace'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('get-sub-threads', ['parent-1'])).not.toThrow()
    expect(() =>
      validateIpcArgs('create-side-chat', [
        {
          parentChatId: 'parent-1',
          chatKind: 'ensemble',
          provider: 'codex',
          title: 'Side chat'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('get-side-chats', ['parent-1'])).not.toThrow()
    expect(() => validateIpcArgs('cancel-ensemble-round', [''])).toThrow(/non-empty/)
  })

  it('does not expose renderer-written durable run events', () => {
    expect(() => validateIpcArgs('append-run-event', [{ runId: 'run-1' }])).toThrow(/No IPC schema/)
    expect(() => validateIpcArgs('append-run-events', [[]])).toThrow(/No IPC schema/)
    expect(() => validateIpcArgs('record-workspace-run-change', [{}])).toThrow(/No IPC schema/)
    expect(() =>
      validateIpcArgs('compute-run-diff', ['run-1', {}, {}, { workspacePath: '/tmp/workspace' }])
    ).not.toThrow()
  })

  it('rejects renderer-written workspace grants', () => {
    expect(() => validateIpcArgs('update-settings', [{ agenticWorkspaceGrants: [] }])).toThrow(
      /workspace grants/
    )
  })

  it('validates welcome heatmap setting patches', () => {
    expect(() =>
      validateIpcArgs('update-settings', [
        {
          welcomeHeatmapPrefs: {
            workspaceActivityEnabled: true,
            taskwraithActivityEnabled: false,
            externalActivityEnabled: true
          }
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('update-settings', [{ welcomeHeatmapPrefs: 'disabled' }])).toThrow(
      /welcomeHeatmapPrefs/
    )
  })

  it('validates dashboard statistic setting patches', () => {
    expect(() =>
      validateIpcArgs('update-settings', [
        {
          dashboardStatPrefs: {
            dashboardEnabled: true,
            dashboardSize: 'small'
          }
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('update-settings', [{ dashboardStatPrefs: 'hidden' }])).toThrow(
      /dashboardStatPrefs/
    )
  })

  it('validates approval timeout setting patches', () => {
    expect(() =>
      validateIpcArgs('update-settings', [
        {
          approvalTimeouts: {
            enabled: false,
            perProviderMs: {
              gemini: 120_000
            }
          }
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('update-settings', [{ approvalTimeouts: 'off' }])).toThrow(
      /approvalTimeouts/
    )
  })

  it('validates audit orchestration setting patches', () => {
    expect(() =>
      validateIpcArgs('update-settings', [
        {
          auditOrchestration: {
            providerAllowlist: ['claude', 'kimi'],
            budgetMaxAgents: 8
          }
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('update-settings', [{ auditOrchestration: 'claude' }])).toThrow(
      /auditOrchestration/
    )
  })

  it('accepts explicit PTY stop requests', () => {
    expect(() => validateIpcArgs('stop-pty', ['terminal-1'])).not.toThrow()
  })

  it('validates safe shell-open bridge arguments', () => {
    expect(() => validateIpcArgs('shell:open-link', ['https://example.com'])).not.toThrow()
    expect(() => validateIpcArgs('shell:open-link', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('favicon:getForUrl', ['https://example.com'])).not.toThrow()
    expect(() => validateIpcArgs('favicon:getForUrl', [''])).toThrow(/non-empty/)
  })

  it('validates fixed packaged legal-notice actions', () => {
    expect(() => validateIpcArgs('licenses:get-status', [])).not.toThrow()
    expect(() => validateIpcArgs('licenses:open-notice', ['third-party'])).not.toThrow()
    expect(() => validateIpcArgs('licenses:open-notice', [''])).toThrow(/non-empty/)
  })

  it('validates sidebar path action identifiers', () => {
    expect(() => validateIpcArgs('sidebar:show-workspace-in-finder', ['ws-1'])).not.toThrow()
    expect(() => validateIpcArgs('sidebar:copy-workspace-directory', ['ws-1'])).not.toThrow()
    expect(() => validateIpcArgs('sidebar:show-workspace-in-finder', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('sidebar:show-chat-workspace-in-finder', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('sidebar:copy-chat-working-directory', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('sidebar:copy-chat-transcript-path', ['chat-1'])).not.toThrow()
    expect(() => validateIpcArgs('sidebar:copy-chat-transcript-path', ['../settings'])).toThrow(
      /safe chat id/
    )
  })

  it('validates archived-thread actions', () => {
    expect(() => validateIpcArgs('unarchive-chat', ['archived-1'])).not.toThrow()
    expect(() => validateIpcArgs('unarchive-chat', [''])).toThrow(/non-empty/)
    expect(() =>
      validateIpcArgs('export-archived-chat', [{ chatId: 'archived-1', format: 'md' }])
    ).not.toThrow()
    expect(() => validateIpcArgs('export-archived-chat', ['archived-1'])).toThrow(/object/)
  })

  it('accepts bridge daemon status and toggle APIs', () => {
    expect(() => validateIpcArgs('bridge-networking-status', [])).not.toThrow()
    expect(() => validateIpcArgs('set-bridge-daemon-enabled', [true])).not.toThrow()
    expect(() => validateIpcArgs('set-bridge-daemon-enabled', ['true'])).toThrow(/boolean/)
  })

  it('accepts bridge allowlist admin APIs', () => {
    expect(() => validateIpcArgs('bridge-allowlist-list', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('bridge-allowlist-upsert', [
        {
          workspaceId: 'Gemini Smoke',
          path: '/Users/example/Desktop/gemini-workbench',
          mode: 'read-write'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('bridge-allowlist-upsert', ['bad'])).toThrow(/object/)
    expect(() => validateIpcArgs('bridge-allowlist-remove', ['Gemini Smoke'])).not.toThrow()
    expect(() => validateIpcArgs('bridge-allowlist-remove', [''])).toThrow(/non-empty/)
    expect(() => validateIpcArgs('bridge-allowlist-clear', [])).not.toThrow()
  })

  it('accepts read-only startup/status APIs used by the shell', () => {
    expect(() => validateIpcArgs('get-claude-auth-status', [])).not.toThrow()
    expect(() => validateIpcArgs('get-kimi-auth-status', [])).not.toThrow()
    expect(() => validateIpcArgs('agentic-yolo-get', [])).not.toThrow()
    expect(() => validateIpcArgs('agentic-yolo-set', [true])).not.toThrow()
    expect(() => validateIpcArgs('agentic-yolo-set', ['true'])).toThrow(/boolean/)
    expect(() =>
      validateIpcArgs('trusted-session-get', [{ chatId: 'chat-1', provider: 'codex' }])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('trusted-session-set', [{ chatId: 'chat-1', provider: 'codex' }, true])
    ).not.toThrow()
    expect(() =>
      validateIpcArgs('trusted-session-set', [{ chatId: 'chat-1', provider: 'codex' }, 'true'])
    ).toThrow(/boolean/)
    expect(() => validateIpcArgs('get-runtime-profiles', ['codex'])).not.toThrow()
    expect(() => validateIpcArgs('get-runtime-profiles', ['bad-provider'])).toThrow(
      /known provider/
    )
    expect(() => validateIpcArgs('get-handoff-cards', [{ provider: 'claude' }])).not.toThrow()
  })

  it('validates Discord context IPC channels', () => {
    expect(() => validateIpcArgs('discord-context:list-targets', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('discord-context:read-channel', [
        {
          guildId: '456789012345678901',
          channelId: '123456789012345678',
          limit: 25
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('discord-context:read-channel', [])).toThrow(/object/)
    expect(() => validateIpcArgs('discord-context:read-channel', ['bad'])).toThrow(/object/)
  })

  it('validates main-owned run queue transition APIs', () => {
    expect(() =>
      validateIpcArgs('request-run-queue-job', [
        {
          runId: 'run-1',
          provider: 'gemini',
          workspacePath: '/tmp/workspace',
          source: 'manual'
        }
      ])
    ).not.toThrow()
    expect(() => validateIpcArgs('lease-run-queue-job', [{ provider: 'gemini' }])).not.toThrow()
    expect(() =>
      validateIpcArgs('transition-run-queue-job', ['run-1', 'completed', {}])
    ).not.toThrow()
    expect(() => validateIpcArgs('transition-run-queue-job', ['run-1', 'bogus', {}])).toThrow(
      /run queue status/
    )
    expect(() => validateIpcArgs('save-run-queue-job', [{}])).toThrow(/No IPC schema/)
  })

  // Tester-feedback intake (1.0.1) — the bugReportPayload guard pins
  // the shape the renderer ships to `submit-bug-report`. Title must
  // be a non-empty string; severity must be one of four; the context
  // block has to carry the five auto-captured strings. Without these
  // guards a malformed payload could slip past IpcValidation and
  // break the markdown file the main process appends to.
  it('accepts a well-formed submit-bug-report payload', () => {
    expect(() => validateIpcArgs('get-app-version', [])).not.toThrow()
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: 'Composer freezes after Cmd+K',
          description: 'Steps...',
          expected: 'Composer accepts input.',
          severity: 'major',
          context: {
            timestamp: '2026-05-24T19:10:00.000Z',
            version: '1.0.1',
            provider: 'codex',
            workspace: '/Users/dev/projects/taskwraith',
            shell: 'default',
            surface: 'Ensemble',
            chatKind: 'ensemble',
            settingsTab: 'mcp',
            inspectorTab: 'safety',
            theme: 'midnight',
            promptBubble: 'blue',
            ensemble: '4 participants'
          }
        }
      ])
    ).not.toThrow()
  })

  it('rejects bug-report payloads with bad severity / empty title / missing context', () => {
    const goodContext = {
      timestamp: '2026-05-24T19:10:00.000Z',
      version: '1.0.1',
      provider: 'codex',
      workspace: '/tmp/ws',
      shell: 'default',
      surface: 'Transcript'
    }
    // Bad severity.
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: 't',
          description: '',
          expected: '',
          severity: 'critical',
          context: goodContext
        }
      ])
    ).toThrow(/severity/)
    // Empty title.
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: '   ',
          description: '',
          expected: '',
          severity: 'minor',
          context: goodContext
        }
      ])
    ).toThrow(/non-empty/)
    // Missing context shape.
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: 't',
          description: '',
          expected: '',
          severity: 'minor'
        }
      ])
    ).toThrow(/context must be an object/)
    // Context missing a required field.
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: 't',
          description: '',
          expected: '',
          severity: 'minor',
          context: { ...goodContext, shell: undefined as unknown as string }
        }
      ])
    ).toThrow(/context\.shell/)
    expect(() =>
      validateIpcArgs('submit-bug-report', [
        {
          title: 't',
          description: '',
          expected: '',
          severity: 'minor',
          context: { ...goodContext, surface: 42 as unknown as string }
        }
      ])
    ).toThrow(/context\.surface/)
  })
})
