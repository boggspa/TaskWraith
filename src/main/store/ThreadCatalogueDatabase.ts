import type { MessageActivityRequest } from '../../shared/messageActivityAggregate'
import type { ThreadCatalogueActivityPage } from '../../shared/threadCatalogueTypes'
import { isSafeChatId } from '../ChatPath'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { copyThreadCatalogueProjection } from './ThreadCatalogueProjection'
import { THREAD_CATALOGUE_MAX_HEAD_BYTES } from './ThreadCatalogue'
import type { ThreadCatalogueEpoch, ThreadCatalogueProjection } from './ThreadCatalogue'

export const THREAD_INDEX_SCHEMA_VERSION = 5
export const THREAD_INDEX_CHUNK_BYTES = 48 * 1024
export const THREAD_INDEX_MAX_REPLY_BYTES = 2 * 1024 * 1024
export type {
  ThreadIndexedGeneration,
  ThreadIndexedObjectKind,
  ThreadIndexedObjectRef,
  ThreadIndexedObject,
  ThreadIndexObjectFrame
} from '../../shared/threadCatalogueTypes'
import type {
  ThreadIndexedGeneration,
  ThreadIndexedObjectKind,
  ThreadIndexedObjectRef,
  ThreadIndexedObject,
  ThreadIndexObjectFrame
} from '../../shared/threadCatalogueTypes'

export interface ThreadCatalogueDatabaseOptions {
  isPublicationCurrent: (generation: ThreadIndexedGeneration, publicationId: string) => boolean
  isInventoryCurrent: (witness: string) => boolean
  hasUnresolvedPublications: () => boolean
}

function generationMetadata(
  value: Omit<ThreadIndexedGeneration, 'databaseId' | 'generation'>
): Omit<ThreadIndexedGeneration, 'databaseId' | 'generation'> {
  const bounded = (text: unknown, maximum: number): text is string =>
    typeof text === 'string' && text.length > 0 && text.length <= maximum
  if (
    !isSafeChatId(value.chatId) ||
    !bounded(value.sourceWitness, 4096) ||
    !value.epoch ||
    !value.heads ||
    !bounded(value.epoch.global, 128) ||
    !bounded(value.epoch.chat, 128) ||
    (value.heads.desktop !== null && !bounded(value.heads.desktop, 1024)) ||
    (value.heads.host !== null && !bounded(value.heads.host, 1024))
  )
    throw new Error('Invalid thread index generation metadata')
  return {
    chatId: value.chatId,
    sourceWitness: value.sourceWitness,
    epoch: { global: value.epoch.global, chat: value.epoch.chat },
    heads: { desktop: value.heads.desktop, host: value.heads.host }
  }
}

const GENERATION_COLUMNS = `g.chat_id,g.generation,substr(g.source_witness,1,4097) AS source_witness,
  substr(g.epoch_json,1,1025) AS epoch_json,substr(g.heads_json,1,4097) AS heads_json,
  substr(g.projection_json,1,${THREAD_CATALOGUE_MAX_HEAD_BYTES + 1}) AS projection_json`

interface ObjectRow {
  ordinal: number
  byte_length: number
  preview_json: string
  sha256: string
}

function limit(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback
}

/**
 * Worker-only, disposable query index. Canonical history remains in the profile
 * stores. No constructor or query from this module belongs on Electron main.
 * Staged generations are invisible until their commit marker is published.
 */
export class ThreadCatalogueDatabase {
  private readonly database!: DatabaseSync
  readonly filePath: string
  readonly databaseId: string

  constructor(
    directory: string,
    private readonly options: ThreadCatalogueDatabaseOptions = {
      isPublicationCurrent: () => false,
      isInventoryCurrent: () => false,
      hasUnresolvedPublications: () => true
    }
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.filePath = path.join(directory, 'query.sqlite')
    try {
      fs.closeSync(fs.openSync(this.filePath, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    try {
      this.database = new DatabaseSync(this.filePath)
      this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = EXTRA;
      PRAGMA secure_delete = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -32768;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS index_format (version INTEGER NOT NULL, database_id TEXT NOT NULL);
    `)
      this.database
        .prepare(
          'INSERT INTO index_format SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM index_format)'
        )
        .run(THREAD_INDEX_SCHEMA_VERSION, randomUUID())
      const format = this.database.prepare('SELECT version,database_id FROM index_format').get()
      const version = format?.version
      this.databaseId = String(format?.database_id ?? '')
      if (version !== THREAD_INDEX_SCHEMA_VERSION) {
        throw new Error('Unsupported thread query index schema')
      }
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, source_witness TEXT NOT NULL,
        epoch_json TEXT NOT NULL, heads_json TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
        projection_json TEXT, updated_at REAL, workspace_id TEXT, parent_chat_id TEXT,
        PRIMARY KEY (chat_id, generation)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS current_generations (
        chat_id TEXT PRIMARY KEY, generation TEXT NOT NULL, publication_id TEXT NOT NULL,
        updated_at REAL NOT NULL, workspace_id TEXT, parent_chat_id TEXT,
        FOREIGN KEY (chat_id, generation) REFERENCES generations(chat_id, generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS objects (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL, record_id TEXT NOT NULL, byte_length INTEGER NOT NULL,
        preview_json TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, sha256 TEXT,
        PRIMARY KEY (chat_id, generation, kind, ordinal),
        FOREIGN KEY (chat_id, generation) REFERENCES generations(chat_id, generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS run_summary_order (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL,
        active INTEGER NOT NULL, recency REAL NOT NULL,
        PRIMARY KEY(chat_id,generation,ordinal),
        FOREIGN KEY(chat_id,generation) REFERENCES generations(chat_id,generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS introspection_order (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL, timestamp REAL NOT NULL,
        PRIMARY KEY(chat_id,generation,ordinal),
        FOREIGN KEY(chat_id,generation) REFERENCES generations(chat_id,generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS introspection_window ON introspection_order(timestamp,chat_id,ordinal);
      CREATE INDEX IF NOT EXISTS recent_run_summary ON run_summary_order(active DESC,recency DESC,chat_id,ordinal);
      CREATE INDEX IF NOT EXISTS object_identity ON objects(chat_id, generation, kind, record_id, ordinal);
      CREATE TABLE IF NOT EXISTS chunks (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL, chunk_no INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY (chat_id, generation, kind, ordinal, chunk_no),
        FOREIGN KEY (chat_id, generation, kind, ordinal)
          REFERENCES objects(chat_id, generation, kind, ordinal) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS message_activity (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL,
        timestamp REAL, day_key TEXT NOT NULL, quantity INTEGER NOT NULL, summary_only INTEGER NOT NULL,
        PRIMARY KEY(chat_id,generation,ordinal),
        FOREIGN KEY(chat_id,generation) REFERENCES generations(chat_id,generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS message_activity_totals (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, day_key TEXT NOT NULL,
        quantity INTEGER NOT NULL, first_at REAL, last_at REAL, summary_only INTEGER NOT NULL,
        PRIMARY KEY(chat_id,day_key,generation),
        FOREIGN KEY(chat_id,generation) REFERENCES generations(chat_id,generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS message_activity_days ON message_activity(chat_id,day_key,generation,timestamp);
      CREATE TABLE IF NOT EXISTS run_locator (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT NOT NULL,
        PRIMARY KEY (chat_id, generation, ordinal),
        FOREIGN KEY (chat_id, generation) REFERENCES generations(chat_id, generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS run_identity ON run_locator(run_id, chat_id, generation);
      CREATE TABLE IF NOT EXISTS indexed_kinds (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, kind TEXT NOT NULL, record_count INTEGER NOT NULL,
        PRIMARY KEY (chat_id, generation, kind),
        FOREIGN KEY (chat_id, generation) REFERENCES generations(chat_id, generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS catalogue_global ON current_generations(updated_at DESC, chat_id ASC);
      CREATE INDEX IF NOT EXISTS catalogue_workspace ON current_generations(workspace_id, updated_at DESC, chat_id ASC);
      CREATE INDEX IF NOT EXISTS catalogue_parent ON current_generations(parent_chat_id, updated_at DESC, chat_id ASC);
      CREATE TABLE IF NOT EXISTS activated_generations (
        chat_id TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(chat_id,generation),
        FOREIGN KEY(chat_id,generation) REFERENCES generations(chat_id,generation) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS known_chats (chat_id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS inventory_state (id INTEGER PRIMARY KEY CHECK(id=1), witness TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_durability_proofs (
        chat_id TEXT NOT NULL, epoch_json TEXT NOT NULL, debt_id TEXT NOT NULL,
        PRIMARY KEY(chat_id,epoch_json,debt_id)
      ) WITHOUT ROWID;
    `)
    } catch (error) {
      try {
        this.database?.close()
      } catch {
        /* Constructor cleanup retains the original failure. */
      }
      throw error
    }
  }

  close(): void {
    this.database.close()
  }

  sourceDurabilityProven(chatId: string, epoch: ThreadCatalogueEpoch, debtId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          'SELECT 1 FROM source_durability_proofs WHERE chat_id=? AND epoch_json=? AND debt_id=?'
        )
        .get(chatId, JSON.stringify(epoch), debtId)
    )
  }

  recordSourceDurabilityProofs(
    chatId: string,
    epoch: ThreadCatalogueEpoch,
    debtIds: readonly string[]
  ): void {
    this.transaction(() => {
      const insert = this.database.prepare(
        'INSERT OR IGNORE INTO source_durability_proofs VALUES (?,?,?)'
      )
      for (const id of debtIds) insert.run(chatId, JSON.stringify(epoch), id)
    })
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertStaging(generation: ThreadIndexedGeneration): void {
    const row = this.database
      .prepare(
        `SELECT committed,source_witness,epoch_json,heads_json
      FROM generations WHERE chat_id=? AND generation=?`
      )
      .get(generation.chatId, generation.generation)
    if (
      !row ||
      row.committed !== 0 ||
      row.source_witness !== generation.sourceWitness ||
      row.epoch_json !== JSON.stringify(generation.epoch) ||
      row.heads_json !== JSON.stringify(generation.heads)
    ) {
      throw new Error('Thread index generation is not staging')
    }
  }

  hasKind(generation: ThreadIndexedGeneration, kind: string): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM indexed_kinds WHERE chat_id=? AND generation=? AND kind=?')
        .get(generation.chatId, generation.generation, kind)
    )
  }

  /** Completeness is explicit: an unbuilt query family must never read as an empty one. */
  sealKind(
    generation: ThreadIndexedGeneration,
    kind: ThreadIndexedObjectKind | 'run-locator' | 'message-activity',
    expectedCount: number
  ): void {
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0)
      throw new Error('Invalid index coverage count')
    this.transaction(() => {
      this.assertStaging(generation)
      const count =
        kind === 'run-locator' || kind === 'message-activity'
          ? this.database
              .prepare(
                `SELECT count(*) AS n FROM ${kind === 'run-locator' ? 'run_locator' : 'message_activity'} WHERE chat_id=? AND generation=?`
              )
              .get(generation.chatId, generation.generation)?.n
          : this.database
              .prepare(
                'SELECT count(*) AS n FROM objects WHERE chat_id=? AND generation=? AND kind=?'
              )
              .get(generation.chatId, generation.generation, kind)?.n
      if (Number(count) !== expectedCount) throw new Error('Thread index coverage is incomplete')
      if (
        kind !== 'run-locator' &&
        kind !== 'message-activity' &&
        this.database
          .prepare(
            `SELECT 1 FROM objects WHERE chat_id=? AND generation=? AND kind=?
          AND (complete<>1 OR byte_length<1 OR length(sha256)<>64) LIMIT 1`
          )
          .get(generation.chatId, generation.generation, kind)
      ) {
        throw new Error('Thread index object is incomplete')
      }
      if (kind === 'message-activity') {
        this.database
          .prepare(
            `INSERT INTO message_activity_totals
          SELECT chat_id,generation,day_key,sum(quantity),min(timestamp),max(timestamp),max(summary_only)
          FROM message_activity WHERE chat_id=? AND generation=? GROUP BY day_key`
          )
          .run(generation.chatId, generation.generation)
      }
      this.database
        .prepare(
          'INSERT INTO indexed_kinds (chat_id,generation,kind,record_count) VALUES (?,?,?,?)'
        )
        .run(generation.chatId, generation.generation, kind, expectedCount)
    })
  }

  beginGeneration(
    input: Omit<ThreadIndexedGeneration, 'databaseId' | 'generation'>
  ): ThreadIndexedGeneration {
    input = generationMetadata(input)
    const generation = randomUUID()
    this.database
      .prepare(
        `INSERT INTO generations
      (chat_id,generation,source_witness,epoch_json,heads_json) VALUES (?,?,?,?,?)`
      )
      .run(
        input.chatId,
        generation,
        input.sourceWitness,
        JSON.stringify(input.epoch),
        JSON.stringify(input.heads)
      )
    return { ...input, databaseId: this.databaseId, generation }
  }

  /** Decoder frames are bounded before a transaction starts; no history object enters this API. */
  writeObjectFrames(
    generation: ThreadIndexedGeneration,
    frames: readonly ThreadIndexObjectFrame[]
  ): void {
    if (frames.length > 512) throw new Error('Thread index frame batch exceeds 512 frames')
    let bytes = 0
    for (const frame of frames) {
      if (
        ![
          'control',
          'introspection',
          'message',
          'run',
          'run-summary',
          'shell',
          'recovery',
          'record',
          'people-donor',
          'remote'
        ].includes(frame.kind) ||
        !Number.isSafeInteger(frame.ordinal) ||
        frame.ordinal < 0
      )
        throw new Error('Invalid thread object frame')
      bytes += 256
      if (frame.type === 'start') {
        if (
          typeof frame.recordId !== 'string' ||
          frame.recordId.length > 1024 ||
          typeof frame.previewJson !== 'string' ||
          Buffer.byteLength(frame.previewJson) > 16 * 1024
        ) {
          throw new Error('Thread object preview exceeds its byte budget')
        }
        bytes += Buffer.byteLength(frame.recordId) + Buffer.byteLength(frame.previewJson)
      } else if (frame.type === 'chunk') {
        if (
          !(frame.payload instanceof Uint8Array) ||
          frame.payload.byteLength < 1 ||
          frame.payload.byteLength > THREAD_INDEX_CHUNK_BYTES ||
          !Number.isSafeInteger(frame.chunkNo) ||
          frame.chunkNo < 0
        ) {
          throw new Error('Invalid thread object chunk')
        }
        bytes += frame.payload.byteLength
      } else if (frame.type === 'finish') {
        if (
          !Number.isSafeInteger(frame.byteLength) ||
          frame.byteLength < 1 ||
          !/^[a-f0-9]{64}$/.test(frame.sha256)
        ) {
          throw new Error('Invalid thread object completion')
        }
      } else throw new Error('Invalid thread object frame type')
    }
    if (bytes > 256 * 1024) throw new Error('Thread index frame batch exceeds its byte budget')
    this.transaction(() => {
      this.assertStaging(generation)
      const chat = generation.chatId
      const version = generation.generation
      for (const frame of frames) {
        if (this.hasKind(generation, frame.kind))
          throw new Error('Thread index query family is already sealed')
        const row = this.database
          .prepare(
            `SELECT record_id,preview_json,byte_length,chunk_count,complete,sha256
          FROM objects WHERE chat_id=? AND generation=? AND kind=? AND ordinal=?`
          )
          .get(chat, version, frame.kind, frame.ordinal)
        if (frame.type === 'start') {
          JSON.parse(frame.previewJson)
          if (row) {
            if (row.record_id !== frame.recordId || row.preview_json !== frame.previewJson)
              throw new Error('Thread object start conflicts')
            continue
          }
          this.database
            .prepare(
              `INSERT INTO objects (chat_id,generation,kind,ordinal,record_id,byte_length,preview_json)
            VALUES (?,?,?,?,?,0,?)`
            )
            .run(chat, version, frame.kind, frame.ordinal, frame.recordId, frame.previewJson)
          if (frame.kind === 'introspection') {
            const preview = JSON.parse(frame.previewJson)
            if (!Number.isFinite(preview.catalogueTimestamp))
              throw new Error('Invalid introspection timestamp')
            this.database
              .prepare('INSERT INTO introspection_order VALUES (?,?,?,?)')
              .run(chat, version, frame.ordinal, preview.catalogueTimestamp)
          }
          if (frame.kind === 'run-summary') {
            const preview = JSON.parse(frame.previewJson)
            this.database
              .prepare('INSERT INTO run_summary_order VALUES (?,?,?,?,?)')
              .run(
                chat,
                version,
                frame.ordinal,
                preview.catalogueActive === true ? 1 : 0,
                Number.isFinite(preview.catalogueRecency) ? preview.catalogueRecency : 0
              )
          }
          continue
        }
        if (!row) throw new Error('Thread object was not started')
        if (frame.type === 'chunk') {
          if (frame.chunkNo < Number(row.chunk_count)) {
            const duplicate = this.database
              .prepare(
                `SELECT 1 FROM chunks WHERE chat_id=? AND generation=?
              AND kind=? AND ordinal=? AND chunk_no=? AND payload=?`
              )
              .get(chat, version, frame.kind, frame.ordinal, frame.chunkNo, frame.payload)
            if (!duplicate) throw new Error('Thread object chunk retry conflicts')
            continue
          }
          if (
            row.complete !== 0 ||
            frame.chunkNo !== Number(row.chunk_count) ||
            Number(row.byte_length) !== frame.chunkNo * THREAD_INDEX_CHUNK_BYTES
          )
            throw new Error('Thread object chunk is out of order')
          this.database
            .prepare(
              `INSERT INTO chunks (chat_id,generation,kind,ordinal,chunk_no,payload)
            VALUES (?,?,?,?,?,?)`
            )
            .run(chat, version, frame.kind, frame.ordinal, frame.chunkNo, frame.payload)
          this.database
            .prepare(
              `UPDATE objects SET byte_length=byte_length+?,chunk_count=chunk_count+1
            WHERE chat_id=? AND generation=? AND kind=? AND ordinal=?`
            )
            .run(frame.payload.byteLength, chat, version, frame.kind, frame.ordinal)
        } else {
          if (
            Number(row.byte_length) !== frame.byteLength ||
            Number(row.chunk_count) !== Math.ceil(frame.byteLength / THREAD_INDEX_CHUNK_BYTES)
          ) {
            throw new Error('Thread object chunks are incomplete')
          }
          if (row.complete === 1 && row.sha256 !== frame.sha256)
            throw new Error('Thread object completion retry conflicts')
          this.database
            .prepare(
              `UPDATE objects SET complete=1,sha256=? WHERE chat_id=? AND generation=? AND kind=? AND ordinal=?`
            )
            .run(frame.sha256, chat, version, frame.kind, frame.ordinal)
        }
      }
    })
  }

  writeMessageActivity(
    generation: ThreadIndexedGeneration,
    rows: readonly {
      ordinal: number
      timestamp: number | null
      dayKey: string
      count: number
      summaryOnly: boolean
    }[]
  ): void {
    if (rows.length > 256) throw new Error('Message activity batch exceeds 256 rows')
    this.transaction(() => {
      this.assertStaging(generation)
      if (this.hasKind(generation, 'message-activity'))
        throw new Error('Message activity is already sealed')
      const insert = this.database.prepare('INSERT INTO message_activity VALUES (?,?,?,?,?,?,?)')
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.ordinal) ||
          row.ordinal < 0 ||
          !Number.isSafeInteger(row.count) ||
          row.count < 0 ||
          row.dayKey.length > 32 ||
          (row.timestamp !== null && !Number.isFinite(row.timestamp))
        )
          throw new Error('Invalid message activity fact')
        insert.run(
          generation.chatId,
          generation.generation,
          row.ordinal,
          row.timestamp,
          row.dayKey,
          row.count,
          row.summaryOnly ? 1 : 0
        )
      }
    })
  }

  /** Only bounded day totals cross the worker boundary, never per-message rows. */
  messageActivityPage(
    request: MessageActivityRequest,
    after?: { chatId: string; dayKey: string }
  ): ThreadCatalogueActivityPage {
    const reset = Number.isFinite(request.resetAt) && request.resetAt > 0 ? request.resetAt : 0
    const range =
      Number.isFinite(request.rangeStart) && request.rangeStart > 0 ? request.rangeStart : 0
    // Full days use their materialized totals. Only a day straddling a cutoff
    // consults its timestamp index, preserving instant precision without a
    // whole-corpus timestamp scan on each dashboard refresh.
    const countAfter = `CASE WHEN a.summary_only=1 OR a.first_at IS NULL OR a.last_at<? THEN 0
      WHEN a.first_at>=? THEN a.quantity ELSE (
        SELECT coalesce(sum(m.quantity),0) FROM message_activity m
        WHERE m.chat_id=a.chat_id AND m.generation=a.generation AND m.day_key=a.day_key AND m.timestamp>=?
      ) END`
    const lifetime = reset > 0 ? reset : -8_640_000_000_000_000
    const inRange = Math.max(reset, range)
    const rows = this.database
      .prepare(
        `SELECT a.chat_id,a.day_key,a.generation,a.quantity,a.summary_only,
      ${countAfter} AS lifetime_count, ${countAfter} AS range_count
      FROM message_activity_totals a JOIN current_generations c ON c.chat_id=a.chat_id AND c.generation=a.generation
      WHERE a.chat_id>? OR (a.chat_id=? AND a.day_key>?)
      ORDER BY a.chat_id,a.day_key LIMIT 1001`
      )
      .all(
        lifetime,
        lifetime,
        lifetime,
        inRange,
        inRange,
        inRange,
        after?.chatId ?? '',
        after?.chatId ?? '',
        after?.dayKey ?? ''
      )
    const missing = this.database
      .prepare(
        `SELECT 1 FROM current_generations c LEFT JOIN indexed_kinds k
      ON k.chat_id=c.chat_id AND k.generation=c.generation AND k.kind='message-activity' WHERE k.kind IS NULL LIMIT 1`
      )
      .get()
    let complete = this.corpusReady() && !missing
    const checked = new Set<string>()
    const page = rows.slice(0, 1000).map((row) => {
      const chatId = String(row.chat_id)
      if (!checked.has(chatId)) {
        checked.add(chatId)
        if (this.current(chatId)?.generation !== row.generation) complete = false
      }
      return {
        chatId,
        dayKey: String(row.day_key),
        lifetimeCount: Number(row.lifetime_count),
        rangeCount: Number(row.range_count),
        hasAny:
          Number(row.quantity) > 0 &&
          (reset === 0 || row.summary_only === 1 || Number(row.lifetime_count) > 0)
      }
    })
    const last = page.at(-1)
    return {
      rows: page,
      coverage: complete ? 'complete' : 'partial',
      next: rows.length > 1000 && last ? { chatId: last.chatId, dayKey: last.dayKey } : null
    }
  }

  writeRunLocators(
    generation: ThreadIndexedGeneration,
    runs: readonly { ordinal: number; runId: string }[]
  ): void {
    if (runs.length > 256) throw new Error('Thread run locator batch exceeds 256 entries')
    this.transaction(() => {
      this.assertStaging(generation)
      if (this.hasKind(generation, 'run-locator'))
        throw new Error('Thread run locator is already sealed')
      const put = this.database.prepare(
        'INSERT INTO run_locator (chat_id,generation,ordinal,run_id) VALUES (?,?,?,?)'
      )
      for (const run of runs)
        put.run(generation.chatId, generation.generation, run.ordinal, run.runId)
    })
  }

  /** The caller publishes a resolved catalogue slot only AFTER this durable commit. */
  commitGeneration(generation: ThreadIndexedGeneration, input: ThreadCatalogueProjection): void {
    const projection = copyThreadCatalogueProjection(input, generation.chatId)
    if (!projection) throw new Error('Invalid thread query projection')
    this.transaction(() => {
      this.assertStaging(generation)
      for (const [kind, expected] of [
        ['message', projection.summary.messageCount],
        ['run', projection.summary.runCount],
        ['run-locator', projection.summary.runCount],
        [
          'recovery',
          projection.recovery.unsettledRuns +
            projection.recovery.ensembleWakeups +
            projection.recovery.soloWakeups +
            projection.recovery.workerEvents +
            projection.recovery.joinPolicies +
            (projection.recovery.nextBlackboardExpiryAt === null ? 0 : 1)
        ]
      ] as const) {
        const covered = this.database
          .prepare(
            'SELECT record_count FROM indexed_kinds WHERE chat_id=? AND generation=? AND kind=?'
          )
          .get(generation.chatId, generation.generation, kind)
        if (covered && Number(covered.record_count) !== expected)
          throw new Error('Thread index coverage does not match its projection')
      }
      const changed = this.database
        .prepare(
          `UPDATE generations SET committed=1,projection_json=?,
        updated_at=?,workspace_id=?,parent_chat_id=? WHERE chat_id=? AND generation=? AND committed=0`
        )
        .run(
          JSON.stringify(projection),
          projection.summary.updatedAt,
          projection.summary.workspaceId ?? null,
          projection.summary.parentChatId ?? null,
          generation.chatId,
          generation.generation
        )
      if (Number(changed.changes) !== 1) throw new Error('Thread index generation is not staging')
    })
  }

  /** Called after publication, and checked against that exact currently published slot. */
  activateGeneration(generation: ThreadIndexedGeneration, publicationId: string): boolean {
    if (!this.isCommitted(generation) || !this.publicationCurrent(generation, publicationId))
      return false
    const row = this.database
      .prepare(
        `SELECT updated_at,workspace_id,parent_chat_id FROM generations
      WHERE chat_id=? AND generation=?`
      )
      .get(generation.chatId, generation.generation)!
    this.database
      .prepare(
        `INSERT INTO current_generations
      (chat_id,generation,publication_id,updated_at,workspace_id,parent_chat_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET generation=excluded.generation,publication_id=excluded.publication_id,
        updated_at=excluded.updated_at,workspace_id=excluded.workspace_id,parent_chat_id=excluded.parent_chat_id`
      )
      .run(
        generation.chatId,
        generation.generation,
        publicationId,
        row.updated_at,
        row.workspace_id,
        row.parent_chat_id
      )
    this.database
      .prepare('INSERT OR IGNORE INTO activated_generations (chat_id,generation) VALUES (?,?)')
      .run(generation.chatId, generation.generation)
    return true
  }

  private publicationCurrent(generation: ThreadIndexedGeneration, publicationId: string): boolean {
    if (typeof publicationId !== 'string' || !publicationId || publicationId.length > 128)
      return false
    try {
      return this.options.isPublicationCurrent(generation, publicationId) === true
    } catch {
      return false
    }
  }

  isCommitted(generation: ThreadIndexedGeneration): boolean {
    if (generation.databaseId !== this.databaseId) return false
    try {
      const bounded = generationMetadata(generation)
      return Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM generations WHERE chat_id=? AND generation=?
        AND source_witness=? AND epoch_json=? AND heads_json=? AND committed=1`
          )
          .get(
            bounded.chatId,
            generation.generation,
            bounded.sourceWitness,
            JSON.stringify(bounded.epoch),
            JSON.stringify(bounded.heads)
          )
      )
    } catch {
      return false
    }
  }

  private decodeRow(
    row: Record<string, unknown>
  ): (ThreadIndexedGeneration & { projection: ThreadCatalogueProjection }) | null {
    try {
      if (
        typeof row.projection_json !== 'string' ||
        Buffer.byteLength(row.projection_json) > THREAD_CATALOGUE_MAX_HEAD_BYTES ||
        typeof row.generation !== 'string' ||
        row.generation.length > 128
      )
        return null
      const bounded = generationMetadata({
        chatId: String(row.chat_id),
        sourceWitness: String(row.source_witness),
        epoch: JSON.parse(String(row.epoch_json)),
        heads: JSON.parse(String(row.heads_json))
      })
      const projection = copyThreadCatalogueProjection(
        JSON.parse(row.projection_json),
        bounded.chatId
      )
      return projection
        ? { ...bounded, databaseId: this.databaseId, generation: row.generation, projection }
        : null
    } catch {
      return null
    }
  }

  current(
    chatId: string
  ): (ThreadIndexedGeneration & { projection: ThreadCatalogueProjection }) | null {
    const row = this.database
      .prepare(
        `SELECT ${GENERATION_COLUMNS},c.publication_id FROM current_generations c
      JOIN generations g ON c.chat_id=g.chat_id AND c.generation=g.generation WHERE c.chat_id=? AND g.committed=1`
      )
      .get(chatId)
    if (!row) return null
    const entry = this.decodeRow(row)
    return entry && this.publicationCurrent(entry, String(row.publication_id)) ? entry : null
  }

  /** File-name inventory only; the owning worker supplies and verifies its source witness. */
  setInventory(chatIds: readonly string[], witness: string): void {
    if (
      typeof witness !== 'string' ||
      !witness ||
      witness.length > 4096 ||
      chatIds.some((id) => !isSafeChatId(id))
    ) {
      throw new Error('Invalid thread inventory')
    }
    this.transaction(() => {
      this.database.exec('DELETE FROM known_chats')
      const put = this.database.prepare('INSERT OR IGNORE INTO known_chats (chat_id) VALUES (?)')
      for (const id of chatIds) put.run(id)
      this.database
        .prepare(
          'INSERT INTO inventory_state (id,witness) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET witness=excluded.witness'
        )
        .run(witness)
    })
  }

  private inventoryReady(): boolean {
    const row = this.database.prepare('SELECT witness FROM inventory_state WHERE id=1').get()
    try {
      return Boolean(
        row &&
        this.options.isInventoryCurrent(String(row.witness)) &&
        !this.options.hasUnresolvedPublications()
      )
    } catch {
      return false
    }
  }

  private corpusReady(): boolean {
    if (!this.inventoryReady()) return false
    return !this.database
      .prepare(
        `SELECT 1 FROM known_chats k LEFT JOIN current_generations c
      ON c.chat_id=k.chat_id WHERE c.chat_id IS NULL LIMIT 1`
      )
      .get()
  }

  list(
    options: {
      workspaceId?: string
      parentChatId?: string
      before?: { updatedAt: number; chatId: string }
      limit?: number
    } = {}
  ): {
    entries: Array<ThreadIndexedGeneration & { projection: ThreadCatalogueProjection }>
    next: { updatedAt: number; chatId: string } | null
    coverage: 'partial' | 'complete'
    repairPending: string[]
  } {
    const pageLimit = limit(options.limit, 1, 100, 100)
    const predicates = ['g.committed=1']
    const parameters: Array<string | number> = []
    if (options.workspaceId !== undefined) {
      predicates.push('c.workspace_id=?')
      parameters.push(options.workspaceId)
    }
    if (options.parentChatId !== undefined) {
      predicates.push('c.parent_chat_id=?')
      parameters.push(options.parentChatId)
    }
    if (options.before) {
      predicates.push('(c.updated_at < ? OR (c.updated_at = ? AND c.chat_id > ?))')
      parameters.push(options.before.updatedAt, options.before.updatedAt, options.before.chatId)
    }
    const statement = this.database
      .prepare(`SELECT ${GENERATION_COLUMNS},c.publication_id,c.updated_at FROM current_generations c
      JOIN generations g ON c.chat_id=g.chat_id AND c.generation=g.generation WHERE ${predicates.join(' AND ')}
      ORDER BY c.updated_at DESC,c.chat_id ASC LIMIT ?`)
    const entries: Array<ThreadIndexedGeneration & { projection: ThreadCatalogueProjection }> = []
    const repairPending: string[] = []
    let last: { updatedAt: number; chatId: string } | null = null
    let more = false
    let scanned = 0
    let bytes = 256
    for (const row of statement.iterate(...parameters, pageLimit + 1)) {
      if (scanned === pageLimit) {
        more = true
        break
      }
      const entry = this.decodeRow(row)
      const cost = entry
        ? Buffer.byteLength(JSON.stringify(entry)) + 1
        : Buffer.byteLength(String(row.chat_id)) + 4
      if (bytes + cost > THREAD_INDEX_MAX_REPLY_BYTES) {
        more = true
        break
      }
      scanned += 1
      bytes += cost
      last = { updatedAt: Number(row.updated_at), chatId: String(row.chat_id) }
      if (!entry || !this.publicationCurrent(entry, String(row.publication_id)))
        repairPending.push(String(row.chat_id))
      else entries.push(entry)
    }
    return {
      entries,
      next: more ? last : null,
      repairPending,
      coverage: repairPending.length === 0 && this.corpusReady() ? 'complete' : 'partial'
    }
  }

  /** Positive evidence only; a miss is never a complete historical-identity proof. */
  findKnownRun(runId: string): { chatId: string } | null {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT r.chat_id,r.generation FROM run_locator r
      JOIN current_generations c ON c.chat_id=r.chat_id AND c.generation=r.generation
      WHERE r.run_id=? LIMIT 100`
      )
      .all(runId)
    for (const row of rows)
      if (this.current(String(row.chat_id))?.generation === row.generation)
        return { chatId: String(row.chat_id) }
    return null
  }

  findRun(runId: string): { chatId: string; generation: string; ordinal: number } | null {
    const rows = this.database
      .prepare(
        `SELECT r.chat_id,r.generation,min(r.ordinal) AS ordinal FROM run_locator r
      JOIN current_generations c ON c.chat_id=r.chat_id AND c.generation=r.generation
      JOIN generations g ON g.chat_id=r.chat_id AND g.generation=r.generation AND g.committed=1
      WHERE r.run_id=? GROUP BY r.chat_id,r.generation ORDER BY r.chat_id LIMIT 2`
      )
      .all(runId)
    if (rows.length > 1) throw new Error('Thread run identity is ambiguous')
    const row = rows[0]
    if (row && this.current(String(row.chat_id))?.generation !== row.generation)
      throw new Error('Thread run location requires repair')
    if (!row) {
      if (!this.corpusReady()) throw new Error('Thread inventory is incomplete')
      const incomplete = this.database
        .prepare(
          `SELECT 1 FROM current_generations c
        LEFT JOIN indexed_kinds k ON k.chat_id=c.chat_id AND k.generation=c.generation AND k.kind='run-locator'
        WHERE k.kind IS NULL LIMIT 1`
        )
        .get()
      if (incomplete) throw new Error('Thread run locator is incomplete')
    }
    return row
      ? {
          chatId: String(row.chat_id),
          generation: String(row.generation),
          ordinal: Number(row.ordinal)
        }
      : null
  }

  introspectionPage(
    window: { windowStart: string; windowEnd: string; workspaceId?: string },
    after?: { chatId: string; ordinal: number }
  ): {
    items: ThreadIndexedObject[]
    next: { chatId: string; ordinal: number } | null
    coverage: 'complete' | 'partial'
  } {
    const start = Date.parse(window.windowStart),
      end = Date.parse(window.windowEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Invalid introspection window')
    const missing = this.database
      .prepare(
        `SELECT 1 FROM current_generations c LEFT JOIN indexed_kinds k
      ON k.chat_id=c.chat_id AND k.generation=c.generation AND k.kind='introspection' WHERE k.kind IS NULL LIMIT 1`
      )
      .get()
    let complete = this.corpusReady() && !missing
    const rows = this.database
      .prepare(
        `SELECT i.chat_id,i.generation,i.ordinal FROM introspection_order i
      JOIN current_generations c ON c.chat_id=i.chat_id AND c.generation=i.generation
      WHERE i.timestamp>=? AND i.timestamp<=? AND (? IS NULL OR c.workspace_id=?)
        AND (i.chat_id>? OR (i.chat_id=? AND i.ordinal>?)) ORDER BY i.chat_id,i.ordinal LIMIT 101`
      )
      .all(
        start,
        end,
        window.workspaceId ?? null,
        window.workspaceId ?? null,
        after?.chatId ?? '',
        after?.chatId ?? '',
        after?.ordinal ?? -1
      )
    const items: ThreadIndexedObject[] = []
    let bytes = 256
    let last: { chatId: string; ordinal: number } | null = null
    for (const row of rows.slice(0, 100)) {
      const current = this.current(String(row.chat_id))
      if (
        !current ||
        current.generation !== row.generation ||
        current.projection.sourceComplete === false
      ) {
        complete = false
        break
      }
      const ordinal = Number(row.ordinal)
      const objects = this.readObjects(current, 'introspection', {
        before: ordinal + 1,
        ...(ordinal ? { after: ordinal - 1 } : {}),
        maxObjects: 1,
        maxBytes: Math.max(1024, THREAD_INDEX_MAX_REPLY_BYTES - bytes)
      })
      if (!objects?.length) {
        complete = false
        break
      }
      const size = Buffer.byteLength(JSON.stringify(objects[0])) + 1
      if (bytes + size > THREAD_INDEX_MAX_REPLY_BYTES) break
      bytes += size
      items.push(objects[0])
      last = { chatId: current.chatId, ordinal }
    }
    return {
      items,
      coverage: complete ? 'complete' : 'partial',
      next: rows.length > items.length ? last : null
    }
  }

  hostRunPage(offset = 0): {
    entries: Array<{ chatId: string; sourceWitness: string; run: unknown }>
    next: number | null
    total: number
  } {
    offset = limit(offset, 0, 1800, 0)
    const rows = this.database
      .prepare(
        `SELECT r.chat_id,r.generation,r.ordinal,g.source_witness FROM run_summary_order r
      JOIN current_generations c ON c.chat_id=r.chat_id AND c.generation=r.generation
      JOIN generations g ON g.chat_id=r.chat_id AND g.generation=r.generation
      ORDER BY r.active DESC,r.recency DESC,r.chat_id,r.ordinal LIMIT 100 OFFSET ?`
      )
      .all(offset)
    const entries: Array<{ chatId: string; sourceWitness: string; run: unknown }> = []
    for (const row of rows) {
      const current = this.current(String(row.chat_id))
      if (!current || current.generation !== row.generation) continue
      const objects = this.readObjects(current, 'run-summary', {
        before: Number(row.ordinal) + 1,
        ...(Number(row.ordinal) ? { after: Number(row.ordinal) - 1 } : {}),
        maxObjects: 1,
        maxBytes: 16 * 1024
      })
      if (objects?.[0]?.kind === 'inline')
        entries.push({
          chatId: current.chatId,
          sourceWitness: current.sourceWitness,
          run: objects[0].value
        })
    }
    const total = Number(
      this.database
        .prepare(
          `SELECT COALESCE(sum(k.record_count),0) AS count FROM indexed_kinds k
      JOIN current_generations c ON c.chat_id=k.chat_id AND c.generation=k.generation WHERE k.kind='run-summary'`
        )
        .get()?.count ?? 0
    )
    return {
      entries,
      next: rows.length === 100 && offset + 100 < Math.min(total, 1800) ? offset + 100 : null,
      total
    }
  }

  pageRunOrdinals(
    generation: ThreadIndexedGeneration,
    start: number,
    end: number,
    maximum = 512
  ): number[] {
    if (
      !this.isCommitted(generation) ||
      !this.hasKind(generation, 'run') ||
      !this.hasKind(generation, 'message')
    )
      throw new Error('Transcript page is incomplete')
    const cap = limit(maximum, 1, 512, 512)
    const total =
      this.database
        .prepare(
          "SELECT record_count FROM indexed_kinds WHERE chat_id=? AND generation=? AND kind='run'"
        )
        .get(generation.chatId, generation.generation)?.record_count ?? 0
    const rows = this.database
      .prepare(
        `SELECT r.ordinal FROM objects r
      WHERE r.chat_id=? AND r.generation=? AND r.kind='run' AND (
        ? <= ? OR json_extract(r.preview_json,'$.endedAt') IS NULL OR
        r.record_id IN (SELECT json_extract(m.preview_json,'$.runId') FROM objects m
          WHERE m.chat_id=r.chat_id AND m.generation=r.generation AND m.kind='message' AND m.ordinal>=? AND m.ordinal<?) OR
        json_extract(r.preview_json,'$.promptMessageId') IN (SELECT m.record_id FROM objects m
          WHERE m.chat_id=r.chat_id AND m.generation=r.generation AND m.kind='message' AND m.ordinal>=? AND m.ordinal<?)
      ) ORDER BY r.ordinal DESC LIMIT ?`
      )
      .all(
        generation.chatId,
        generation.generation,
        Number(total),
        cap,
        start,
        end,
        start,
        end,
        cap
      )
    return rows.map((row) => Number(row.ordinal)).reverse()
  }

  findOrdinal(
    generation: ThreadIndexedGeneration,
    kind: ThreadIndexedObjectKind,
    recordId: string
  ): number | null {
    if (!this.isCommitted(generation)) throw new Error('Thread query generation is unavailable')
    if (!this.hasKind(generation, kind)) throw new Error('Thread query family is incomplete')
    const row = this.database
      .prepare(
        `SELECT ordinal FROM objects
      WHERE chat_id=? AND generation=? AND kind=? AND record_id=? ORDER BY ordinal LIMIT 1`
      )
      .get(generation.chatId, generation.generation, kind, recordId)
    return row ? Number(row.ordinal) : null
  }

  readObjects(
    generation: ThreadIndexedGeneration,
    kind: ThreadIndexedObjectKind,
    options: {
      before?: number
      after?: number
      direction?: 'older' | 'newer'
      maxObjects?: number
      maxBytes?: number
    } = {}
  ): ThreadIndexedObject[] | null {
    if (!this.isCommitted(generation) || !this.hasKind(generation, kind)) return null
    const older = options.direction !== 'newer'
    const maxObjects = limit(options.maxObjects, 1, 1500, 100)
    const maxBytes = limit(
      options.maxBytes,
      1024,
      THREAD_INDEX_MAX_REPLY_BYTES,
      THREAD_INDEX_MAX_REPLY_BYTES
    )
    const predicates = ['chat_id=?', 'generation=?', 'kind=?']
    const parameters: Array<string | number> = [generation.chatId, generation.generation, kind]
    if (options.before !== undefined) {
      predicates.push('ordinal < ?')
      parameters.push(options.before)
    }
    if (options.after !== undefined) {
      predicates.push('ordinal > ?')
      parameters.push(options.after)
    }
    const rows = this.database
      .prepare(
        `SELECT ordinal,byte_length,preview_json,sha256 FROM objects
      WHERE ${predicates.join(' AND ')} ORDER BY ordinal ${older ? 'DESC' : 'ASC'} LIMIT ?`
      )
      .all(...parameters, maxObjects) as unknown as ObjectRow[]
    const result: ThreadIndexedObject[] = []
    let bytes = 0
    for (const row of rows) {
      const inlineOverhead =
        Buffer.byteLength(
          JSON.stringify({
            kind: 'inline',
            ordinal: row.ordinal,
            value: null,
            byteLength: row.byte_length,
            sha256: row.sha256
          })
        ) - 4
      if (row.byte_length + inlineOverhead > maxBytes) {
        const chunked: ThreadIndexedObject = {
          kind: 'chunked',
          ordinal: row.ordinal,
          reference: {
            chatId: generation.chatId,
            generation: generation.generation,
            kind,
            ordinal: row.ordinal,
            byteLength: row.byte_length,
            sha256: row.sha256
          },
          preview: JSON.parse(row.preview_json)
        }
        if (Buffer.byteLength(JSON.stringify(chunked)) + bytes + 2 > maxBytes)
          chunked.preview = null
        const previewBytes = Buffer.byteLength(JSON.stringify(chunked)) + 2
        if (bytes + previewBytes > maxBytes) break
        result.push(chunked)
        bytes += previewBytes
      } else {
        if (bytes + row.byte_length + inlineOverhead + 2 > maxBytes) break
        const chunks = this.database
          .prepare(
            `SELECT substr(payload,1,?) AS payload,length(payload) AS stored_bytes
          FROM chunks WHERE chat_id=? AND generation=? AND kind=? AND ordinal=?
          ORDER BY chunk_no LIMIT ?`
          )
          .all(
            THREAD_INDEX_CHUNK_BYTES + 1,
            generation.chatId,
            generation.generation,
            kind,
            row.ordinal,
            Math.ceil(maxBytes / THREAD_INDEX_CHUNK_BYTES) + 1
          )
        if (chunks.some((chunk) => Number(chunk.stored_bytes) > THREAD_INDEX_CHUNK_BYTES)) {
          throw new Error('Thread query object has an oversized chunk')
        }
        const payload = Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk.payload as Uint8Array))
        )
        if (
          payload.byteLength !== row.byte_length ||
          createHash('sha256').update(payload).digest('hex') !== row.sha256
        )
          throw new Error('Thread query object has incomplete chunks')
        result.push({
          kind: 'inline',
          ordinal: row.ordinal,
          value: JSON.parse(payload.toString('utf8')),
          byteLength: row.byte_length,
          sha256: row.sha256
        })
        bytes += row.byte_length + inlineOverhead + 2
      }
    }
    return older ? result.reverse() : result
  }

  readChunk(
    generation: ThreadIndexedGeneration,
    ref: ThreadIndexedObjectRef,
    offset: number,
    maximum = THREAD_INDEX_CHUNK_BYTES
  ): Uint8Array | null {
    if (
      ref.chatId !== generation.chatId ||
      ref.generation !== generation.generation ||
      !this.isCommitted(generation) ||
      !this.hasKind(generation, ref.kind)
    )
      return null
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    const object = this.database
      .prepare(
        `SELECT byte_length,sha256,complete FROM objects
      WHERE chat_id=? AND generation=? AND kind=? AND ordinal=?`
      )
      .get(ref.chatId, ref.generation, ref.kind, ref.ordinal)
    if (
      !object ||
      object.complete !== 1 ||
      object.byte_length !== ref.byteLength ||
      object.sha256 !== ref.sha256
    )
      return null
    if (offset > ref.byteLength) return null
    if (offset === ref.byteLength) return new Uint8Array()
    const byteLimit = limit(maximum, 1, THREAD_INDEX_CHUNK_BYTES, THREAD_INDEX_CHUNK_BYTES)
    const chunk = Math.floor(offset / THREAD_INDEX_CHUNK_BYTES)
    const within = offset % THREAD_INDEX_CHUNK_BYTES
    const row = this.database
      .prepare(
        `SELECT substr(payload,?,?) AS payload FROM chunks
      WHERE chat_id=? AND generation=? AND kind=? AND ordinal=? AND chunk_no=?`
      )
      .get(within + 1, byteLimit, ref.chatId, ref.generation, ref.kind, ref.ordinal, chunk)
    return row ? (row.payload as Uint8Array) : null
  }

  /** Run only after the worker's readers/imports for this chat have quiesced. */
  removeChat(chatId: string): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM generations WHERE chat_id=?').run(chatId)
      this.database.prepare('DELETE FROM known_chats WHERE chat_id=?').run(chatId)
      this.database.prepare('DELETE FROM source_durability_proofs WHERE chat_id=?').run(chatId)
    })
  }

  removeAll(): void {
    this.transaction(() => {
      this.database.exec(
        'DELETE FROM generations; DELETE FROM source_durability_proofs; DELETE FROM known_chats; DELETE FROM inventory_state;'
      )
    })
  }

  discardGeneration(generation: ThreadIndexedGeneration): void {
    this.database
      .prepare('DELETE FROM generations WHERE chat_id=? AND generation=? AND committed=0')
      .run(generation.chatId, generation.generation)
  }

  /** Failed imports can be committed but never published. Never remove an active generation. */
  abandonGeneration(generation: ThreadIndexedGeneration): void {
    this.database
      .prepare(
        `DELETE FROM generations WHERE chat_id=? AND generation=? AND generation NOT IN
        (SELECT generation FROM current_generations WHERE chat_id=?)`
      )
      .run(generation.chatId, generation.generation, generation.chatId)
  }

  /** The worker retains only generations pinned by active page/chunk reads. */
  pruneSuperseded(chatId: string, pinned: readonly string[] = []): void {
    if (pinned.length > 16) throw new Error('Too many pinned thread index generations')
    const keep = pinned.length ? ` AND generation NOT IN (${pinned.map(() => '?').join(',')})` : ''
    this.database
      .prepare(
        `DELETE FROM generations WHERE chat_id=? AND committed=1 AND
      generation IN (SELECT generation FROM activated_generations WHERE chat_id=?) AND
      generation NOT IN (SELECT generation FROM current_generations WHERE chat_id=?)${keep}`
      )
      .run(chatId, chatId, chatId, ...pinned)
  }
}

export function openThreadCatalogueDatabase(
  directory: string,
  options: ThreadCatalogueDatabaseOptions
): ThreadCatalogueDatabase {
  try {
    return new ThreadCatalogueDatabase(directory, options)
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/file is not a database|database.*malformed|unsupported thread query index schema|no such column/i.test(
        error.message
      )
    )
      throw error
    // This database is disposable. Canonical records and erasure epochs live
    // outside it; a corrupt cache must not prevent the application launching.
    for (const name of [
      'query.sqlite',
      'query.sqlite-journal',
      'query.sqlite-wal',
      'query.sqlite-shm'
    ])
      fs.rmSync(path.join(directory, name), { force: true })
    return new ThreadCatalogueDatabase(directory, options)
  }
}
