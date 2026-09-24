import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeEnsembleMcpToolArguments } from '../../shared/taskWraithMcpCatalog'
import { normalizeMcpToolArguments } from './McpResultHelpers'

// M5 — the DISPATCH-PROJECTION row the unit corpus cannot cover.
//
// McpFirstCallSuccess.test.ts proves the shared normalizer in isolation. That
// is necessary but not sufficient: the reported bug did not live in the
// normalizer at all. `planSummary` was absent from the hand-written ~40-field
// projection in index.ts, so a perfectly normalized argument object still lost
// the field on its way to the handler — the exact layer a unit test passes
// straight through.
//
// This file closes that gap from both ends:
//   1. RUNTIME — replay the real pipeline expression using the real functions.
//   2. SOURCE-TIE — assert index.ts still uses that same expression, and that
//      its projection really reads the field off the normalized args.
//
// HONEST LIMIT: this is not a live end-to-end through the built dispatcher.
// index.ts is a 60k-line Electron composition root and cannot be imported by
// vitest, and the shipped `out/` binary is rebuilt out of band. A rebuilt-binary
// acceptance run is still owed and is tracked separately.

// Set MCP_DISPATCH_CONTRACT_INDEX_SOURCE to a `git show <ref>:src/main/index.ts`
// dump to replay the source-tie rows against a historical commit. This keeps
// the red proof off the working tree, which matters on a shared checkout with
// concurrent writers.
const indexSource = readFileSync(
  process.env.MCP_DISPATCH_CONTRACT_INDEX_SOURCE ?? new URL('../index.ts', import.meta.url),
  'utf8'
)

/** The exact expression index.ts runs before anything reads `args`. */
function dispatchPipeline(toolName: string, rawArgs: unknown): Record<string, unknown> {
  const args = normalizeMcpToolArguments(rawArgs)
  return normalizeMcpToolArguments(normalizeEnsembleMcpToolArguments(toolName, args))
}

const PLAN_TEXT = 'Review the implementation.'
const CONTROL_TOOL_NAMES = ['ensemble_control', 'ensemble_bossman_control'] as const

describe('first-call dispatch projection', () => {
  it('replays the pipeline index.ts actually runs (anti-drift anchor)', () => {
    // If dispatch ever reorders or replaces this expression, every runtime row
    // below stops representing production and MUST be re-derived. Failing here
    // is the signal to do that rather than silently testing a stale pipeline.
    expect(indexSource).toContain('const receivedArgs = normalizeMcpToolArguments(rawArgs)')
    expect(indexSource).toContain(
      'args = normalizeMcpToolArguments(normalizeEnsembleMcpToolArguments(toolName, args))'
    )
  })

  it('delivers planSummary to the projection for every observed call shape', () => {
    const shapes: Array<[string, unknown]> = [
      ['flat', { action: 'set_round_plan', planSummary: PLAN_TEXT }],
      [
        'params envelope',
        { action: 'set_round_plan', params: { action: 'set_round_plan', planSummary: PLAN_TEXT } }
      ],
      // The envelope that does NOT repeat `action` — the latent action-drop.
      ['envelope without action', { action: 'set_round_plan', params: { planSummary: PLAN_TEXT } }],
      ['snake_case', { action: 'set_round_plan', plan_summary: PLAN_TEXT }],
      [
        'JSON-string transport',
        JSON.stringify({ action: 'set_round_plan', params: { planSummary: PLAN_TEXT } })
      ]
    ]

    for (const toolName of CONTROL_TOOL_NAMES) {
      for (const [label, rawArgs] of shapes) {
        const args = dispatchPipeline(toolName, rawArgs)
        expect(args.action, `${toolName} / ${label}: action must survive`).toBe('set_round_plan')
        expect(args.planSummary, `${toolName} / ${label}: planSummary must reach dispatch`).toBe(
          PLAN_TEXT
        )
      }
    }
  })

  it('projects planSummary and its natural aliases out of the normalized args', () => {
    // The kill shot: the error message named `planSummary` while the projection
    // that fed the handler never carried it. Pin all four so a future
    // projection edit cannot silently drop one again.
    for (const field of ['planSummary', 'plan', 'summary', 'steps']) {
      expect(indexSource, `${field} must be projected into bossmanControlForRun`).toContain(
        `${field}: optionalString(args.${field})`
      )
    }
  })

  it('projects from the NORMALIZED args, never from the raw received args', () => {
    // `receivedArgs` exists only so repair templates can echo what the caller
    // really sent. Projecting from it would reinstate the original bug.
    const projectionStart = indexSource.indexOf('planSummary: optionalString(args.planSummary)')
    expect(projectionStart).toBeGreaterThan(-1)
    const projection = indexSource.slice(projectionStart - 2000, projectionStart + 2000)
    expect(projection).not.toContain('optionalString(receivedArgs.')
  })
})
