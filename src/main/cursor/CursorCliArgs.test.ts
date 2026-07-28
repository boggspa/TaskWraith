import { describe, it, expect } from 'vitest'
import {
  buildContainedCursorReadOnlyArgv,
  buildContainedCursorWriteArgv,
  buildCursorCliArgs,
  buildCursorProviderCliArgs,
  cursorWriteCapable
} from './CursorCliArgs'
import type { EffectiveRunPermissions } from '../store/types'

const mcpDeniedPermissions: Pick<EffectiveRunPermissions, 'agenticServices'> = {
  agenticServices: {
    shellCommands: 'allow',
    fileChanges: 'allow',
    externalPublish: 'deny',
    mcpTools: 'deny',
    subThreadDelegation: 'deny',
    canvasInteraction: 'deny',
    sketchCanvas: 'deny',
    meshCanvas: 'deny',
    crossThreadRead: 'deny',
    threadMessage: 'deny',
    mediaEditing: 'deny',
    mediaRecording: 'deny',
    canvasEval: 'deny'
  }
}

describe('cursorWriteCapable', () => {
  it('is read-only for plan / empty / unset', () => {
    expect(cursorWriteCapable('plan')).toBe(false)
    expect(cursorWriteCapable('')).toBe(false)
    expect(cursorWriteCapable(null)).toBe(false)
    expect(cursorWriteCapable(undefined)).toBe(false)
  })
  it('is write-capable for any other mode', () => {
    expect(cursorWriteCapable('default')).toBe(true)
    expect(cursorWriteCapable('acceptEdits')).toBe(true)
  })
})

describe('buildCursorCliArgs', () => {
  const base = { prompt: 'do a thing', workspace: '/ws' }
  const discordPrompt = [
    'Summarize build status.',
    '',
    'External Discord channel snapshot context.',
    '<discord_messages channel="123" encoding="markdown-fence">',
    '``` text',
    '[2026-06-16T12:00:00.000Z] alice: CI failed on linux.',
    '```',
    '</discord_messages>'
  ].join('\n')

  it('always uses headless stream-json with --trust + --workspace', () => {
    const args = buildCursorCliArgs(base)
    expect(args).toContain('-p')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args).toContain('--trust')
    expect(args.join(' ')).toContain('--workspace /ws')
    // prompt is the trailing positional
    expect(args[args.length - 1]).toBe('do a thing')
  })

  it('preserves Discord context prompt text as the trailing positional prompt', () => {
    const args = buildCursorCliArgs({ ...base, prompt: discordPrompt, approvalMode: 'default' })

    expect(args[args.length - 1]).toBe(discordPrompt)
    expect(args[args.length - 1]).toContain('External Discord channel snapshot context')
  })

  it('provider wrapper preserves Discord context while forcing read-only without MCP containment', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      prompt: discordPrompt,
      approvalMode: 'default',
      taskWraithMcpActive: false
    })

    expect(args).toContain('plan')
    expect(args[args.length - 1]).toBe(discordPrompt)
    expect(args[args.length - 1]).toContain('<discord_messages')
  })

  it('provider wrapper preserves Discord context with MCP containment active', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      prompt: discordPrompt,
      approvalMode: 'default',
      taskWraithMcpActive: true,
      containmentAttested: true
    })

    expect(args).not.toContain('plan')
    expect(args).toContain('--force')
    expect(args).not.toContain('--approve-mcps')
    expect(args[args.length - 1]).toBe(discordPrompt)
  })

  it('read-only mode passes --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'plan' })
    expect(args.join(' ')).toContain('--mode plan')
  })

  it('an unqualified write-capable request is clamped to --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits' })
    expect(args.join(' ')).toContain('--mode plan')
  })

  it('NEVER passes --force/--yolo WITHOUT the bridge (bare / plan / uncontained)', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', '']) {
      const args = buildCursorCliArgs({ ...base, approvalMode: mode })
      expect(args).not.toContain('--force')
      expect(args).not.toContain('-f')
      expect(args).not.toContain('--yolo')
    }
  })

  it('emits --force ONLY with an active bridge (deny-list containment present), never --yolo', () => {
    // Write seat + bridge → --force (MCP tool calls need it headlessly).
    const write = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      webBridgeActive: true,
      containmentAttested: true
    })
    expect(write).toContain('--force')
    expect(write).not.toContain('--yolo')
    // Read-only-contained seat + safe-subset bridge → --force too.
    const ro = buildCursorCliArgs({
      ...base,
      approvalMode: 'plan',
      readOnlyBridgeActive: true,
      containmentAttested: true
    })
    expect(ro).toContain('--force')
    // Withheld when explicitly disabled (kill-switch) — tools go back to rejected.
    const off = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      webBridgeActive: true,
      containmentAttested: true,
      forceAllowTools: false
    })
    expect(off).not.toContain('--force')
    expect(off).not.toContain('--approve-mcps')
  })

  it('suppresses every MCP widening flag and clamps to plan when the effective posture denies MCP', () => {
    const args = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      webBridgeActive: true,
      readOnlyBridgeActive: true,
      forceAllowTools: true,
      effectivePermissions: mcpDeniedPermissions
    })

    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
    expect(args).not.toContain('--force')
    expect(args).not.toContain('--yolo')
  })

  it('provider wrapper cannot widen an MCP-denied run through stale active-bridge flags', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'default',
      taskWraithMcpActive: true,
      taskWraithReadOnlyMcpActive: true,
      forceAllowMcpTools: true,
      effectivePermissions: mcpDeniedPermissions
    })

    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
    expect(args).not.toContain('--force')
  })

  it('forwards Composer 2.5 model ids without applying reasoning/Fast overrides', () => {
    expect(buildCursorCliArgs({ ...base, model: 'composer-2.5' }).join(' ')).toContain(
      '--model composer-2.5'
    )
    expect(buildCursorCliArgs({ ...base, model: 'composer-2.5-fast' }).join(' ')).toContain(
      '--model composer-2.5-fast'
    )
    expect(
      buildCursorCliArgs({
        ...base,
        model: 'composer-2.5',
        reasoningEffort: 'high',
        fastModeEnabled: true
      }).join(' ')
    ).toContain('--model composer-2.5')
  })

  it('maps Cursor Grok 4.5 reasoning and Fast to concrete Cursor model ids', () => {
    expect(
      buildCursorCliArgs({ ...base, model: 'grok-4.5', reasoningEffort: 'low' }).join(' ')
    ).toContain('--model grok-4.5-medium')
    expect(
      buildCursorCliArgs({ ...base, model: 'grok-4.5', reasoningEffort: 'medium' }).join(' ')
    ).toContain('--model grok-4.5-high')
    expect(
      buildCursorCliArgs({
        ...base,
        model: 'grok-4.5',
        reasoningEffort: 'high',
        fastModeEnabled: true
      }).join(' ')
    ).toContain('--model grok-4.5-fast-xhigh')
  })

  it('drops non-Cursor / sentinel / leaked model ids', () => {
    for (const m of ['gpt-5', 'cli-default', 'flash-lite', 'sonnet-4', '']) {
      expect(buildCursorCliArgs({ ...base, model: m })).not.toContain('--model')
    }
  })

  it('appends --resume for a real chat id, not for empty', () => {
    expect(buildCursorCliArgs({ ...base, providerSessionId: 'chat_123' }).join(' ')).toContain(
      '--resume chat_123'
    )
    expect(buildCursorCliArgs({ ...base, providerSessionId: '   ' })).not.toContain('--resume')
  })

  it('never emits aggregate --approve-mcps, including for an attested bridge', () => {
    for (const args of [
      buildCursorCliArgs({
        ...base,
        approvalMode: 'acceptEdits',
        webBridgeActive: true,
        containmentAttested: true
      }),
      buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits', webBridgeActive: false }),
      buildCursorCliArgs({ ...base, approvalMode: 'plan', webBridgeActive: true })
    ]) {
      expect(args).not.toContain('--approve-mcps')
    }
  })

  it('with the bridge active passes --force (contained) but NEVER --yolo', () => {
    const args = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      webBridgeActive: true,
      containmentAttested: true
    })
    expect(args).toContain('--force')
    expect(args).not.toContain('--yolo')
  })
})

describe('read-only safe-subset bridge (Grok parity)', () => {
  const base = { prompt: 'read a thing', workspace: '/ws' }

  it('attested read-only bridge runs contained default mode with --force but never --approve-mcps', () => {
    const args = buildCursorCliArgs({
      ...base,
      approvalMode: 'plan',
      readOnlyBridgeActive: true,
      containmentAttested: true
    })
    // Contained default mode: --mode plan would execute NO tools, so it's suppressed.
    expect(args).not.toContain('plan')
    expect(args).not.toContain('--approve-mcps')
    // --force so the (safe-subset) MCP read tools execute headlessly; the broker
    // advertises only read tools + the deny-list blocks native writes, so it's
    // strictly contained. NEVER --yolo.
    expect(args).toContain('--force')
    expect(args).not.toContain('--yolo')
  })

  it('read-only WITHOUT the bridge still runs --mode plan and no --approve-mcps', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'plan' })
    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
  })

  it('readOnlyBridgeActive is ignored for a write-capable seat (write path owns the bridge)', () => {
    // Write-capable + readOnlyBridgeActive but no webBridgeActive → no flag.
    const args = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      readOnlyBridgeActive: true
    })
    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
  })

  it('provider wrapper: attested read-only seat can enter contained default mode', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'plan',
      taskWraithMcpActive: false,
      taskWraithReadOnlyMcpActive: true,
      containmentAttested: true
    })
    expect(args).not.toContain('plan')
    expect(args).toContain('--force')
    expect(args).not.toContain('--approve-mcps')
  })

  it('provider wrapper: attested full write bridge wins over the read-only flag', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'default',
      taskWraithMcpActive: true,
      taskWraithReadOnlyMcpActive: true,
      containmentAttested: true
    })
    expect(args).not.toContain('plan')
    expect(args).toContain('--force')
    expect(args).not.toContain('--approve-mcps')
  })

  it('provider wrapper: no bridge at all → read-only plan mode, no --approve-mcps', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'plan',
      taskWraithMcpActive: false,
      taskWraithReadOnlyMcpActive: false
    })
    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
  })

  it('unqualified stale bridge flags remain plan/no-tools', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'default',
      taskWraithMcpActive: true,
      taskWraithReadOnlyMcpActive: true
    })
    expect(args.join(' ')).toContain('--mode plan')
    expect(args).not.toContain('--approve-mcps')
    expect(args).not.toContain('--force')
  })

  it('adds project-config isolation flags before the trailing prompt', () => {
    const args = buildCursorCliArgs({ ...base, isolateProjectConfigs: true })
    expect(args).toContain('--disable-project-configs')
    expect(args).toContain('--exclude-workspace-context')
    expect(args.at(-1)).toBe(base.prompt)
  })
})

describe('buildContainedCursorReadOnlyArgv (Path B contained read-only runtime)', () => {
  const base = { workspace: '/ws', prompt: 'read the repo' }
  const DANGEROUS_TOKENS = ['--force', '-f', '--yolo', '--approve-mcps', '--api-key']

  it('hard-pins the native sandbox and a read-only mode with the workspace + prompt', () => {
    const args = buildContainedCursorReadOnlyArgv(base)
    expect(args).toContain('-p')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args).toContain('--trust')
    // --sandbox is always immediately followed by `enabled` (never `disabled`).
    expect(args.join(' ')).toContain('--sandbox enabled')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled')
    expect(args).toContain('--skip-worktree-setup')
    // Default read-only mode is `ask`.
    expect(args.join(' ')).toContain('--mode ask')
    expect(args.join(' ')).toContain('--workspace /ws')
    // Prompt is the trailing positional, guarded by an end-of-options `--`.
    expect(args[args.length - 1]).toBe('read the repo')
    expect(args[args.length - 2]).toBe('--')
  })

  it('guards the prompt behind `--` so a flag-shaped prompt cannot inject a cursor-agent flag', () => {
    // Live-verified: cursor-agent parses options INTERSPERSED, so without the
    // `--` guard a prompt of "--sandbox disabled" / "--force" would be reparsed as
    // a real flag (disabling the sandbox or widening tools). The guard forces the
    // prompt to be a positional after the real, load-bearing flags.
    for (const prompt of ['--sandbox disabled', '--force', '--yolo', '--approve-mcps', '--version']) {
      const args = buildContainedCursorReadOnlyArgv({ workspace: '/ws', prompt })
      const guard = args.indexOf('--')
      expect(guard).toBeGreaterThan(-1)
      // The prompt is the ONLY token after the guard.
      expect(args.slice(guard + 1)).toEqual([prompt])
      // The real --sandbox enabled flag is before the guard and still reads enabled.
      expect(args.indexOf('--sandbox')).toBeLessThan(guard)
      expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled')
    }
  })

  it('honors an explicit read-only mode (`plan`)', () => {
    const args = buildContainedCursorReadOnlyArgv({ ...base, mode: 'plan' })
    expect(args.join(' ')).toContain('--mode plan')
    expect(args.join(' ')).not.toContain('--mode ask')
  })

  it('NEVER emits any write-widening / sandbox-disabling / api-key token', () => {
    for (const input of [
      base,
      { ...base, mode: 'plan' as const },
      { ...base, model: 'composer-2.5' },
      { ...base, model: 'gpt-5' }
    ]) {
      const args = buildContainedCursorReadOnlyArgv(input)
      for (const token of DANGEROUS_TOKENS) {
        expect(args).not.toContain(token)
      }
      // Sandbox may only ever be enabled, never disabled.
      expect(args.join(' ')).not.toContain('--sandbox disabled')
      expect(args).not.toContain('disabled')
    }
  })

  it('normalizes a requested Cursor model and coerces a leaked id to a concrete Cursor default', () => {
    expect(buildContainedCursorReadOnlyArgv({ ...base, model: 'composer-2.5' }).join(' ')).toContain(
      '--model composer-2.5'
    )
    // A non-Cursor / leaked id is coerced to a concrete Cursor model, never passed through.
    const leaked = buildContainedCursorReadOnlyArgv({ ...base, model: 'gpt-5' })
    expect(leaked.join(' ')).toContain('--model composer-2.5-fast')
    expect(leaked).not.toContain('gpt-5')
  })

  it('omits --model entirely when no model is requested (falls back to the account default)', () => {
    for (const model of [undefined, null, '']) {
      const args = buildContainedCursorReadOnlyArgv({ ...base, model })
      expect(args).not.toContain('--model')
    }
  })
})

describe('buildContainedCursorWriteArgv (Path B contained WRITE runtime)', () => {
  const base = { workspace: '/ws', prompt: 'edit the repo' }
  const DANGEROUS_TOKENS = ['--force', '-f', '--yolo', '--approve-mcps', '--api-key']

  it('uses default (write-capable) mode but keeps the sandbox, worktree skip, and prompt guard', () => {
    const args = buildContainedCursorWriteArgv(base)
    // Default mode => NO --mode flag; that is what exposes cursor's write+shell tools.
    expect(args).not.toContain('--mode')
    // Containment is still hard-pinned.
    expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled')
    expect(args).toContain('--skip-worktree-setup')
    // Prompt is the trailing positional, guarded by the end-of-options `--`.
    expect(args[args.length - 2]).toBe('--')
    expect(args[args.length - 1]).toBe('edit the repo')
  })

  it('never emits any write-widening / sandbox-disabling / api-key token', () => {
    for (const input of [base, { ...base, model: 'composer-2.5' }, { ...base, model: 'gpt-5' }]) {
      const args = buildContainedCursorWriteArgv(input)
      for (const token of DANGEROUS_TOKENS) expect(args).not.toContain(token)
      expect(args.join(' ')).not.toContain('--sandbox disabled')
    }
  })

  it('guards a flag-shaped prompt behind `--` (inert) while the real sandbox stays enabled', () => {
    for (const prompt of ['--sandbox disabled', '--force', '--yolo']) {
      const args = buildContainedCursorWriteArgv({ workspace: '/ws', prompt })
      const guard = args.indexOf('--')
      expect(args.slice(guard + 1)).toEqual([prompt])
      expect(args.indexOf('--sandbox')).toBeLessThan(guard)
      expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled')
    }
  })

  it('normalizes a requested model and omits --model when absent', () => {
    expect(buildContainedCursorWriteArgv({ ...base, model: 'gpt-5' }).join(' ')).toContain(
      '--model composer-2.5-fast'
    )
    expect(buildContainedCursorWriteArgv({ ...base, model: undefined })).not.toContain('--model')
  })
})
