import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ChatRun } from '../../../main/store/types'
import { isOpenChatRun, selectCurrentChatRun } from './activeRunSelection'

function run(runId: string, extra: Partial<ChatRun> = {}): ChatRun {
  return {
    runId,
    startedAt: '2026-09-10T11:00:00.000Z',
    ...extra
  } as ChatRun
}

describe('isOpenChatRun', () => {
  it('treats a run with no endedAt as open', () => {
    expect(isOpenChatRun(run('a'))).toBe(true)
  })

  it('treats a run with an endedAt as closed', () => {
    expect(isOpenChatRun(run('a', { endedAt: '2026-09-10T11:05:00.000Z' }))).toBe(false)
  })

  /**
   * The regression this predicate exists to prevent. `'starting'` is what the
   * desktop dispatch lane seeds and what a Muse turn keeps for its whole life,
   * because Muse hands RunManager no process to promote from. A status-keyed
   * predicate reports "not running" for a live Muse turn.
   */
  it('accepts the undocumented starting status that Muse turns never leave', () => {
    expect(isOpenChatRun(run('a', { status: 'starting' } as Partial<ChatRun>))).toBe(true)
  })

  it('accepts queued and running alike', () => {
    expect(isOpenChatRun(run('a', { status: 'queued' } as Partial<ChatRun>))).toBe(true)
    expect(isOpenChatRun(run('a', { status: 'running' } as Partial<ChatRun>))).toBe(true)
  })

  /**
   * FROM REAL PROFILE DATA. Scanning the dev profile's 365 chats with runs
   * found 12 carrying an unsealed run -- `startedAt` set, `endedAt` absent --
   * and every one of them was status `failed`, a provider that died without
   * sealing. One thread has 42 runs whose 3 unsealed failures sit BEHIND a
   * properly closed tail. If `!endedAt` alone meant "open", that thread would
   * resolve a months-old run: the composer would count from an ancient start
   * and the model badge would name a provider unused there for weeks.
   */
  it('rejects an unsealed run whose status is already terminal', () => {
    const zombie = run('zombie', { status: 'failed' } as Partial<ChatRun>)
    expect(zombie.endedAt).toBeUndefined()
    expect(isOpenChatRun(zombie)).toBe(false)
    for (const status of ['completed', 'cancelled', 'substituted']) {
      expect(isOpenChatRun(run('z', { status } as Partial<ChatRun>))).toBe(false)
    }
  })

  it('treats an unsealed run with no status at all as open', () => {
    // Legacy rows predate the field, and the page producers retain them.
    expect(isOpenChatRun(run('legacy'))).toBe(true)
    expect(isOpenChatRun(run('blank', { status: '' } as Partial<ChatRun>))).toBe(true)
  })

  it('covers the rest of the shared active vocabulary', () => {
    for (const status of ['cancelling', 'steer_promoting', 'active', 'paused']) {
      expect(isOpenChatRun(run('a', { status } as Partial<ChatRun>))).toBe(true)
    }
  })

  it('is false for nullish input rather than throwing', () => {
    expect(isOpenChatRun(null)).toBe(false)
    expect(isOpenChatRun(undefined)).toBe(false)
  })
})

describe('selectCurrentChatRun', () => {
  it('THE BUG: resolves the open run when the canonical array is empty', () => {
    const live = run('live', { status: 'starting' } as Partial<ChatRun>)
    // Exactly the paged-shell shape: `runs: []` on the record, a real window.
    expect(selectCurrentChatRun([], [run('old', { endedAt: 'x' }), live])).toBe(live)
    expect(selectCurrentChatRun([], [run('old', { endedAt: 'x' }), live])?.startedAt).toBe(
      '2026-09-10T11:00:00.000Z'
    )
  })

  it('THE BUG: an empty canonical array used to yield undefined', () => {
    // Pins the defect itself: the old expression was
    // `chat.runs[chat.runs.length - 1]`, which is undefined on [].
    const canonical: ChatRun[] = []
    expect(canonical[canonical.length - 1]).toBeUndefined()
    expect(selectCurrentChatRun(canonical, [run('live')])).toBeDefined()
  })

  it('prefers the open run over a later closed one in the window', () => {
    const live = run('live')
    const closed = run('closed', { endedAt: '2026-09-10T11:09:00.000Z' })
    expect(selectCurrentChatRun([], [live, closed])).toBe(live)
  })

  it('REAL DATA SHAPE: skips unsealed failures behind a closed tail', () => {
    // The 42-run thread: unsealed failures earlier, a properly closed tail.
    const windowRuns = [
      run('zombie1', { status: 'failed' } as Partial<ChatRun>),
      run('zombie2', { status: 'failed' } as Partial<ChatRun>),
      run('tail', { endedAt: '2026-09-10T11:09:00.000Z', status: 'completed' } as Partial<ChatRun>)
    ]
    expect(selectCurrentChatRun([], windowRuns)?.runId).toBe('tail')
  })

  it('falls back to the window tail when every windowed run is closed', () => {
    const first = run('first', { endedAt: '2026-09-10T11:01:00.000Z' })
    const last = run('last', { endedAt: '2026-09-10T11:09:00.000Z' })
    expect(selectCurrentChatRun([], [first, last])).toBe(last)
  })

  /**
   * The safety property that lets this land at the single shared seam feeding
   * ~20 consumers instead of at each of them: for a hydrated record the result
   * is the old tail read, unchanged.
   */
  it('SAFETY: is byte-identical to the old tail read whenever canonical is non-empty', () => {
    const cases: ChatRun[][] = [
      [run('only')],
      [run('a', { endedAt: 'x' }), run('b', { endedAt: 'y' })],
      [run('open'), run('closedLater', { endedAt: 'z' })],
      [run('a'), run('b'), run('c')]
    ]
    for (const canonical of cases) {
      const oldTailRead = canonical[canonical.length - 1]
      // Window deliberately disagrees; canonical must still win outright.
      expect(selectCurrentChatRun(canonical, [run('decoy')])).toBe(oldTailRead)
      // And with no window at all, which is the non-paged reality.
      expect(selectCurrentChatRun(canonical, undefined)).toBe(oldTailRead)
    }
    expect(cases).toHaveLength(4)
  })

  it('SAFETY: never invents a run when neither source has one', () => {
    expect(selectCurrentChatRun([], [])).toBeUndefined()
    expect(selectCurrentChatRun(undefined, undefined)).toBeUndefined()
    expect(selectCurrentChatRun(null, null)).toBeUndefined()
  })

  it('tolerates non-array inputs from an untyped projection', () => {
    expect(selectCurrentChatRun('nope' as unknown as ChatRun[], [run('live')])?.runId).toBe('live')
    expect(selectCurrentChatRun([], 'nope' as unknown as ChatRun[])).toBeUndefined()
  })
})

/**
 * Source guard. The renderer has no jsdom (~251 suites are
 * `renderToStaticMarkup`), so nothing here can mount App and observe the wiring
 * behaviourally. Pin the seam by source instead, the way
 * `styles/scheduledCountdownIsolation.test.ts` and
 * `hooks/useSharedNowTick.test.ts` do.
 */
describe('App wires the live surfaces through this seam', () => {
  const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf-8').replace(
    /\r\n/g,
    '\n'
  )

  it('resolves currentRun through selectCurrentChatRun, not a bare tail read', () => {
    expect(app).toContain(
      'const currentRun = selectCurrentChatRun(currentChat?.runs, currentChatTranscript.runs)'
    )
  })

  it('has no bare tail read of currentChat.runs left anywhere', () => {
    // The exact defect expression. It is what made every paged thread paint
    // 00:00:00:00 underneath a live "Working" chip.
    expect(app).not.toContain('currentChat?.runs?.[currentChat.runs.length - 1]')
    expect(app).not.toContain('currentChat.runs[currentChat.runs.length - 1]')
  })

  it('resolves the side-pane run through the seam, not a bare tail read', () => {
    expect(app).toContain('const sideRun = selectCurrentChatRun(')
    expect(app).not.toContain('sideChat?.runs?.[sideChat.runs.length - 1]')
  })

  it('resolves both multiview pane runs through the seam', () => {
    // The pane sites were never converted with the focused composer, so a
    // paged or summaryOnly pane painted 00:00:00:00 under a live "Working"
    // chip while the focused composer ticked correctly beside it.
    expect(app).not.toContain('viewerChat.runs?.[viewerChat.runs.length - 1]')
    // Positive half, so the negative above cannot pass by the sites vanishing:
    // the pane shell and the pane composer ctx each resolve one.
    expect(app.split('const viewerRun =').length - 1).toBe(2)
    expect(
      app.split('resolveCurrentChatTranscriptWindow(viewerChat, null).runs').length - 1
    ).toBe(2)
  })

  it('imports the helper', () => {
    expect(app).toMatch(/selectCurrentChatRun[^\n]*from '\.\/lib\/activeRunSelection'/)
  })

  it('is anchored to a file that exists and is non-trivial', () => {
    expect(app.length).toBeGreaterThan(100_000)
  })
})
