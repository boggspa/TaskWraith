import { describe, expect, it } from 'vitest'
import {
  gitWorkflowObserverKey,
  isPushedCleanSnapshot,
  observeChatGitWorkflow,
  type GitWorkflowObserverMemory
} from './chatGitWorkflowObserver'

const CHAT = 'chat-1'
const WS = '/repo'
const CLEAN = {
  remoteUrl: 'git@github.com:o/r.git',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0
}
const AHEAD = { ...CLEAN, ahead: 2 }

function observe(
  memory: GitWorkflowObserverMemory,
  overrides: Partial<Parameters<typeof observeChatGitWorkflow>[0]> = {}
) {
  return observeChatGitWorkflow({
    memory,
    chatId: CHAT,
    workspaceKey: WS,
    pr: null,
    ciStatus: null,
    snapshot: CLEAN,
    persisted: undefined,
    ...overrides
  })
}

describe('isPushedCleanSnapshot', () => {
  it('mirrors the satellite Pushed condition', () => {
    expect(isPushedCleanSnapshot(CLEAN)).toBe(true)
    expect(isPushedCleanSnapshot(AHEAD)).toBe(false)
    expect(isPushedCleanSnapshot({ ...CLEAN, upstream: null })).toBe(false)
    expect(isPushedCleanSnapshot({ ...CLEAN, detached: true })).toBe(false)
    expect(isPushedCleanSnapshot({ ...CLEAN, remoteUrl: null })).toBe(false)
    expect(isPushedCleanSnapshot(null)).toBe(false)
  })
})

describe('observeChatGitWorkflow — tagging contract', () => {
  it('never tags on the first settled observation (opening an old chat in a PR workspace)', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    expect(
      observe(memory, { pr: { number: 5, state: 'OPEN', url: 'https://github.com/o/r/pull/5' } })
    ).toBeNull()
    expect(memory.get(gitWorkflowObserverKey(CHAT, WS))).toBe('open')
  })

  it('tags on a witnessed transition (PR appears while focused)', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    observe(memory, { snapshot: AHEAD }) // seed: no signal
    const recorded = observe(memory, {
      pr: { number: 5, state: 'OPEN', url: 'https://github.com/o/r/pull/5' },
      snapshot: AHEAD
    })
    expect(recorded).toEqual({ state: 'open', prNumber: 5, prUrl: 'https://github.com/o/r/pull/5' })
  })

  it('tags a push completing while focused (ahead > 0 → clean)', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    observe(memory, { snapshot: AHEAD }) // seed observes null
    expect(observe(memory, { snapshot: CLEAN })).toEqual({ state: 'pushed' })
  })

  it('stays quiet on a steady state and never auto-clears', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    observe(memory) // seed 'pushed'
    expect(observe(memory)).toBeNull() // steady
    // Signal disappears entirely (work in progress): observed null → no clear.
    expect(observe(memory, { snapshot: AHEAD })).toBeNull()
  })

  it('refreshes an already-tagged chat on the FIRST settled observation that differs', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    const recorded = observe(memory, {
      pr: { number: 5, state: 'MERGED', url: 'https://github.com/o/r/pull/5' },
      persisted: { state: 'open', prNumber: 5 }
    })
    expect(recorded).toEqual({
      state: 'merged',
      prNumber: 5,
      prUrl: 'https://github.com/o/r/pull/5'
    })
  })

  it('does not rewrite an already-tagged chat when nothing material changed', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    expect(
      observe(memory, {
        pr: { number: 5, state: 'OPEN', url: 'https://github.com/o/r/pull/5' },
        persisted: { state: 'open', prNumber: 5, prUrl: 'https://github.com/o/r/pull/5' }
      })
    ).toBeNull()
  })

  it('keys memory per chat+workspace so another chat still needs its own transition', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    observe(memory, { snapshot: AHEAD })
    expect(observe(memory, { snapshot: CLEAN })).toEqual({ state: 'pushed' })
    // A different chat's first settled look at the same workspace: seed only.
    expect(observe(memory, { chatId: 'chat-2', snapshot: CLEAN })).toBeNull()
  })

  it('tracks CI failure as a transition on an open PR', () => {
    const memory: GitWorkflowObserverMemory = new Map()
    const pr = { number: 5, state: 'OPEN', url: 'https://github.com/o/r/pull/5' }
    observe(memory, { pr }) // seed 'open'
    expect(observe(memory, { pr, ciStatus: 'failed' })).toEqual({
      state: 'failed',
      prNumber: 5,
      prUrl: 'https://github.com/o/r/pull/5'
    })
  })
})
