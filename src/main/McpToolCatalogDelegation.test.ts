import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_WAVE_AGENTS } from '../shared/fleetWave'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'
import {
  ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS,
  ULTRA_TASK_MAX_EFFECTIVE_WORKERS
} from './ultraTask/UltraTaskToolRequest'

describe('delegate_to_subthread MCP schema', () => {
  it('advertises fresh-seat model controls and marks them spawn-only', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'delegate_to_subthread'
    )
    const schema = definition?.inputSchema as
      | { properties?: Record<string, { description?: string; enum?: string[] }> }
      | undefined
    const properties = schema?.properties

    expect(properties?.model?.description).toMatch(/spawn-only/i)
    expect(properties?.model?.description).toMatch(/omit.*recall/i)
    expect(properties?.reasoningEffort?.enum).toEqual(
      expect.arrayContaining([
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultracode'
      ])
    )
    // Path-B Cursor is a live selectable seat; parents may spawn/recall a Cursor
    // child, and a broker-active Cursor parent can use this same governed tool.
    expect(properties?.provider?.enum).toContain('cursor')
    expect(properties?.reasoningEffort?.description).toMatch(/provider\/model.*Off/i)
    expect(properties?.kimiThinking?.description).toMatch(/kimi/i)
    expect(properties?.subThreadId?.description).toMatch(/inherits.*model.*controls/i)
    expect(properties?.subThreadId?.description).toMatch(/active child.*durably queued/i)
    expect(properties?.subThreadId?.description).not.toMatch(/unarchived and idle/i)
    expect(properties?.returnResult?.description).toMatch(/typed terminal result/i)
    expect(definition?.description).toMatch(/subject to current runtime admission/i)
    expect(definition?.description).toMatch(/done\/requires_action\/failed\/cancelled/i)
  })

  it('documents cancellation of queued recalls as well as a live child run', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'cancel_subthread'
    )

    expect(definition?.description).toMatch(/queued recalled follow-ups/i)
    expect(definition?.description).toMatch(/active run/i)
  })
})

describe('delegate_wave roster sizing is discoverable', () => {
  // Agents were sizing every fleet at 8 and splitting bigger jobs into two
  // waves. That was not superstition: they read `maxItems: 64`, asked for a
  // large roster, and the runtime refused with "at most 8" — so 8 is what they
  // learned. Nothing in the advertised schema ever named the real number, and
  // the one place it was named was a refusal they had to earn by failing.
  const waveDefinition = () =>
    createTaskWraithMcpToolDefinitions().find((tool) => tool.name === 'delegate_wave')

  it('names the default roster size in the tool description', () => {
    expect(waveDefinition()?.description).toMatch(
      new RegExp(`default(?:s to)? ${DEFAULT_MAX_WAVE_AGENTS}\\b`, 'i')
    )
  })

  it('says an over-cap roster is refused, not silently trimmed', () => {
    // The distinction is load-bearing for planning: a caller that believes the
    // tail is dropped will pad the roster; one that knows the call fails will
    // size it correctly the first time.
    expect(waveDefinition()?.description).toMatch(/refus/i)
  })

  it('marks maxItems as the structural ceiling, not the live cap', () => {
    const schema = waveDefinition()?.inputSchema as
      | { properties?: Record<string, { description?: string; maxItems?: number }> }
      | undefined
    const workers = schema?.properties?.workers

    // 64 stays — it IS the structural ceiling, and a schema that moved with a
    // user setting would make the same call valid or invalid depending on a
    // slider the agent cannot see.
    expect(workers?.maxItems).toBe(64)
    expect(workers?.description).toMatch(/ceiling/i)
    expect(workers?.description).toMatch(new RegExp(`${DEFAULT_MAX_WAVE_AGENTS}`))
  })

  it('lets Pi workers request a real Off stop through the advertised schema', () => {
    const schema = waveDefinition()?.inputSchema as
      | {
          properties?: {
            workers?: {
              items?: {
                properties?: Record<string, { enum?: string[]; description?: string }>
              }
            }
          }
        }
      | undefined
    const reasoning = schema?.properties?.workers?.items?.properties?.reasoningEffort

    expect(reasoning?.enum).toEqual(expect.arrayContaining(['off', 'minimal', 'high', 'max']))
    expect(reasoning?.description).toMatch(/Off.*provider\/model/i)
  })

  it('advertises concise lane roles while retaining the historical aliases', () => {
    const schema = waveDefinition()?.inputSchema as
      | {
          properties?: Record<
            string,
            { items?: { properties?: Record<string, { enum?: string[]; description?: string }> } }
          >
        }
      | undefined
    const role = schema?.properties?.workers?.items?.properties?.role

    expect(role?.enum).toEqual(['scout', 'work', 'review', 'worker', 'reviewer'])
    expect(role?.description).toMatch(/lane role/i)
    expect(role?.description).toMatch(/backward-compatible aliases/i)
  })
})

describe('ultra_task MCP schema', () => {
  it('advertises the implemented worker default', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'ultra_task'
    )
    const schema = definition?.inputSchema as
      | {
          properties?: Record<string, { default?: number; description?: string }>
        }
      | undefined
    const maxWorkers = schema?.properties?.maxWorkers

    expect(maxWorkers?.default).toBe(ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS)
    expect(maxWorkers?.description).toMatch(
      new RegExp(`default: ${ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS}`)
    )
    expect(maxWorkers?.description).toMatch(
      new RegExp(`clamped to ${ULTRA_TASK_MAX_EFFECTIVE_WORKERS}`)
    )
    expect(definition?.description).toMatch(/durable staged UltraTask graph/i)
    expect(definition?.description).toMatch(/TaskWraith owns.*all-join/i)
    // Inverted 2026-08-29. This previously asserted the description must NOT
    // mention ensemble_await, encoding a design where the graph was detached
    // and the initiating turn was told it "may finish". That left graphs
    // dispatching provider work with no accountable seat and no path back to
    // the user. ultra_task now follows the same turn-ownership doctrine as
    // delegate_wave and delegate_to_subthread, so the JOIN must be advertised.
    expect(definition?.description).toMatch(/ensemble_await/i)
    expect(definition?.description).toMatch(/keep your turn active/i)
  })

  it('requires concrete model identity and documents the model-list refusal', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'ultra_task'
    )
    const schema = definition?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined

    expect(schema?.properties?.provider?.description).toMatch(/explicit concrete model/i)
    expect(schema?.properties?.provider?.description).toMatch(/never guesses/i)
    expect(schema?.properties?.model?.description).toMatch(/current run.*concrete model/i)
    expect(schema?.properties?.model?.description).toMatch(/cli-default.*refused/i)
    expect(schema?.properties?.model?.description).toMatch(/returns available concrete model ids/i)
  })
})
