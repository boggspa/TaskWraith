import { describe, it, expect, vi } from 'vitest'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import type { NativeWorkspaceToolPreflight } from './NativeWorkspaceToolGate'
import {
  NATIVE_WRITE_UNCAPTURABLE_REASON,
  createNativeWriteContributionCapture,
  type NativeWriteCaptureDeps,
  type NativeWriteJournalEntry
} from './NativeWriteContributionCapture'

const WORKSPACE = '/ws'
const FILE = '/ws/src/a.ts'

function allowPreflight(
  canonicalTool: string,
  paths: string[] = [FILE]
): NativeWorkspaceToolPreflight {
  return {
    kind: 'allow',
    canonicalTool,
    source: 'native',
    service: 'fileChanges',
    access: 'write',
    checkedPaths: paths,
    requiresRuntimeSandbox: false
  }
}

function request(toolCallId: string | null = 'call-1', toolName = 'Edit'): AcpPermissionRequest {
  return {
    toolName,
    toolKind: 'edit',
    rawToolCall: toolCallId ? { toolCallId, filePath: FILE } : { filePath: FILE }
  } as unknown as AcpPermissionRequest
}

function makeDeps(overrides: Partial<NativeWriteCaptureDeps> = {}): {
  deps: NativeWriteCaptureDeps
  journalled: NativeWriteJournalEntry[]
  released: number
} {
  const journalled: NativeWriteJournalEntry[] = []
  const state = { released: 0 }
  const deps: NativeWriteCaptureDeps = {
    provider: 'mistral',
    workspacePath: WORKSPACE,
    admit: vi.fn(async () => ({ ok: true, lockOwnerId: 'owner-1' })),
    release: vi.fn(async () => {
      state.released += 1
    }),
    requestApproval: vi.fn(async () => true),
    journalNativeEdit: vi.fn(async (entry: NativeWriteJournalEntry) => {
      journalled.push(entry)
    }),
    readFileBytes: vi.fn(async () => Buffer.from('before')),
    statPath: vi.fn(async () => ({ size: 6, mode: 0o644 })),
    ...overrides
  }
  return {
    deps,
    journalled,
    get released() {
      return state.released
    }
  }
}

describe('native write contribution capture', () => {
  it('refuses every write tool the journal cannot represent, with the reason unchanged', async () => {
    // These five reach the same `access === 'write'` branch as write_file and
    // replace. delete_path has no after-bytes, move/rename lose their source
    // side, create_directory has no file bytes. Admitting any of them would be
    // a mutation with no snapshot -- an unrecoverable native rm.
    for (const tool of [
      'delete_path',
      'move_path',
      'rename_path',
      'create_directory',
      'apply_patch'
    ]) {
      const { deps } = makeDeps()
      const capture = createNativeWriteContributionCapture(deps)
      const decision = await capture.gate(request(), allowPreflight(tool))
      expect(decision).toEqual({
        decision: 'deny',
        origin: 'host-containment',
        reason: NATIVE_WRITE_UNCAPTURABLE_REASON
      })
      expect(deps.admit).not.toHaveBeenCalled()
    }
  })

  it('admits the two tools the journal can represent', async () => {
    for (const tool of ['write_file', 'replace']) {
      const { deps } = makeDeps()
      const capture = createNativeWriteContributionCapture(deps)
      expect(await capture.gate(request(), allowPreflight(tool))).toBe('allow')
    }
  })

  it('treats only ENOENT as an absent before, and refuses every other read failure', async () => {
    // The destructive case: a record with before=null is undone by DELETING the
    // file. An EACCES read must never be laundered into "this is a new file".
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    const { deps } = makeDeps({
      readFileBytes: vi.fn(async () => {
        throw eacces
      })
    })
    const capture = createNativeWriteContributionCapture(deps)
    const decision = await capture.gate(request(), allowPreflight('replace'))
    expect(decision).toMatchObject({ decision: 'deny', origin: 'host-containment' })
    expect(deps.admit).not.toHaveBeenCalled()
  })

  it('allows a genuine create, where the file is absent', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const { deps } = makeDeps({
      statPath: vi.fn(async () => {
        throw enoent
      })
    })
    const capture = createNativeWriteContributionCapture(deps)
    expect(await capture.gate(request(), allowPreflight('write_file'))).toBe('allow')
  })

  it('refuses a file the journal would silently drop for size', async () => {
    const { deps } = makeDeps({
      statPath: vi.fn(async () => ({ size: 50 * 1024 * 1024, mode: 0o644 }))
    })
    const capture = createNativeWriteContributionCapture(deps)
    expect(await capture.gate(request(), allowPreflight('replace'))).toMatchObject({
      decision: 'deny',
      origin: 'host-containment'
    })
  })

  it('refuses a second concurrent write to a file already in flight', async () => {
    // Both would capture the same `before`; the journal's chain check would then
    // break and refuse Undo for BOTH edits.
    const { deps } = makeDeps()
    const capture = createNativeWriteContributionCapture(deps)
    expect(await capture.gate(request('call-1'), allowPreflight('replace'))).toBe('allow')
    expect(await capture.gate(request('call-2'), allowPreflight('replace'))).toMatchObject({
      decision: 'deny',
      origin: 'host-containment'
    })
  })

  it('frees the path once the first write settles', async () => {
    const { deps } = makeDeps()
    const capture = createNativeWriteContributionCapture(deps)
    await capture.gate(request('call-1'), allowPreflight('replace'))
    await capture.settle('call-1', true)
    expect(capture.inFlightCount()).toBe(0)
    expect(await capture.gate(request('call-2'), allowPreflight('replace'))).toBe('allow')
  })

  it('refuses a write it cannot correlate to a settle', async () => {
    const { deps } = makeDeps()
    const capture = createNativeWriteContributionCapture(deps)
    expect(await capture.gate(request(null), allowPreflight('replace'))).toMatchObject({
      decision: 'deny',
      origin: 'host-containment'
    })
  })

  it('surfaces an admission refusal as host-policy, not containment', async () => {
    const { deps } = makeDeps({
      admit: vi.fn(async () => ({ ok: false, reason: 'Lane write scope excludes this path.' }))
    })
    const capture = createNativeWriteContributionCapture(deps)
    expect(await capture.gate(request(), allowPreflight('replace'))).toEqual({
      decision: 'deny',
      origin: 'host-policy',
      reason: 'Lane write scope excludes this path.'
    })
  })

  it('releases the admission when approval is refused, and blames no one', async () => {
    const holder = makeDeps({ requestApproval: vi.fn(async () => false) })
    const capture = createNativeWriteContributionCapture(holder.deps)
    const decision = await capture.gate(request(), allowPreflight('replace'))
    // This seam cannot distinguish a human decline from a policy auto-resolve,
    // so it must not attribute the refusal to the user.
    expect(decision).toMatchObject({ decision: 'deny', origin: 'unknown' })
    expect(holder.released).toBe(1)
    expect(capture.inFlightCount()).toBe(0)
  })

  it('journals the before/after pair and takes the exec bit from after the write', async () => {
    const reads = [Buffer.from('before'), Buffer.from('after!')]
    let readIndex = 0
    const holder = makeDeps({
      readFileBytes: vi.fn(async () => reads[Math.min(readIndex++, reads.length - 1)]),
      statPath: vi
        .fn()
        .mockResolvedValueOnce({ size: 6, mode: 0o644 })
        .mockResolvedValue({ size: 6, mode: 0o755 })
    })
    const capture = createNativeWriteContributionCapture(holder.deps)
    await capture.gate(request(), allowPreflight('replace'))
    await capture.settle('call-1', true)

    expect(holder.journalled).toHaveLength(1)
    expect(holder.journalled[0]).toMatchObject({
      targetPath: FILE,
      canonicalTool: 'replace',
      lockOwnerId: 'owner-1',
      // prepareEdit stamps ONE mode onto both sides and currentFileHash compares
      // it to the LIVE file, so the after-write bit is the correct one.
      executable: true
    })
    expect(holder.journalled[0].before?.toString()).toBe('before')
    expect(holder.journalled[0].after.toString()).toBe('after!')
    expect(holder.released).toBe(1)
  })

  it('records nothing when the bytes did not change', async () => {
    const holder = makeDeps()
    const capture = createNativeWriteContributionCapture(holder.deps)
    await capture.gate(request(), allowPreflight('replace'))
    await capture.settle('call-1', true)
    expect(holder.journalled).toHaveLength(0)
    expect(holder.released).toBe(1)
  })

  it('records nothing on a failed tool call but still releases the lock', async () => {
    const holder = makeDeps()
    const capture = createNativeWriteContributionCapture(holder.deps)
    await capture.gate(request(), allowPreflight('replace'))
    await capture.settle('call-1', false)
    expect(holder.journalled).toHaveLength(0)
    expect(holder.released).toBe(1)
  })

  it('releases the lock even when journalling throws', async () => {
    const holder = makeDeps({
      readFileBytes: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('before'))
        .mockResolvedValue(Buffer.from('after!')),
      journalNativeEdit: vi.fn(async () => {
        throw new Error('journal unavailable')
      })
    })
    const capture = createNativeWriteContributionCapture(holder.deps)
    await capture.gate(request(), allowPreflight('replace'))
    await expect(capture.settle('call-1', true)).resolves.toBeUndefined()
    expect(holder.released).toBe(1)
  })

  it('sweeps an abandoned turn by attempting the capture rather than dropping it', async () => {
    const holder = makeDeps({
      readFileBytes: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('before'))
        .mockResolvedValue(Buffer.from('after!'))
    })
    const capture = createNativeWriteContributionCapture(holder.deps)
    await capture.gate(request(), allowPreflight('replace'))
    await capture.sweep()
    expect(holder.journalled).toHaveLength(1)
    expect(capture.inFlightCount()).toBe(0)
    expect(holder.released).toBe(1)
  })

  it('never routes a shell or read preflight into write capture', async () => {
    const { deps } = makeDeps()
    const capture = createNativeWriteContributionCapture(deps)
    const shell = { ...allowPreflight('run_shell_command'), access: 'shell' as const }
    expect(await capture.gate(request(), shell)).toMatchObject({ origin: 'host-containment' })
    expect(deps.admit).not.toHaveBeenCalled()
  })
})
