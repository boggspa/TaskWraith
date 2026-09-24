import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * WHY THIS EXISTS
 *
 * Doctrine only binds an agent that is actually shown it, and each tool
 * discovers a different filename. `AGENTS.md` is Codex's convention; Claude
 * reads `CLAUDE.md`. On 2026-08-06 there was no `CLAUDE.md` in this repo and
 * nothing in `src/` injected the repository doctrine, so every Claude-family
 * session — app, CLI, and TaskWraith's own Claude seats — started with no
 * project doctrine at all and could not know the work-marker protocol existed.
 * Agents were completing whole tasks in the shared tree without ever raising a
 * claim. That was never a compliance failure; the instructions had no delivery
 * route.
 *
 * A missing file is invisible, which is exactly how it went unnoticed. This
 * pins the delivery route itself, not the prose: `CLAUDE.md` must exist,
 * `AGENTS.md` must stay inside the native Codex project-doc ceiling, and the
 * core router must still carry the handful of rules that make a shared checkout
 * safe. Reword freely — but if a rule or routed document disappears, that is
 * the regression.
 */

const repoRoot = join(__dirname, '..')
const claudeMd = join(repoRoot, 'CLAUDE.md')
const agentsMd = join(repoRoot, 'AGENTS.md')
const routedDoctrine = [
  {
    relativePath: 'docs/agent-doctrine/REPOSITORY_WORKFLOW.md',
    headings: [
      '## Formatting policy for agents',
      '## Concurrent work in this repo',
      '## Composition-root growth policy'
    ]
  },
  {
    relativePath: 'docs/agent-doctrine/CAPABILITY_GOVERNANCE.md',
    headings: ['## Capability governance — the user decides (non-negotiable)']
  },
  {
    relativePath: 'docs/agent-doctrine/DELEGATION_AND_ENSEMBLE.md',
    headings: [
      '## Sub-Threads (Phase F1) — isolated delegation',
      '## Ensemble mode (1.7.0) — multi-provider in a single thread'
    ]
  },
  {
    relativePath: 'docs/agent-doctrine/RUNTIME_AND_TOOLS.md',
    headings: [
      '## Environment summary',
      '## Approval flow',
      '## Prompt caching, forks, and worktrees (agents)',
      '## MCP',
      "## What an agent should know but can't directly see"
    ]
  },
  {
    relativePath: 'docs/agent-doctrine/INTROSPECTION_AND_RELEASE_STATE.md',
    headings: ['## Thread Introspection (memory promotion)', '## Versioning']
  }
] as const

function claudeMdText(): string {
  return readFileSync(claudeMd, 'utf8')
}

function agentsMdText(): string {
  return readFileSync(agentsMd, 'utf8')
}

describe('agent doctrine core and router', () => {
  it('stays inside the native Codex project-document byte ceiling', () => {
    expect(Buffer.byteLength(agentsMdText(), 'utf8')).toBeLessThanOrEqual(32 * 1024)
  })

  it('routes every detailed doctrine document and keeps each target present', () => {
    const core = agentsMdText()
    for (const { relativePath, headings } of routedDoctrine) {
      expect(core).toContain(relativePath)
      const target = join(repoRoot, relativePath)
      expect(existsSync(target)).toBe(true)
      const detail = readFileSync(target, 'utf8')
      for (const heading of headings) expect(detail).toContain(heading)
    }
  })

  it('keeps the immediate shared-checkout and capability-governance stops in core', () => {
    const core = agentsMdText()
    expect(core).toContain('git status --porcelain')
    expect(core).toMatch(/before the first edit/i)
    expect(core).toMatch(/never use `git stash`/i)
    expect(core).toContain('The live-provider set is a product decision, not an engineering lever.')
    expect(core).toContain(
      'Do not land code, config, CI, or doctrine that narrows user-facing capability without the user approving that exact narrowing in the current session.'
    )
  })
})

describe('agent doctrine reaches Claude sessions', () => {
  it('keeps CLAUDE.md present at the repo root', () => {
    expect(existsSync(claudeMd)).toBe(true)
  })

  it('still points at the AGENTS.md core router', () => {
    expect(existsSync(agentsMd)).toBe(true)
    expect(claudeMdText()).toContain('AGENTS.md')
  })

  it('is a small compatibility router rather than a second doctrine copy', () => {
    const text = claudeMdText()
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(2 * 1024)
    expect(text).toMatch(/read it in full before your first tool call or file edit/i)
    expect(text).toMatch(/router, not a second copy/i)
  })

  it('documents bounded host delivery without enabling native settings or hooks', () => {
    const text = claudeMdText()
    expect(text).toMatch(/disable native project settings,[\s\S]*hooks,[\s\S]*skills/i)
    expect(text).toMatch(/bounded root `AGENTS\.md`/i)
    expect(text).toMatch(/cannot grant tools, widen permissions, or change approval[\s\S]*posture/i)
  })
})
