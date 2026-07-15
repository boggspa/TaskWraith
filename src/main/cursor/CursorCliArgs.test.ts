import { describe, it, expect } from 'vitest'
import { buildCursorCliArgs, buildCursorProviderCliArgs, cursorWriteCapable } from './CursorCliArgs'
import type { EffectiveRunPermissions } from '../store/types'

const mcpDeniedPermissions: Pick<EffectiveRunPermissions, 'agenticServices'> = {
  agenticServices: {
    shellCommands: 'allow',
    fileChanges: 'allow',
    externalPublish: 'deny',
    mcpTools: 'deny',
    subThreadDelegation: 'deny',
    canvasInteraction: 'deny',
    crossThreadRead: 'deny',
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
      taskWraithMcpActive: true
    })

    expect(args).not.toContain('plan')
    expect(args).toContain('--approve-mcps')
    expect(args[args.length - 1]).toBe(discordPrompt)
  })

  it('read-only mode passes --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'plan' })
    expect(args.join(' ')).toContain('--mode plan')
  })

  it('write-capable mode omits --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits' })
    expect(args).not.toContain('plan')
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
    const write = buildCursorCliArgs({ ...base, approvalMode: 'default', webBridgeActive: true })
    expect(write).toContain('--force')
    expect(write).not.toContain('--yolo')
    // Read-only-contained seat + safe-subset bridge → --force too.
    const ro = buildCursorCliArgs({ ...base, approvalMode: 'plan', readOnlyBridgeActive: true })
    expect(ro).toContain('--force')
    // Withheld when explicitly disabled (kill-switch) — tools go back to rejected.
    const off = buildCursorCliArgs({
      ...base,
      approvalMode: 'default',
      webBridgeActive: true,
      forceAllowTools: false
    })
    expect(off).not.toContain('--force')
    expect(off).toContain('--approve-mcps')
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

  it('adds --approve-mcps only for write-capable runs with the TaskWraith MCP bridge active', () => {
    // Write-capable + bridge → flag present.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits', webBridgeActive: true })
    ).toContain('--approve-mcps')
    // Write-capable but bridge NOT active (e.g. config write failed) → no flag.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits', webBridgeActive: false })
    ).not.toContain('--approve-mcps')
    // Plan mode never executes MCP tools → never flag it, even if asked.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'plan', webBridgeActive: true })
    ).not.toContain('--approve-mcps')
    // Default (no webBridgeActive) → no flag.
    expect(buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits' })).not.toContain(
      '--approve-mcps'
    )
  })

  it('with the bridge active passes --force (contained) but NEVER --yolo', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'default', webBridgeActive: true })
    expect(args).toContain('--force')
    expect(args).not.toContain('--yolo')
  })
})

describe('read-only safe-subset bridge (Grok parity)', () => {
  const base = { prompt: 'read a thing', workspace: '/ws' }

  it('read-only + readOnlyBridgeActive runs CONTAINED default mode (no --mode plan) with --approve-mcps + --force', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'plan', readOnlyBridgeActive: true })
    // Contained default mode: --mode plan would execute NO tools, so it's suppressed.
    expect(args).not.toContain('plan')
    expect(args).toContain('--approve-mcps')
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
    expect(args).not.toContain('plan')
    expect(args).not.toContain('--approve-mcps')
  })

  it('provider wrapper: read-only seat with taskWraithReadOnlyMcpActive → contained default mode + --approve-mcps', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'plan',
      taskWraithMcpActive: false,
      taskWraithReadOnlyMcpActive: true
    })
    expect(args).not.toContain('plan')
    expect(args).toContain('--approve-mcps')
  })

  it('provider wrapper: full write bridge wins over the read-only flag (single --approve-mcps, no plan)', () => {
    const args = buildCursorProviderCliArgs({
      ...base,
      approvalMode: 'default',
      taskWraithMcpActive: true,
      taskWraithReadOnlyMcpActive: true
    })
    expect(args).not.toContain('plan')
    expect(args.filter((a) => a === '--approve-mcps')).toHaveLength(1)
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
})
