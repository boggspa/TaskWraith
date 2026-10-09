import fs from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { filterRunEvents, parseRunEventLine } from '../RunEventStore'
import {
  nodeRunEventQueryReader,
  queryRunEventFilesAsync,
  splitRunEventLines,
  type RunEventQueryReader,
  type RunEventQueryStats
} from './runEventStreamingQuery'
import type { RunEventFilter, RunEventKind, RunEventRecord } from './types'

/** Deterministic PRNG, so a failing case reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KINDS = ['provider_raw', 'tool', 'approval_request'] as const

function record(fields: Partial<RunEventRecord> & { runId: string; sequence: number }) {
  return JSON.stringify({ schemaVersion: 1, ...fields })
}

/**
 * Synthetic run-event files built to stress the comparator: few distinct
 * timestamps (so one run's events and other runs' events collide), an
 * occasional event whose runId is another run's, invalid timestamps, lines
 * that do not parse, CRLF endings and a final line without a newline.
 */
function syntheticFiles(seed: number): Map<string, string> {
  const next = random(seed)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]
  const files = new Map<string, string>()
  const fileCount = 2 + Math.floor(next() * 5)
  for (let index = 0; index < fileCount; index += 1) {
    const runId = `r${index}`
    const crlf = next() < 0.3
    const lines: string[] = []
    let sequence = 0
    const count = Math.floor(next() * 14)
    for (let n = 0; n < count; n += 1) {
      const roll = next()
      if (roll < 0.06) {
        lines.push(
          pick([
            '',
            'garbage',
            '{"schemaVersion":1,"runId":"r',
            '{"schemaVersion":2,"runId":"x","sequence":1}'
          ])
        )
        continue
      }
      sequence += next() < 0.15 ? 0 : 1
      const kind = pick(KINDS)
      lines.push(
        record({
          runId: next() < 0.1 ? `r${Math.floor(next() * fileCount)}` : runId,
          sequence,
          chatId: pick(['c1', 'c2']),
          workspaceId: pick(['w1', 'w2']),
          provider: pick(['codex', 'claude']) as never,
          kind: kind as RunEventKind,
          phase: pick(['raw', 'artifact']) as never,
          ...(next() < 0.2 ? { approvalId: pick(['a1', 'a2']) } : {}),
          timestamp:
            next() < 0.05
              ? 'not a time'
              : new Date(1000 + Math.floor(next() * 4) * 7).toISOString(),
          payload: { n }
        } as never)
      )
    }
    const ending = crlf ? '\r\n' : '\n'
    files.set(`/runs/${runId}.jsonl`, lines.join(ending) + (next() < 0.7 ? ending : ''))
  }
  return files
}

/** An in-memory reader that hands each file over in chunks of random size. */
function memoryReader(
  files: Map<string, string>,
  seed = 1
): RunEventQueryReader & {
  opened: string[]
  probed: string[]
} {
  const next = random(seed)
  const opened: string[] = []
  const probed: string[] = []
  return {
    opened,
    probed,
    lines(filePath) {
      opened.push(filePath)
      const text = files.get(filePath)
      if (text === undefined) {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
          })
        }
      }
      async function* chunks() {
        let offset = 0
        while (offset < text!.length) {
          const size = 1 + Math.floor(next() * 9)
          yield text!.slice(offset, offset + size)
          offset += size
        }
      }
      return splitRunEventLines(chunks())
    },
    async newestTimestampMs(filePath) {
      probed.push(filePath)
      let newest: number | null = null
      for (const line of (files.get(filePath) ?? '').split(/\r?\n/)) {
        const event = parseRunEventLine(line)
        const ms = event ? new Date(event.timestamp).getTime() : NaN
        if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms
      }
      return newest
    }
  }
}

/** One file's events in line order, as the sync reader parses them. */
function parseFile(files: Map<string, string>, filePath: string): RunEventRecord[] {
  return (files.get(filePath) ?? '')
    .split(/\r?\n/)
    .map(parseRunEventLine)
    .filter((event): event is RunEventRecord => event !== null)
}

/** What the sync reader returns: every file read whole, then `filterRunEvents`. */
function syncAnswer(files: Map<string, string>, paths: string[], filter: RunEventFilter) {
  return filterRunEvents(
    paths.flatMap((filePath) => parseFile(files, filePath)),
    filter
  )
}

/**
 * The async reader this module replaced, verbatim in its decisions: for a
 * `{chatId, kinds?, limit}` query it skips a file whose newest event is older
 * than the oldest of the newest `limit` accepted events, then filters.
 */
async function replacedAnswer(
  files: Map<string, string>,
  paths: string[],
  filter: RunEventFilter,
  reader: RunEventQueryReader
) {
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : 0
  const bounded =
    Boolean(filter.chatId) &&
    limit >= 1 &&
    !filter.runId &&
    !filter.workspaceId &&
    !filter.provider &&
    !filter.approvalId &&
    !filter.phases?.length &&
    !Number.isFinite(filter.fromSequence)
  const kinds = filter.kinds?.length ? new Set(filter.kinds) : null
  const all: RunEventRecord[] = []
  const acceptedMs: number[] = []
  let oldestKeptMs: number | null = null
  for (const filePath of paths) {
    if (bounded && oldestKeptMs !== null) {
      const newest = await reader.newestTimestampMs(filePath)
      if (newest !== null && newest < oldestKeptMs) continue
    }
    for (const event of parseFile(files, filePath)) {
      all.push(event)
      if (bounded && event.chatId === filter.chatId && (!kinds || kinds.has(event.kind))) {
        const ms = new Date(event.timestamp).getTime()
        if (Number.isFinite(ms)) acceptedMs.push(ms)
      }
    }
    if (bounded && acceptedMs.length >= limit) {
      acceptedMs.sort((a, b) => b - a)
      acceptedMs.length = limit
      oldestKeptMs = acceptedMs[limit - 1]
    }
  }
  return filterRunEvents(all, filter)
}

const FILTERS: RunEventFilter[] = [
  {},
  { limit: 3 },
  { limit: 1 },
  { limit: 0.5 },
  { limit: NaN },
  { limit: -2 },
  { limit: 1000 },
  { limit: Infinity },
  { chatId: 'c1', limit: 4 },
  { chatId: 'c2', kinds: ['provider_raw'], limit: 2 },
  { chatId: 'c1', kinds: ['tool', 'approval_request'], limit: 3 },
  { chatId: 'c1' },
  { workspaceId: 'w2', limit: 5 },
  { provider: 'claude' as never },
  { kinds: ['tool', 'provider_raw'], phases: ['raw'] as never, limit: 3 },
  { fromSequence: 3, limit: 4 },
  { approvalId: 'a1' },
  { approvalId: 'a2', limit: 1 },
  { runId: 'r1', limit: 2 }
]

const prefilterFor = (filter: RunEventFilter) => {
  const needles = (filter.kinds ?? []).map((kind) => `"kind":"${kind}"`)
  return needles.length ? (line: string) => needles.some((needle) => line.includes(needle)) : null
}

const newStats = (): RunEventQueryStats => ({
  filesRead: 0,
  filesSkipped: 0,
  keysHeld: 0,
  recordsRetained: 0,
  fellBack: false
})

describe('splitRunEventLines', () => {
  it('splits like String#split(/\\r?\\n/) wherever the chunks break', async () => {
    const samples = ['', 'a', 'a\n', 'a\r\nb', 'a\r\r\nb\r', '\n\n', 'x\r\n\r\ny', 'é\r\nü\n']
    for (const text of samples) {
      for (let cut = 0; cut <= text.length; cut += 1) {
        async function* chunks() {
          yield text.slice(0, cut)
          yield text.slice(cut)
        }
        const lines: string[] = []
        for await (const line of splitRunEventLines(chunks())) lines.push(line)
        expect(lines, JSON.stringify([text, cut])).toEqual(text.split(/\r?\n/))
      }
    }
  })
})

describe('queryRunEventFilesAsync', () => {
  // Generous timeout: one test sweeps every seed × filter, and the full suite runs it under load.
  it(
    'returns exactly what the sync reader returns, in the same order, for every filter',
    { timeout: 30_000 },
    async () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const files = syntheticFiles(seed)
        const paths = [...files.keys()]
        for (const filter of FILTERS) {
          const answer = await queryRunEventFilesAsync(paths, filter, {
            reader: memoryReader(files, seed),
            prefilter: prefilterFor(filter)
          })
          expect(answer, JSON.stringify({ seed, filter })).toEqual(
            await replacedAnswer(files, paths, filter, memoryReader(files, seed))
          )
          // Without the newest bound nothing is skipped, so this is the sync answer too.
          if (!(filter.chatId && filter.limit)) {
            expect(answer, JSON.stringify({ seed, filter })).toEqual(
              syncAnswer(files, paths, filter)
            )
          }
        }
      }
    }
  )

  it('reads in full only the events it returns when there is a limit', async () => {
    const files = new Map<string, string>()
    for (let run = 0; run < 20; run += 1) {
      const lines: string[] = []
      for (let sequence = 1; sequence <= 50; sequence += 1) {
        lines.push(
          record({
            runId: `r${run}`,
            sequence,
            workspaceId: 'w',
            kind: 'provider_raw',
            timestamp: new Date(run * 1000 + sequence).toISOString()
          } as never)
        )
      }
      files.set(`/runs/r${run}.jsonl`, `${lines.join('\n')}\n`)
    }
    const paths = [...files.keys()]
    const stats = newStats()
    const answer = await queryRunEventFilesAsync(
      paths,
      { workspaceId: 'w', limit: 7 },
      { reader: memoryReader(files), stats }
    )
    expect(answer).toEqual(syncAnswer(files, paths, { workspaceId: 'w', limit: 7 }))
    expect(stats).toMatchObject({ keysHeld: 1000, recordsRetained: 7, fellBack: false })
  })

  it('keeps no record the filter rejects, with or without a limit', async () => {
    const files = syntheticFiles(7)
    const paths = [...files.keys()]
    const stats = newStats()
    const answer = await queryRunEventFilesAsync(
      paths,
      { workspaceId: 'w2' },
      { reader: memoryReader(files), stats }
    )
    expect(stats.recordsRetained).toBe(answer.length)
    expect(answer.every((event) => event.workspaceId === 'w2')).toBe(true)
  })

  it('falls back to one full read, and the current answer, when a file is rewritten between passes', async () => {
    const files = syntheticFiles(11)
    const paths = [...files.keys()]
    const filter = { limit: 3 }
    const reader = memoryReader(files)
    const rewriting: RunEventQueryReader = {
      newestTimestampMs: (filePath) => reader.newestTimestampMs(filePath),
      lines(filePath) {
        // The first pass has read every file once; shift every line down one before the second.
        if (reader.opened.length === paths.length) {
          for (const [name, text] of files) files.set(name, `garbage\n${text}`)
        }
        return reader.lines(filePath)
      }
    }
    const stats = newStats()
    const answer = await queryRunEventFilesAsync(paths, filter, { reader: rewriting, stats })
    expect(stats.fellBack).toBe(true)
    expect(answer.length).toBe(3)
    expect(answer).toEqual(syncAnswer(files, paths, filter))
  })

  it('answers from the first pass when events are only appended between passes', async () => {
    const files = syntheticFiles(13)
    const paths = [...files.keys()]
    const before = new Map(files)
    const reader = memoryReader(files)
    const appending: RunEventQueryReader = {
      newestTimestampMs: (filePath) => reader.newestTimestampMs(filePath),
      lines(filePath) {
        if (reader.opened.length === paths.length) {
          const last = paths[paths.length - 1]
          files.set(
            last,
            `${files.get(last)}\n${record({ runId: 'late', sequence: 1, timestamp: new Date(9e12).toISOString() } as never)}\n`
          )
        }
        return reader.lines(filePath)
      }
    }
    const stats = newStats()
    const answer = await queryRunEventFilesAsync(paths, { limit: 4 }, { reader: appending, stats })
    expect(stats.fellBack).toBe(false)
    expect(answer).toEqual(syncAnswer(before, paths, { limit: 4 }))
  })

  it('skips a chat run file that cannot rank in the newest limit, and only for a chat query', async () => {
    const event = (runId: string, ms: number, sequence: number) =>
      record({
        runId,
        sequence,
        chatId: 'c',
        kind: 'provider_raw',
        timestamp: new Date(ms).toISOString()
      } as never)
    const files = new Map([
      [
        '/runs/new.jsonl',
        [event('new', 2000, 1), event('new', 2001, 2), event('new', 2002, 3)].join('\n')
      ],
      ['/runs/old.jsonl', [event('old', 1000, 1), event('old', 1001, 2)].join('\n')]
    ])
    const paths = [...files.keys()]
    for (const [filter, skipped] of [
      [{ chatId: 'c', limit: 3 }, 1],
      [{ chatId: 'c', limit: 4 }, 0],
      [{ limit: 3 }, 0]
    ] as const) {
      const reader = memoryReader(files)
      const stats = newStats()
      const answer = await queryRunEventFilesAsync(paths, filter, { reader, stats })
      expect(stats.filesSkipped, JSON.stringify(filter)).toBe(skipped)
      expect(answer).toEqual(syncAnswer(files, paths, filter))
    }
  })

  it('drops every event of a file that fails mid-read, and keeps the other files', async () => {
    const files = syntheticFiles(17)
    const paths = [...files.keys()]
    const broken = paths[0]
    const reader = memoryReader(files)
    const failing: RunEventQueryReader = {
      newestTimestampMs: (filePath) => reader.newestTimestampMs(filePath),
      lines(filePath) {
        if (filePath !== broken) return reader.lines(filePath)
        const inner = reader.lines(filePath)
        return (async function* () {
          let count = 0
          for await (const line of inner) {
            yield line
            if (++count === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' })
          }
        })()
      }
    }
    const errors: string[] = []
    for (const filter of [{}, { limit: 5 }]) {
      const answer = await queryRunEventFilesAsync(paths, filter, {
        reader: failing,
        onReadError: (filePath) => errors.push(filePath)
      })
      expect(answer).toEqual(syncAnswer(files, paths.slice(1), filter))
    }
    expect(errors.every((filePath) => filePath === broken)).toBe(true)
  })

  it('treats a missing file as empty, without reporting it', async () => {
    const files = syntheticFiles(19)
    const paths = [...files.keys(), '/runs/missing.jsonl']
    const errors: string[] = []
    const answer = await queryRunEventFilesAsync(
      paths,
      { limit: 3 },
      {
        reader: memoryReader(files),
        onReadError: (filePath) => errors.push(filePath)
      }
    )
    expect(answer).toEqual(syncAnswer(files, paths, { limit: 3 }))
    expect(errors).toEqual([])
  })
})

describe('nodeRunEventQueryReader', () => {
  const made: string[] = []
  afterEach(() => {
    for (const directory of made.splice(0)) {
      if (dirname(directory) !== tmpdir()) throw new Error(`Refusing to remove ${directory}`)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('answers the same query from real files as from memory', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'run-event-query-'))
    made.push(directory)
    const files = syntheticFiles(23)
    const memory = new Map<string, string>()
    for (const [name, text] of files) {
      const filePath = join(directory, name.split('/').pop()!)
      fs.writeFileSync(filePath, text)
      memory.set(filePath, text)
    }
    const paths = [...memory.keys()]
    for (const filter of FILTERS) {
      expect(
        await queryRunEventFilesAsync(paths, filter, { reader: nodeRunEventQueryReader }),
        JSON.stringify(filter)
      ).toEqual(await replacedAnswer(memory, paths, filter, nodeRunEventQueryReader))
    }
  })
})
