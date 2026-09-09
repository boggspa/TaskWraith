import { describe, expect, it } from 'vitest'
import { createRunToolCapabilityReceipt } from '../providers/RunToolCapabilityReceipt'
import {
  configurePiRunToolReceipt,
  piToolsFromArgs,
  recordPiAttachedTools
} from './PiToolCapabilityEvidence'

const reporter = () =>
  createRunToolCapabilityReceipt({
    runId: 'run',
    chatId: 'chat',
    provider: 'pi',
    model: null,
    transport: 'pi-rpc',
    effectivePermissions: null,
    scope: { kind: 'global', workspacePath: null, paths: [] }
  })

const NATIVE = ['read', 'grep', 'find', 'ls']
const MANAGED = ['taskwraith_send', 'taskwraith_yield']

describe('configurePiRunToolReceipt', () => {
  it('records both host-arranged lists as advertised, never as observed or served', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
    const s = r.snapshot()
    expect(s.native.advertised?.names).toEqual(NATIVE)
    expect(s.managed.advertised?.names).toEqual(MANAGED)
    expect(s.native.observed).toBeNull()
    expect(s.managed.observed).toBeNull()
    expect(s.native.served).toBeNull()
    expect(s.managed.served).toBeNull()
    expect(s.native.attached).toBeNull()
    expect(s.managed.attached).toBeNull()
  })

  it('does not claim the route is ready merely because it was configured', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
    expect(r.snapshot().connection).toBe('configured')
    expect(r.snapshot().readiness).toBe('unverified')
  })

  it('reports the exact preparation failure as an unavailable route', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: false,
      failure: 'This lane disables managed coordination.'
    })
    expect(r.snapshot()).toMatchObject({
      connection: 'unavailable',
      blocker: 'This lane disables managed coordination.',
      readiness: 'degraded'
    })
  })

  it('leaves connection unknown for a run that never wanted managed tools', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, { nativeTools: NATIVE, managedTools: [], managedPrepared: false })
    const s = r.snapshot()
    expect(s.connection).toBe('unknown')
    expect(s.managed.advertised).toBeNull()
    expect(s.native.advertised?.names).toEqual(NATIVE)
  })
})

describe('recordPiAttachedTools', () => {
  it('promotes the managed route only once the extension confirms it attached', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
    expect(r.snapshot().readiness).toBe('unverified')

    expect(recordPiAttachedTools(r, MANAGED)).toBe(true)
    const s = r.snapshot()
    expect(s.managed.attached?.names).toEqual(MANAGED)
    expect(s.managed.attached?.source).toBe('extension-ready')
    expect(s.connection).toBe('ready')
    expect(s.readiness).toBe('available')
  })

  it('never reads the marker as Pi observing its own catalogue', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
    recordPiAttachedTools(r, MANAGED)
    const s = r.snapshot()
    expect(s.managed.observed).toBeNull()
    expect(s.native.observed).toBeNull()
    expect(s.native.attached).toBeNull()
    expect(s.managed.executedComplete).toBe(false)
    expect(s.native.executedComplete).toBe(false)
  })

  it('records nothing for an empty list and tolerates an absent receipt', () => {
    const r = reporter()
    configurePiRunToolReceipt(r, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
    expect(recordPiAttachedTools(r, [])).toBe(false)
    expect(r.snapshot().managed.attached).toBeNull()
    expect(recordPiAttachedTools(null, MANAGED)).toBe(false)
    expect(recordPiAttachedTools(undefined, MANAGED)).toBe(false)
    configurePiRunToolReceipt(null, {
      nativeTools: NATIVE,
      managedTools: MANAGED,
      managedPrepared: true
    })
  })
})

describe('piToolsFromArgs', () => {
  it('reads the exact comma-joined allowlist the run was launched with', () => {
    expect(
      piToolsFromArgs([
        '--mode',
        'rpc',
        '--tools',
        'read,grep,taskwraith_send',
        '--session-id',
        'x'
      ])
    ).toEqual(['read', 'grep', 'taskwraith_send'])
  })

  it('returns nothing when the host passed no allowlist', () => {
    expect(piToolsFromArgs(['--mode', 'rpc'])).toEqual([])
    expect(piToolsFromArgs(['--mode', 'rpc', '--tools'])).toEqual([])
    expect(piToolsFromArgs([])).toEqual([])
  })

  it('drops blank entries rather than advertising an empty tool name', () => {
    expect(piToolsFromArgs(['--tools', 'read,,  ,grep'])).toEqual(['read', 'grep'])
  })
})
