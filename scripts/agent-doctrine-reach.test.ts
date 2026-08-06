import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * WHY THIS EXISTS
 *
 * Doctrine only binds an agent that is actually shown it, and each tool
 * discovers a different filename. `AGENTS.md` is Codex's convention; Claude
 * reads `CLAUDE.md`. On 2026-08-06 there was no `CLAUDE.md` in this repo and
 * nothing in `src/` injected `AGENTS.md`, so every Claude-family session —
 * app, CLI, and TaskWraith's own Claude seats — started with no project
 * doctrine at all and could not know the work-marker protocol existed. Agents
 * were completing whole tasks in the shared tree without ever raising a claim.
 * That was never a compliance failure; the instructions had no delivery route.
 *
 * A missing file is invisible, which is exactly how it went unnoticed. This
 * pins the delivery route itself, not the prose: `CLAUDE.md` must exist and
 * must still carry the handful of rules that make a shared checkout safe.
 * Reword freely — but if a rule disappears, that is the regression.
 */

const repoRoot = join(__dirname, '..')
const claudeMd = join(repoRoot, 'CLAUDE.md')

function claudeMdText(): string {
  return readFileSync(claudeMd, 'utf8')
}

describe('agent doctrine reaches Claude sessions', () => {
  it('keeps CLAUDE.md present at the repo root', () => {
    expect(existsSync(claudeMd)).toBe(true)
  })

  it('still points at AGENTS.md for the full doctrine', () => {
    expect(existsSync(join(repoRoot, 'AGENTS.md'))).toBe(true)
    expect(claudeMdText()).toContain('AGENTS.md')
  })

  it('teaches the work-marker protocol', () => {
    const text = claudeMdText()
    expect(text).toContain('.WORK-IN-PROGRESS-')
    // The trigger has to stay unambiguous: "when you start" is skippable.
    expect(text).toMatch(/before your first edit/i)
    expect(text).toMatch(/\bpid\b/)
    expect(text).toMatch(/\bexpires\b/)
  })

  it('warns that the --- frontmatter delimiters are load-bearing', () => {
    // Two live markers were inert on 2026-08-06 purely for want of these, and
    // the failure is silent: the marker looks right and claims nothing.
    expect(claudeMdText()).toMatch(/---[\s\S]*parses? empty/i)
  })

  it('tells a seat to read its owner id rather than invent one', () => {
    // Observed 2026-08-06: two live markers carried a hand-written
    // `lockOwnerId:` — a seat's own display name. That matches nothing at the
    // hook, yet `work-guard` still counts the field as a held lease, so one
    // claim reads live to one tool and unauthenticated to the other. Seats
    // reach for a stand-in when the doctrine names the variable but never says
    // the value is opaque and not theirs to compose.
    const text = claudeMdText()
    expect(text).toContain('TASKWRAITH_LOCK_OWNER_ID')
    expect(text).toMatch(/never invent one/i)
  })

  it('carries the commit rules that keep a shared index safe', () => {
    const text = claudeMdText()
    expect(text).toMatch(/git add -A/)
    expect(text).toMatch(/pathspec/i)
    expect(text).toMatch(/git diff --cached/)
  })

  it('carries the never-do rules', () => {
    const text = claudeMdText()
    // `git stash` is repo-wide destruction here: it pockets every other
    // session's uncommitted work and `pop` can refuse to return it.
    expect(text).toMatch(/never .*git stash/i)
    expect(text).toMatch(/never .*git push/i)
  })
})
