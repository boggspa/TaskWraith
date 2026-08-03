import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const {
  advanceMarkerObservations,
  fingerprintPath,
  queryWorkProvenance,
  readEventRecords,
  reconcileWorkProvenance,
  resolveWorkspaceIdentity,
  writeEventImmutable
} = require('./work-provenance.cjs') as {
  advanceMarkerObservations: (input: Record<string, unknown>) => any
  fingerprintPath: (path: string) => Record<string, unknown>
  queryWorkProvenance: (root: string, options?: Record<string, unknown>) => any
  readEventRecords: (identity: Record<string, unknown>) => Array<{ event: any }>
  reconcileWorkProvenance: (input: Record<string, unknown>) => {
    sidecar: any
    writtenEventIds: string[]
  }
  resolveWorkspaceIdentity: (root: string) => Record<string, any>
  writeEventImmutable: (identity: Record<string, unknown>, event: Record<string, unknown>) => void
}

const { dirtyEntries, takeSnapshot } = require('./work-guard.cjs') as {
  dirtyEntries: (root: string) => Array<{ path: string; status: string; mtimeMs: number | null }>
  takeSnapshot: (
    root: string,
    label?: string
  ) => {
    ok: boolean
    ref?: string
    commit?: string
  }
}

const NOW = Date.parse('2026-08-03T03:00:00.000Z')
const roots: string[] = []

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'work-provenance-query-'))
  roots.push(root)
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  run(['init', '-q', '.'])
  run(['config', 'user.email', 'provenance@test'])
  run(['config', 'user.name', 'provenance'])
  run(['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 1\n')
  run(['add', '--', 'src/shared.ts'])
  run(['commit', '-qm', 'seed'])
  return root
}

function origin(
  root: string,
  input: {
    id: string
    actor: Record<string, string>
    confidence: string
    recordedAt?: string
  }
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: input.id,
    kind: 'origin',
    recordedAt: input.recordedAt || new Date(NOW).toISOString(),
    confidence: input.confidence,
    source: 'taskwraith-native-run',
    workspace: resolveWorkspaceIdentity(root),
    path: 'src/shared.ts',
    after: fingerprintPath(join(root, 'src', 'shared.ts')),
    actor: input.actor,
    operation: { id: input.id, name: 'provider-run', outcome: 'completed', exclusive: false }
  }
}

function marker(
  file: string,
  session: string,
  started: string,
  displayName: string
): Record<string, any> {
  return {
    file,
    session,
    task: `Task for ${displayName}`,
    agent: 'codex',
    owner: displayName,
    started,
    derived: false,
    pid: null,
    paths: ['src/shared.ts'],
    matchers: [(candidate: string) => candidate === 'src/shared.ts']
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('work provenance query and reconciliation', () => {
  it('reports pre-ledger dirt as unknown instead of retroactively blaming a task', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 9\n')

    const projection = queryWorkProvenance(root, { dirty: dirtyEntries(root), now: NOW })
    expect(projection.workItems).toMatchObject([
      {
        path: 'src/shared.ts',
        lifecycle: 'unresolved',
        confidence: 'unknown',
        contributors: [{ actor: {}, confidence: 'unknown' }]
      }
    ])
  })

  it('keeps the read-only query from invoking repository fsmonitor code', () => {
    if (process.platform === 'win32') return
    const root = makeRepo()
    const sentinel = join(root, 'fsmonitor-invoked')
    const hook = join(root, '.git', 'fsmonitor-probe.sh')
    writeFileSync(hook, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 1\n`)
    chmodSync(hook, 0o755)
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 9\n')

    expect(queryWorkProvenance(root, { now: NOW }).gitGeneration).toMatchObject({ coherent: true })
    expect(existsSync(sentinel)).toBe(false)
  })

  it('projects renames and untracked paths without inventing line totals', () => {
    const root = makeRepo()
    execFileSync('git', ['mv', 'src/shared.ts', 'src/renamed.ts'], { cwd: root })
    writeFileSync(join(root, 'src', 'untracked.ts'), 'export const untracked = true\n')

    const projection = queryWorkProvenance(root, { now: NOW })
    expect(projection.attribution.root).toMatchObject({
      files: 2,
      trackedFiles: 1,
      untrackedFiles: 1
    })
    expect(projection.attribution.unclaimedUnknown.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/renamed.ts',
          renamedFrom: 'src/shared.ts',
          untracked: false,
          additions: 0,
          deletions: 0
        }),
        expect.objectContaining({
          path: 'src/untracked.ts',
          untracked: true,
          additions: null,
          deletions: null
        })
      ])
    )
  })

  it('retains overlapping contributors and classifies the current origin as ambiguous', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    const identity = resolveWorkspaceIdentity(root)
    writeEventImmutable(
      identity,
      origin(root, {
        id: 'origin-a',
        actor: { runId: 'run-a', provider: 'cursor', displayName: 'CursorWork' },
        confidence: 'observed-native'
      })
    )
    writeEventImmutable(
      identity,
      origin(root, {
        id: 'origin-b',
        actor: { runId: 'run-b', provider: 'grok', displayName: 'GrokWork' },
        confidence: 'observed-native'
      })
    )

    const projection = queryWorkProvenance(root, { dirty: dirtyEntries(root), now: NOW })
    const item = projection.workItems.find((candidate: any) => candidate.path === 'src/shared.ts')
    expect(item).toMatchObject({ lifecycle: 'unresolved', confidence: 'ambiguous' })
    expect(item.contributors.map((entry: any) => entry.actor.displayName).sort()).toEqual([
      'CursorWork',
      'GrokWork'
    ])
    expect(projection.cursor).toMatch(/^[a-f0-9]{64}$/)
  })

  it('does not award pre-existing file dirt to a later exact operation', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 12\n')
    const identity = resolveWorkspaceIdentity(root)
    writeEventImmutable(identity, {
      ...origin(root, {
        id: 'origin-exact-on-dirty',
        actor: { runId: 'run-exact', displayName: 'Exact Writer' },
        confidence: 'exact'
      }),
      source: 'taskwraith-broker',
      operation: {
        id: 'tool-exact-on-dirty',
        name: 'replace',
        outcome: 'success',
        exclusive: true,
        preexistingDirty: true
      }
    })

    const current = queryWorkProvenance(root, { now: NOW }).workItems.find(
      (item: any) => item.path === 'src/shared.ts' && item.currentDirty
    )
    expect(current.confidence).toBe('ambiguous')
    expect(current.currentContributors.map((entry: any) => entry.actor.displayName).sort()).toEqual(
      ['Exact Writer', 'Unattributed pre-existing work']
    )
  })

  it('never reconciles an origin that belongs to another worktree identity', () => {
    const root = makeRepo()
    const identity = resolveWorkspaceIdentity(root)
    writeEventImmutable(identity, {
      ...origin(root, {
        id: 'origin-other-worktree',
        actor: { runId: 'run-other', provider: 'cursor', displayName: 'Other Worktree' },
        confidence: 'observed-native'
      }),
      workspace: { ...identity, worktreeId: 'different-worktree-id' }
    })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')

    reconcileWorkProvenance({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      sidecar: { schemaVersion: 2, markers: {}, tombstones: {} },
      snapshot: takeSnapshot(root, 'cross-worktree fixture'),
      now: NOW
    })

    expect(
      readEventRecords(identity).some(
        ({ event }) =>
          event.kind === 'resolution' && event.originEventId === 'origin-other-worktree'
      )
    ).toBe(false)
  })

  it('counts overlapping marker scopes once in one coherent repository generation', () => {
    const root = makeRepo()
    writeFileSync(
      join(root, 'src', 'shared.ts'),
      'export const shared = 2\nexport const second = 3\n'
    )
    const fileMarker = marker(
      '.WORK-IN-PROGRESS-file.md',
      'task-file',
      new Date(NOW - 2_000).toISOString(),
      'File Writer'
    )
    const directoryMarker = {
      ...marker(
        '.WORK-IN-PROGRESS-directory.md',
        'task-directory',
        new Date(NOW - 1_000).toISOString(),
        'Directory Writer'
      ),
      paths: ['src/'],
      matchers: [(candidate: string) => candidate.startsWith('src/')]
    }
    const otherRoot = join(root, 'other-worktree')
    mkdirSync(otherRoot)
    const otherWorktreeMarker = {
      ...marker(
        '.WORK-IN-PROGRESS-other.md',
        'task-other',
        new Date(NOW - 500).toISOString(),
        'Other Worktree Writer'
      ),
      worktree: otherRoot
    }

    const projection = queryWorkProvenance(root, {
      markers: [
        { marker: fileMarker, state: { live: true } },
        { marker: directoryMarker, state: { live: true } },
        { marker: otherWorktreeMarker, state: { live: true } }
      ],
      now: NOW
    })

    expect(projection.gitGeneration).toMatchObject({ coherent: true })
    expect(projection.attribution).toMatchObject({
      root: { files: 1, additions: 2, deletions: 1 },
      unique: { files: 0, additions: 0, deletions: 0 },
      sharedAmbiguous: { files: 1, additions: 2, deletions: 1 },
      unclaimedUnknown: { files: 0, additions: 0, deletions: 0 },
      invariant: { files: true, additions: true, deletions: true, satisfied: true }
    })
    expect(projection.attribution.sharedAmbiguous.paths).toMatchObject([
      { path: 'src/shared.ts', contributorCount: 2, confidence: 'ambiguous' }
    ])
    const current = projection.workItems.find(
      (candidate: any) => candidate.path === 'src/shared.ts' && candidate.currentDirty
    )
    expect(current.contributors.map((entry: any) => entry.actor.displayName).sort()).toEqual([
      'Directory Writer',
      'File Writer'
    ])
  })

  it('starts a new observation baseline when a marker expands its claim set', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'second.ts'), 'export const second = 1\n')
    execFileSync('git', ['add', '--', 'src/second.ts'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'add second fixture'], { cwd: root })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    writeFileSync(join(root, 'src', 'second.ts'), 'export const second = 2\n')
    const initial = marker(
      '.WORK-IN-PROGRESS-expanding.md',
      'task-expanding',
      new Date(NOW - 60_000).toISOString(),
      'Expanding Writer'
    )
    const first = advanceMarkerObservations({
      root,
      markers: [initial],
      dirty: dirtyEntries(root),
      previousSidecar: {},
      now: NOW,
      pidAlive: () => false
    })
    const expanded = {
      ...initial,
      paths: ['src/shared.ts', 'src/second.ts'],
      matchers: [
        (candidate: string) => candidate === 'src/shared.ts',
        (candidate: string) => candidate === 'src/second.ts'
      ]
    }
    const second = advanceMarkerObservations({
      root,
      markers: [expanded],
      dirty: dirtyEntries(root),
      previousSidecar: first,
      now: NOW + 1_000,
      pidAlive: () => false
    })

    const firstObservation = first.markers[initial.file].observationId
    expect(second.markers[initial.file].observationId).not.toBe(firstObservation)
    expect(second.tombstones[firstObservation]).toBeDefined()
    expect(
      second.markers[initial.file].baselineDirty.map((entry: any) => entry.path).sort()
    ).toEqual(['src/second.ts', 'src/shared.ts'])
  })

  it('retains the closed marker identity when its bytes change before reconciliation', () => {
    const root = makeRepo()
    const firstMarker = marker(
      '.WORK-IN-PROGRESS-first.md',
      'task-first',
      new Date(NOW - 60_000).toISOString(),
      'First Writer'
    )
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    let sidecar = advanceMarkerObservations({
      root,
      markers: [firstMarker],
      dirty: dirtyEntries(root),
      previousSidecar: {},
      now: NOW,
      pidAlive: () => false
    })
    sidecar = advanceMarkerObservations({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW + 1_000,
      pidAlive: () => false
    })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 3\n')
    reconcileWorkProvenance({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      sidecar,
      snapshot: takeSnapshot(root, 'changed-before-reconcile fixture'),
      now: NOW + 2_000
    })

    const projection = queryWorkProvenance(root, { now: NOW + 2_000 })
    expect(
      projection.workItems.find((item: any) =>
        item.contributors.some(
          (contributor: any) => contributor.actor.displayName === 'First Writer'
        )
      )
    ).toMatchObject({ lifecycle: 'resolved', currentDirty: false })
    expect(
      projection.workItems.find((item: any) => item.path === 'src/shared.ts' && item.currentDirty)
    ).toMatchObject({ lifecycle: 'unresolved', confidence: 'unknown' })
    expect(Object.keys(sidecar.tombstones)).toHaveLength(0)
  })

  it('replays a vanished-marker receipt idempotently after a sidecar-write crash', () => {
    const root = makeRepo()
    const claimedMarker = marker(
      '.WORK-IN-PROGRESS-replay.md',
      'task-replay',
      new Date(NOW - 60_000).toISOString(),
      'Replay Writer'
    )
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    let sidecar = advanceMarkerObservations({
      root,
      markers: [claimedMarker],
      dirty: dirtyEntries(root),
      previousSidecar: {},
      now: NOW,
      pidAlive: () => false
    })
    sidecar = advanceMarkerObservations({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW + 1_000,
      pidAlive: () => false
    })
    const replayedSidecar = JSON.parse(JSON.stringify(sidecar))
    const snapshot = takeSnapshot(root, 'idempotent marker fixture')

    reconcileWorkProvenance({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      sidecar,
      snapshot,
      now: NOW + 1_000
    })
    expect(() =>
      reconcileWorkProvenance({
        root,
        markers: [],
        dirty: dirtyEntries(root),
        sidecar: replayedSidecar,
        snapshot,
        now: NOW + 10_000
      })
    ).not.toThrow()

    const markerOrigins = readEventRecords(resolveWorkspaceIdentity(root)).filter(
      ({ event }) => event.kind === 'origin' && event.source === 'work-guard-marker'
    )
    expect(markerOrigins).toHaveLength(1)
    const current = queryWorkProvenance(root, { now: NOW + 10_000 }).workItems.find(
      (item: any) => item.path === 'src/shared.ts' && item.currentDirty
    )
    expect(current.confidence).toBe('ambiguous')
    expect(current.currentContributors.map((entry: any) => entry.actor.displayName).sort()).toEqual(
      ['Replay Writer', 'Unattributed pre-existing work']
    )
  })

  it('accepts a concurrent retry whose deterministic event differs only by timestamp', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    const identity = resolveWorkspaceIdentity(root)
    const first = origin(root, {
      id: 'origin-concurrent-retry',
      actor: { runId: 'run-retry' },
      confidence: 'observed-native',
      recordedAt: new Date(NOW).toISOString()
    })
    writeEventImmutable(identity, first)
    expect(() =>
      writeEventImmutable(identity, {
        ...first,
        recordedAt: new Date(NOW + 1_000).toISOString()
      })
    ).not.toThrow()
    expect(
      readEventRecords(identity).filter(({ event }) => event.eventId === 'origin-concurrent-retry')
    ).toHaveLength(1)

    const recoveryId = `recovery-${createHash('sha256')
      .update('origin-concurrent-retry')
      .digest('hex')}`
    const recoveryRef = `refs/taskwraith/work-provenance/${createHash('sha256')
      .update('origin-concurrent-retry')
      .digest('hex')
      .slice(0, 40)}`
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const recovery = {
      schemaVersion: 1,
      eventId: recoveryId,
      kind: 'recovery',
      recordedAt: new Date(NOW).toISOString(),
      originEventId: 'origin-concurrent-retry',
      recovery: { ref: recoveryRef, commit, tree, pinnedAt: new Date(NOW).toISOString() }
    }
    writeEventImmutable(identity, recovery)
    expect(() =>
      writeEventImmutable(identity, {
        ...recovery,
        recordedAt: new Date(NOW + 1_000).toISOString(),
        recovery: { ...recovery.recovery, pinnedAt: new Date(NOW + 1_000).toISOString() }
      })
    ).not.toThrow()
  })

  it('never deletes a foreign recovery ref named by a mismatched local event', () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    const identity = resolveWorkspaceIdentity(root)
    const originEvent = origin(root, {
      id: 'origin-with-foreign-recovery',
      actor: { runId: 'run-recovery' },
      confidence: 'observed-native'
    })
    writeEventImmutable(identity, originEvent)
    const foreignRef = `refs/taskwraith/work-provenance/${'a'.repeat(40)}`
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    execFileSync('git', ['update-ref', foreignRef, commit], { cwd: root })
    writeEventImmutable(identity, {
      schemaVersion: 1,
      eventId: `recovery-${createHash('sha256')
        .update('origin-with-foreign-recovery')
        .digest('hex')}`,
      kind: 'recovery',
      recordedAt: new Date(NOW).toISOString(),
      originEventId: 'origin-with-foreign-recovery',
      recovery: {
        ref: foreignRef,
        commit,
        tree,
        pinnedAt: new Date(NOW).toISOString()
      }
    })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 1\n')

    reconcileWorkProvenance({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      sidecar: { schemaVersion: 2, markers: {}, tombstones: {} },
      snapshot: takeSnapshot(root, 'foreign recovery fixture'),
      now: NOW + 1_000
    })

    expect(
      execFileSync('git', ['rev-parse', '--verify', foreignRef], {
        cwd: root,
        encoding: 'utf8'
      }).trim()
    ).toBe(commit)
  })

  it('turns a vanished marker into accountable dirt, preserves adoption, and unpins on resolution', () => {
    const root = makeRepo()
    const firstMarker = marker(
      '.WORK-IN-PROGRESS-first.md',
      'task-first',
      new Date(NOW - 60_000).toISOString(),
      'First Writer'
    )
    let sidecar = advanceMarkerObservations({
      root,
      markers: [firstMarker],
      dirty: dirtyEntries(root),
      previousSidecar: {},
      now: NOW - 1_000,
      pidAlive: () => false
    })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 2\n')
    utimesSync(join(root, 'src', 'shared.ts'), NOW / 1_000, NOW / 1_000)
    sidecar = advanceMarkerObservations({
      root,
      markers: [firstMarker],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW,
      pidAlive: () => false
    })
    sidecar = advanceMarkerObservations({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW + 1_000,
      pidAlive: () => false
    })
    const firstSnapshot = takeSnapshot(root, 'vanished marker fixture')
    reconcileWorkProvenance({
      root,
      markers: [],
      dirty: dirtyEntries(root),
      sidecar,
      snapshot: firstSnapshot,
      now: NOW + 1_000
    })

    let projection = queryWorkProvenance(root, { dirty: dirtyEntries(root), now: NOW + 1_000 })
    let current = projection.workItems.find(
      (candidate: any) => candidate.path === 'src/shared.ts' && candidate.lifecycle === 'unresolved'
    )
    expect(current).toMatchObject({
      confidence: 'correlated-claim',
      recovery: { pinned: true, available: true }
    })
    expect(current.contributors[0].actor).toMatchObject({
      sessionId: 'task-first',
      displayName: 'First Writer'
    })

    const secondMarker = marker(
      '.WORK-IN-PROGRESS-second.md',
      'task-second',
      new Date(NOW + 2_000).toISOString(),
      'Adopting Writer'
    )
    sidecar = advanceMarkerObservations({
      root,
      markers: [secondMarker],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW + 2_000,
      pidAlive: () => false
    })
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 3\n')
    utimesSync(join(root, 'src', 'shared.ts'), (NOW + 5_000) / 1_000, (NOW + 5_000) / 1_000)
    sidecar = advanceMarkerObservations({
      root,
      markers: [secondMarker],
      dirty: dirtyEntries(root),
      previousSidecar: sidecar,
      now: NOW + 5_000,
      pidAlive: () => false
    })
    const adoptionSnapshot = takeSnapshot(root, 'adoption fixture')
    reconcileWorkProvenance({
      root,
      markers: [secondMarker],
      dirty: dirtyEntries(root),
      sidecar,
      snapshot: adoptionSnapshot,
      now: NOW + 5_000
    })

    projection = queryWorkProvenance(root, { dirty: dirtyEntries(root), now: NOW + 5_000 })
    expect(projection.workItems.some((item: any) => item.lifecycle === 'adopted')).toBe(true)
    current = projection.workItems.find(
      (candidate: any) => candidate.path === 'src/shared.ts' && candidate.lifecycle === 'unresolved'
    )
    expect(current.confidence).toBe('ambiguous')
    expect(current.currentContributors.map((entry: any) => entry.actor.displayName).sort()).toEqual(
      ['Adopting Writer', 'First Writer']
    )
    expect(current.lineageOriginEventIds).toHaveLength(1)
    expect(
      current.currentContributors
        .flatMap((entry: any) => entry.evidence)
        .some((evidence: any) => evidence.relationship === 'predecessor')
    ).toBe(true)

    // The live adopter can keep editing after its last immutable boundary. The
    // synthetic current item must carry that predecessor chain, and the
    // disjoint partition must point Observatory at this canonical item.
    writeFileSync(join(root, 'src', 'shared.ts'), 'export const shared = 4\n')
    projection = queryWorkProvenance(root, {
      now: NOW + 6_000,
      markers: [
        {
          marker: secondMarker,
          markerRoot: root,
          observationId: sidecar.markers[secondMarker.file].observationId,
          state: { live: true }
        }
      ]
    })
    current = projection.workItems.find(
      (candidate: any) => candidate.path === 'src/shared.ts' && candidate.currentDirty
    )
    expect(current.confidence).toBe('ambiguous')
    expect(current.currentContributors.map((entry: any) => entry.actor.displayName).sort()).toEqual(
      ['Adopting Writer', 'First Writer']
    )
    expect(
      current.currentContributors
        .find((entry: any) => entry.actor.displayName === 'Adopting Writer')
        .evidence.some((evidence: any) => evidence.relationship === 'current')
    ).toBe(true)
    expect(
      current.currentContributors
        .flatMap((entry: any) => entry.evidence)
        .every((evidence: any) => Boolean(evidence.relationship))
    ).toBe(true)
    expect(current.lineageOriginEventIds).toHaveLength(2)
    expect(projection.attribution.sharedAmbiguous.paths).toContainEqual(
      expect.objectContaining({
        path: 'src/shared.ts',
        workItemId: current.workItemId,
        confidence: 'ambiguous'
      })
    )

    execFileSync('git', ['add', '--', 'src/shared.ts'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'finish adopted work'], { cwd: root })
    reconcileWorkProvenance({
      root,
      markers: [secondMarker],
      dirty: dirtyEntries(root),
      sidecar,
      snapshot: takeSnapshot(root, 'resolved fixture'),
      now: NOW + 10_000
    })

    projection = queryWorkProvenance(root, { dirty: dirtyEntries(root), now: NOW + 10_000 })
    expect(projection.workItems.every((item: any) => item.lifecycle !== 'unresolved')).toBe(true)
    const recoveryRefs = readEventRecords(resolveWorkspaceIdentity(root))
      .map((record) => record.event)
      .filter((event) => event.kind === 'recovery')
      .map((event) => event.recovery.ref)
    for (const ref of recoveryRefs) {
      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', ref], { cwd: root, stdio: 'ignore' })
      ).toThrow()
    }
  })
})
