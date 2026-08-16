import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MISSION_FACT_GENESIS_HASH,
  MissionFactLedgerCorruptError,
  MissionFactLedgerRepository,
  MissionFactSequenceConflictError,
  appendMissionFactRecord,
  createMissionFactRecord,
  parseMissionFactLine,
  replayMissionFacts,
  type MissionFactInput,
  type MissionFactRecord
} from './MissionFactLedger'

const provenance = {
  surface: 'goal' as const,
  actor: 'user' as const,
  chatId: 'chat-1',
  workspaceId: 'workspace-1'
}

function input(
  factId: string,
  payload: MissionFactInput['payload'],
  overrides: Partial<MissionFactInput> = {}
): MissionFactInput {
  return {
    factId,
    missionId: 'mission-1',
    timestamp: `2026-08-16T00:00:${factId.slice(-2).padStart(2, '0')}.000Z`,
    provenance,
    payload,
    ...overrides
  }
}

function append(
  records: readonly MissionFactRecord[],
  next: MissionFactInput,
  expectedLastSequence?: number
): MissionFactRecord[] {
  return [
    ...records,
    appendMissionFactRecord(records, next, {
      ...(expectedLastSequence === undefined ? {} : { expectedLastSequence })
    })
  ]
}

describe('MissionFactLedger model', () => {
  it('hash-chains facts and folds one authoritative mission projection', () => {
    let records: MissionFactRecord[] = []
    records = append(
      records,
      input('fact-01', { kind: 'mission_defined', objective: 'Ship the long-horizon mission' })
    )
    records = append(
      records,
      input(
        'fact-02',
        { kind: 'mission_status_set', status: 'active' },
        { provenance: { ...provenance, surface: 'orchestrator', actor: 'system' } }
      )
    )
    records = append(
      records,
      input(
        'fact-03',
        {
          kind: 'plan_set',
          plan: {
            planId: 'plan-1',
            title: 'Build order',
            body: '1. Synthesis\n2. Attempts\n3. Ledger',
            status: 'approved',
            artifactPath: 'docs/plans/mission.md'
          }
        },
        { provenance: { ...provenance, surface: 'plan', actor: 'agent', runId: 'run-1' } }
      )
    )
    records = append(
      records,
      input(
        'fact-04',
        {
          kind: 'work_item_upserted',
          item: {
            workItemId: 'card-1',
            title: 'Implement ledger',
            status: 'running',
            sortOrder: 2,
            sourceScopeId: 'board-1'
          }
        },
        { provenance: { ...provenance, surface: 'board', sourceId: 'card-1' } }
      )
    )
    records = append(
      records,
      input('fact-05', {
        kind: 'mission_objective_set',
        objective: 'Ship and dogfood the long-horizon mission'
      })
    )

    const replay = replayMissionFacts('mission-1', records)

    expect(replay.valid).toBe(true)
    expect(records[0].previousHash).toBe(MISSION_FACT_GENESIS_HASH)
    expect(records[1].previousHash).toBe(records[0].hash)
    expect(replay.projection).toMatchObject({
      missionId: 'mission-1',
      objective: 'Ship and dogfood the long-horizon mission',
      status: 'active',
      plan: { planId: 'plan-1', status: 'approved' },
      workItems: [{ workItemId: 'card-1', status: 'running' }],
      lastSequence: 5,
      tailHash: records[4].hash
    })
    expect(replay.projection?.sources.objective.factId).toBe('fact-05')
    expect(replay.projection?.sources.status?.provenance.surface).toBe('orchestrator')
    expect(replay.projection?.sources.plan?.provenance.runId).toBe('run-1')
    expect(replay.projection?.sources.workItems['card-1'].provenance.surface).toBe('board')
  })

  it('folds plan clearing and work-item tombstones without mutating prior records', () => {
    let records: MissionFactRecord[] = []
    records = append(records, input('fact-01', { kind: 'mission_defined', objective: 'Mission' }))
    records = append(
      records,
      input('fact-02', {
        kind: 'plan_set',
        plan: { planId: 'plan-1', title: 'Plan', body: 'Do the work.', status: 'pending' }
      })
    )
    records = append(
      records,
      input('fact-03', {
        kind: 'work_item_upserted',
        item: { workItemId: 'item-1', title: 'Work', status: 'pending' }
      })
    )
    const before = JSON.stringify(records)
    records = append(records, input('fact-04', { kind: 'plan_cleared', planId: 'plan-1' }))
    records = append(records, input('fact-05', { kind: 'work_item_removed', workItemId: 'item-1' }))

    const projection = replayMissionFacts('mission-1', records).projection
    expect(projection?.plan).toBeUndefined()
    expect(projection?.workItems).toEqual([])
    expect(projection?.sources.workItems['item-1'].factId).toBe('fact-05')
    expect(JSON.stringify(records.slice(0, 3))).toBe(before)
  })

  it('fails closed on tampering, sequence gaps, mission skew, and duplicate fact ids', () => {
    const defined = createMissionFactRecord(
      input('fact-01', { kind: 'mission_defined', objective: 'Mission' }),
      1,
      MISSION_FACT_GENESIS_HASH
    )
    const changed = createMissionFactRecord(
      input('fact-01', { kind: 'mission_status_set', status: 'active' }),
      3,
      'f'.repeat(64)
    )
    const tampered = {
      ...defined,
      missionId: 'mission-other',
      payload: { kind: 'mission_defined' as const, objective: 'Tampered' }
    }

    const replay = replayMissionFacts('mission-1', [tampered, changed])

    expect(replay.valid).toBe(false)
    expect(replay.projection).toBeNull()
    expect(replay.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'mission-mismatch',
        'hash-mismatch',
        'sequence-gap',
        'previous-hash-mismatch',
        'duplicate-fact-id'
      ])
    )
  })

  it('requires exactly one mission definition at the head of the ledger', () => {
    expect(() =>
      appendMissionFactRecord(
        [],
        input('fact-01', { kind: 'mission_status_set', status: 'active' })
      )
    ).toThrow(MissionFactLedgerCorruptError)

    const defined = append([], input('fact-01', { kind: 'mission_defined', objective: 'Mission' }))
    expect(() =>
      appendMissionFactRecord(
        defined,
        input('fact-02', { kind: 'mission_defined', objective: 'Mission again' })
      )
    ).toThrow(MissionFactLedgerCorruptError)
  })

  it('rejects non-canonical or extended JSON records at the decode boundary', () => {
    const record = createMissionFactRecord(
      input('fact-01', { kind: 'mission_defined', objective: 'Mission' }),
      1,
      MISSION_FACT_GENESIS_HASH
    )

    expect(parseMissionFactLine(JSON.stringify(record))).toEqual(record)
    expect(parseMissionFactLine(JSON.stringify({ ...record, unexpected: true }))).toBeNull()
    expect(
      parseMissionFactLine(
        JSON.stringify({
          ...record,
          payload: { kind: 'mission_defined', objective: ' Mission ' }
        })
      )
    ).toBeNull()
  })

  it('enforces compare-and-append against the caller projection revision', () => {
    const records = append(
      [],
      input('fact-01', { kind: 'mission_defined', objective: 'Mission' }),
      0
    )
    expect(() =>
      appendMissionFactRecord(
        records,
        input('fact-02', { kind: 'mission_status_set', status: 'active' }),
        { expectedLastSequence: 0 }
      )
    ).toThrow(MissionFactSequenceConflictError)
  })
})

describe('MissionFactLedgerRepository', () => {
  let tempPath: string
  let rootPath: string

  beforeEach(() => {
    tempPath = mkdtempSync(join(tmpdir(), 'mission-fact-ledger-'))
    rootPath = join(tempPath, 'ledgers')
  })

  afterEach(() => {
    rmSync(tempPath, { recursive: true, force: true })
  })

  it('durably appends, reopens, and verifies a mission ledger', () => {
    const repository = new MissionFactLedgerRepository({
      rootPath,
      now: () => '2026-08-16T00:00:00.000Z'
    })
    repository.append(
      input('fact-01', { kind: 'mission_defined', objective: 'Mission' }, { timestamp: undefined }),
      { expectedLastSequence: 0 }
    )
    repository.append(
      input('fact-02', { kind: 'mission_status_set', status: 'active' }, { timestamp: undefined }),
      { expectedLastSequence: 1 }
    )

    const reopened = new MissionFactLedgerRepository({ rootPath }).read('mission-1')
    expect(reopened.valid).toBe(true)
    expect(reopened.projection).toMatchObject({ status: 'active', lastSequence: 2 })
    const files = readdirSync(rootPath)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^mission-[a-f0-9]{64}\.jsonl$/)
    expect(files[0]).not.toContain('mission-1')
    expect(readFileSync(join(rootPath, files[0]), 'utf8').endsWith('\n')).toBe(true)
  })

  it('refuses to append after a torn or malformed tail', () => {
    const repository = new MissionFactLedgerRepository({ rootPath })
    repository.append(input('fact-01', { kind: 'mission_defined', objective: 'Mission' }))
    const [fileName] = readdirSync(rootPath)
    appendFileSync(join(rootPath, fileName), '{"partial":', 'utf8')

    const replay = repository.read('mission-1')
    expect(replay.valid).toBe(false)
    expect(replay.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['torn-tail', 'invalid-record'])
    )
    expect(() =>
      repository.append(input('fact-02', { kind: 'mission_status_set', status: 'active' }))
    ).toThrow(MissionFactLedgerCorruptError)
  })

  it('detects a valid-JSON rewrite because the hash no longer reconciles', () => {
    const repository = new MissionFactLedgerRepository({ rootPath })
    repository.append(input('fact-01', { kind: 'mission_defined', objective: 'Mission' }))
    const [fileName] = readdirSync(rootPath)
    const filePath = join(rootPath, fileName)
    const [line] = readFileSync(filePath, 'utf8').trim().split('\n')
    const record = JSON.parse(line) as MissionFactRecord
    writeFileSync(
      filePath,
      `${JSON.stringify({ ...record, payload: { ...record.payload, objective: 'Rewritten' } })}\n`,
      'utf8'
    )

    const replay = repository.read('mission-1')
    expect(replay.valid).toBe(false)
    expect(replay.diagnostics.map((item) => item.code)).toContain('hash-mismatch')
  })

  it('purges only ledgers whose verified provenance matches a scoped deletion', () => {
    const repository = new MissionFactLedgerRepository({ rootPath })
    repository.append(
      input(
        'fact-01',
        { kind: 'mission_defined', objective: 'Mission A' },
        {
          missionId: 'mission-a',
          provenance: { ...provenance, chatId: 'chat-a', workspaceId: 'workspace-a' }
        }
      )
    )
    repository.append(
      input(
        'fact-02',
        { kind: 'mission_defined', objective: 'Mission B' },
        {
          missionId: 'mission-b',
          provenance: { ...provenance, chatId: 'chat-b', workspaceId: 'workspace-b' }
        }
      )
    )

    expect(repository.purge({ chatIds: ['chat-a'] })).toEqual({
      scanned: 2,
      deletedMissionIds: ['mission-a']
    })
    expect(repository.read('mission-a').projection).toBeNull()
    expect(repository.read('mission-b').valid).toBe(true)

    expect(repository.purge({ workspaceIds: ['workspace-b'] }).deletedMissionIds).toEqual([
      'mission-b'
    ])
    expect(readdirSync(rootPath)).toEqual([])
  })

  it('fails a scoped purge before deleting siblings when any ledger cannot prove scope', () => {
    const repository = new MissionFactLedgerRepository({ rootPath })
    repository.append(
      input(
        'fact-01',
        { kind: 'mission_defined', objective: 'Mission' },
        {
          provenance: { ...provenance, chatId: 'chat-a' }
        }
      )
    )
    const [fileName] = readdirSync(rootPath)
    appendFileSync(join(rootPath, fileName), '{"partial":', 'utf8')

    expect(() => repository.purge({ chatIds: ['chat-a'] })).toThrow(MissionFactLedgerCorruptError)
    expect(readdirSync(rootPath)).toEqual([fileName])
    expect(repository.purge({ missionIds: ['mission-1'] }).deletedMissionIds).toEqual(['mission-1'])
    expect(readdirSync(rootPath)).toEqual([])
  })

  it('globally purges every mission ledger even when a tail is corrupt', () => {
    const repository = new MissionFactLedgerRepository({ rootPath })
    repository.append(input('fact-01', { kind: 'mission_defined', objective: 'Mission' }))
    const [fileName] = readdirSync(rootPath)
    appendFileSync(join(rootPath, fileName), '{"partial":', 'utf8')

    expect(repository.purge({ all: true })).toEqual({
      scanned: 1,
      deletedMissionIds: []
    })
    expect(readdirSync(rootPath)).toEqual([])
  })
})
