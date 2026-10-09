import { describe, expect, it, vi } from 'vitest'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import { buildContainedCursorWriteArgv } from '../cursor/CursorCliArgs'
import { buildGrokAcpCliArgs } from '../grok/GrokCliArgs'
import { buildPiRpcArgs } from '../pi/PiCliArgs'
import {
  cursorNativeFullAccessArgv,
  grokNativeFullAccessArgv,
  piNativeFullAccessArgv,
  mistralNativeFullAccessSessionMode,
  devinNativeFullAccessLaunch,
  nativeFullAccessIsActive,
  PI_FULL_ACCESS_NATIVE_TOOLS
} from './NativeFullAccessLaunchPolicy'

function authority(presetId: 'full_access' | 'workspace_write' | 'plan' = 'full_access') {
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: 'cursor',
    presetId,
    settings: {
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        canvasEval: 'ask',
        networkAccess: 'allow'
      },
      agenticWorkspaceGrants: []
    }
  })
  const run = { runId: 'run-1', status: 'running', state: { effectivePermissions } }
  return {
    manager: { get: vi.fn(() => run), getClaimedTerminalStatus: vi.fn((): unknown => undefined) },
    runId: run.runId,
    run
  }
}

const cursor = { workspace: '/repo', model: 'auto', forceAllowMcpTools: false }
const grok = { model: 'grok-code-fast-1', readOnlySeat: true }
const pi = { upstream: 'anthropic', modelId: 'model', writeCapable: false, sessionDir: '/sessions' }

describe('native launcher policy for admitted Full Access', () => {
  it('enables Cursor native tools without sandbox or MCP approval prompts', () => {
    const args = cursorNativeFullAccessArgv(cursor, authority())
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'disabled'
    ])
    expect(args).toContain('--force')
    expect(args).toContain('--approve-mcps')
    expect(args).not.toContain('--mode')
    expect(args.filter((arg) => arg === '--force')).toHaveLength(1)
  })

  it('removes Grok native allowlist and selects verified bypassPermissions', () => {
    const args = grokNativeFullAccessArgv(grok, authority())
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'bypassPermissions'])
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--deny')
    expect(args.slice(-2)).toEqual(['agent', 'stdio'])
  })

  it('makes all documented Pi native primitives available', () => {
    const args = piNativeFullAccessArgv(pi, authority())
    expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(PI_FULL_ACCESS_NATIVE_TOOLS)
    expect(args).toContain('--no-extensions')
  })

  it('uses advertised Vibe mode and never invents a Devin permission flag', () => {
    expect(mistralNativeFullAccessSessionMode(true, authority())).toEqual({
      configId: 'mode',
      value: 'auto-approve',
      fallbackValues: []
    })
    expect(devinNativeFullAccessLaunch('sonnet', authority())).toEqual({
      args: ['acp', '--model', 'sonnet'],
      autoApproveNativePermissions: true
    })
  })

  it.each(['workspace_write', 'plan'] as const)(
    'leaves every existing %s launcher unchanged',
    (presetId) => {
      const source = authority(presetId)
      expect(cursorNativeFullAccessArgv(cursor, source)).toEqual(
        buildContainedCursorWriteArgv(cursor)
      )
      expect(grokNativeFullAccessArgv(grok, source)).toEqual(buildGrokAcpCliArgs(grok))
      expect(piNativeFullAccessArgv(pi, source)).toEqual(buildPiRpcArgs(pi))
      expect(mistralNativeFullAccessSessionMode(true, source)).toEqual({
        configId: 'mode',
        value: 'plan',
        fallbackValues: []
      })
      expect(devinNativeFullAccessLaunch(undefined, source).autoApproveNativePermissions).toBe(
        false
      )
    }
  )

  it('never elevates a cancelled or absent run', () => {
    const source = authority()
    source.manager.getClaimedTerminalStatus.mockReturnValue('cancelled')
    expect(nativeFullAccessIsActive(source)).toBe(false)
    expect(cursorNativeFullAccessArgv(cursor, source)).toEqual(
      buildContainedCursorWriteArgv(cursor)
    )
    expect(nativeFullAccessIsActive({ ...source, runId: undefined })).toBe(false)
  })

  it('keeps write seats unchanged when the authoritative run is terminal', () => {
    const source = authority()
    source.run.status = 'completed'
    expect(grokNativeFullAccessArgv({ ...grok, readOnlySeat: false }, source)).toEqual(
      buildGrokAcpCliArgs({ ...grok, readOnlySeat: false })
    )
    expect(piNativeFullAccessArgv({ ...pi, writeCapable: true }, source)).toEqual(
      buildPiRpcArgs({ ...pi, writeCapable: true })
    )
    expect(mistralNativeFullAccessSessionMode(false, source)).toEqual({
      configId: 'mode',
      value: 'ask',
      fallbackValues: ['default']
    })
  })

  it('does not duplicate Cursor force when its broker already requires it', () => {
    const args = cursorNativeFullAccessArgv({ ...cursor, forceAllowMcpTools: true }, authority())
    expect(args.filter((arg) => arg === '--force')).toHaveLength(1)
  })

  it('does not infer elevation from shell allow or a provider-supplied model token', () => {
    const source = authority('workspace_write')
    source.run.state.effectivePermissions.agenticServices.shellCommands = 'allow'
    expect(nativeFullAccessIsActive(source)).toBe(false)
    expect(grokNativeFullAccessArgv({ ...grok, model: 'full_access' }, source)).not.toContain(
      'bypassPermissions'
    )
  })
})
