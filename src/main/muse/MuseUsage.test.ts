import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMuseEnvelope, type MuseEnvelope } from './MuseExecJson'
import {
  MUSE_TOKEN_COUNT_CONFIDENCE_KEY,
  MUSE_USAGE_SOURCE,
  createMuseUsageReducer,
  estimateMuseCostUsd,
  loadMuseModelCatalogRate,
  meterMuseUsage,
  museMeterSnapshotToProviderStats,
  museMeteringAllowed,
  parseMuseModelCatalogRate,
  unavailableMuseMeterSnapshot
} from './MuseUsage'

const temps: string[] = []

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Redacted shapes from wave1-E §1.2 / §1.3 (0c960794 + ed347af0). */
function sessionEnvelope(
  sequence: number,
  runId: string,
  event: Record<string, unknown>,
  envelopeId?: string
): MuseEnvelope {
  const parsed = parseMuseEnvelope({
    schema_version: 1,
    id: envelopeId || `env-${sequence}`,
    stream: { kind: 'session', id: '0c960794-f785-4827-a059-5e7425637cc8' },
    sequence,
    recorded_at: 1786360202716949,
    record_type: 'event',
    durability: 'durable',
    payload_type: 'runtime.session',
    payload_schema_version: 1,
    payload: {
      kind: 'run',
      run_id: runId,
      source_run_record_id: 'src',
      source_run_record_sequence: 18,
      event
    }
  })
  if (!parsed) throw new Error('fixture envelope failed to parse')
  return parsed
}

const SPARK_RATE = {
  inputUsdPerMillion: 1.25,
  outputUsdPerMillion: 4.25,
  cachedUsdPerMillion: 0.15,
  currency: 'USD'
}

describe('museMeteringAllowed / unavailable', () => {
  it('refuses reported metering when session logging is off', () => {
    expect(museMeteringAllowed(false)).toBe(false)
    expect(museMeteringAllowed(true)).toBe(true)

    const { snapshot, stats } = meterMuseUsage({
      museSessionId: 's1',
      logPath: '/tmp/nope.jsonl',
      sessionLogEnabled: false,
      envelopes: [],
      rate: SPARK_RATE
    })
    expect(snapshot.meteringDisabled).toBe(true)
    expect(snapshot.tokenCountConfidence).toBe('unavailable')
    expect(stats[MUSE_TOKEN_COUNT_CONFIDENCE_KEY]).toBe('unavailable')
    expect(unavailableMuseMeterSnapshot('s1').source).toBe(MUSE_USAGE_SOURCE)
  })
})

describe('createMuseUsageReducer', () => {
  const runId = 'c8fd5939-8c69-40df-8504-439e00f258bd'

  it('meters provider/reported goal_usage_attribution and enriches from model_completed', () => {
    const reducer = createMuseUsageReducer({
      museSessionId: '0c960794-f785-4827-a059-5e7425637cc8',
      logPath: '/tmp/parent/session.jsonl'
    })

    reducer.ingestEnvelope(
      sessionEnvelope(33, runId, {
        kind: 'goal_usage_attribution',
        record: {
          schema_version: 1,
          usage_id: 'usage-d0c8de70-717e-411c-b23d-1e649bc8f756',
          usage_family: 'provider',
          quantity: {
            unit: 'tokens',
            reported: true,
            input_tokens: 14467,
            output_tokens: 42,
            cached_tokens: 0,
            reasoning_tokens: 31,
            main_llm_steps: 1
          },
          owner: {
            requester_kind: 'main',
            session_id: '0c960794-f785-4827-a059-5e7425637cc8',
            run_id: runId,
            owner_id: 'main-root',
            owner_type: 'main_root'
          },
          goal_attribution: { mode: 'none' }
        }
      })
    )
    reducer.ingestEnvelope(
      sessionEnvelope(
        34,
        runId,
        {
          kind: 'model_completed',
          usage: {
            input_tokens: 14467,
            output_tokens: 42,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            reasoning_tokens: 31
          },
          duration_ms: 1745,
          model: 'muse-spark-1.2'
        },
        '0dc365ab-33c8-41b1-bd34-56aa22068aa7'
      )
    )

    const snap = reducer.snapshot(SPARK_RATE)
    expect(snap.inputTokens).toBe(14467)
    expect(snap.outputTokens).toBe(42)
    expect(snap.totalTokens).toBe(14467 + 42)
    expect(snap.reasoningTokens).toBe(31)
    // reasoning must NOT be folded into total
    expect(snap.totalTokens).not.toBe(14467 + 42 + 31)
    expect(snap.model).toBe('muse-spark-1.2')
    expect(snap.durationMs).toBe(1745)
    expect(snap.tokenCountConfidence).toBe('reported')
    expect(snap.usageIds).toEqual(['usage-d0c8de70-717e-411c-b23d-1e649bc8f756'])

    const stats = museMeterSnapshotToProviderStats(snap)
    expect(stats.input_tokens).toBe(14467)
    expect(stats.model).toBe('muse-spark-1.2')
    expect(stats._taskwraith_usage_source).toBe(MUSE_USAGE_SOURCE)
  })

  it('ignores tool / reported:false rows', () => {
    const reducer = createMuseUsageReducer({
      museSessionId: 's',
      logPath: '/tmp/a.jsonl'
    })
    reducer.ingestEnvelope(
      sessionEnvelope(1, 'r1', {
        kind: 'goal_usage_attribution',
        record: {
          usage_id: 'usage-tool',
          usage_family: 'tool',
          quantity: {
            unit: 'tokens',
            reported: false,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            reasoning_tokens: 0,
            main_llm_steps: 0
          }
        }
      })
    )
    const snap = reducer.snapshot(SPARK_RATE)
    expect(snap.inputTokens).toBe(0)
    expect(snap.tokenCountConfidence).toBe('unavailable')
  })

  it('dedupes the same envelope id and path-scoped usage_id', () => {
    const reducer = createMuseUsageReducer({
      museSessionId: 's',
      logPath: '/tmp/parent.jsonl'
    })
    const event = {
      kind: 'goal_usage_attribution',
      record: {
        usage_id: 'usage-dup',
        usage_family: 'provider',
        quantity: {
          unit: 'tokens',
          reported: true,
          input_tokens: 100,
          output_tokens: 5,
          cached_tokens: 0,
          reasoning_tokens: 0,
          main_llm_steps: 1
        }
      }
    }
    const env = sessionEnvelope(1, 'r1', event, 'same-envelope-id')
    reducer.ingestEnvelope(env)
    reducer.ingestEnvelope(env)
    // Different envelope id, same usage_id + path → still once
    reducer.ingestEnvelope(sessionEnvelope(2, 'r1', event, 'other-envelope-id'))
    expect(reducer.snapshot().inputTokens).toBe(100)
  })

  it('does not double-count tokens when model_completed repeats quantities', () => {
    const reducer = createMuseUsageReducer({
      museSessionId: 's',
      logPath: '/tmp/p.jsonl'
    })
    reducer.ingestEnvelope(
      sessionEnvelope(1, 'r1', {
        kind: 'goal_usage_attribution',
        record: {
          usage_id: 'u1',
          usage_family: 'provider',
          quantity: {
            unit: 'tokens',
            reported: true,
            input_tokens: 16009,
            output_tokens: 130,
            cached_tokens: 0,
            reasoning_tokens: 102,
            main_llm_steps: 1
          }
        }
      })
    )
    reducer.ingestEnvelope(
      sessionEnvelope(2, 'r1', {
        kind: 'model_completed',
        usage: {
          input_tokens: 16009,
          output_tokens: 130,
          cached_tokens: 0,
          cache_write_tokens: 10,
          cache_read_tokens: 50,
          reasoning_tokens: 102
        },
        duration_ms: 2875,
        model: 'muse-spark-1.2'
      })
    )
    const snap = reducer.snapshot(SPARK_RATE)
    expect(snap.inputTokens).toBe(16009)
    expect(snap.outputTokens).toBe(130)
    expect(snap.cacheReadInputTokens).toBe(50)
    expect(snap.cacheCreationInputTokens).toBe(10)
    expect(snap.durationMs).toBe(2875)
  })
})

describe('estimateMuseCostUsd / catalog', () => {
  it('prices 16009/130 at spark catalog rates ≈ $0.0206', () => {
    const usd = estimateMuseCostUsd({
      inputTokens: 16009,
      outputTokens: 130,
      rate: SPARK_RATE
    })
    expect(usd).not.toBeNull()
    expect(usd!).toBeCloseTo(16009 / 1e6 * 1.25 + 130 / 1e6 * 4.25, 5)
    expect(usd!).toBeCloseTo(0.0206, 3)
  })

  it('parses catalog cost rows and loads them from disk', async () => {
    expect(
      parseMuseModelCatalogRate({
        input: '1.25',
        output: '4.25',
        cached: '0.15',
        currency: 'USD'
      })
    ).toEqual(SPARK_RATE)
    expect(parseMuseModelCatalogRate({ input: 'x' })).toBeNull()

    const dataHome = mkdtempSync(join(tmpdir(), 'muse-catalog-'))
    temps.push(dataHome)
    const catalogDir = join(dataHome, 'muse', 'model-catalog')
    mkdirSync(catalogDir, { recursive: true })
    writeFileSync(
      join(catalogDir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        provider_id: 'meta',
        rows: [
          {
            model_id: 'muse-spark-1.2',
            cost: { input: '1.25', output: '4.25', cached: '0.15', currency: 'USD' }
          }
        ]
      })
    )
    const rate = await loadMuseModelCatalogRate(dataHome, 'muse-spark-1.2')
    expect(rate).toEqual(SPARK_RATE)
    expect(await loadMuseModelCatalogRate(dataHome, 'missing-model')).toBeNull()
  })
})
