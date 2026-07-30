import { describe, expect, it } from 'vitest'
import {
  diffWorkspaceChurn,
  formatWorkspaceChurnStanza,
  parseNumstatByPath,
  type WorkspaceChurnSample
} from './WorkspaceChurn'

function sample(
  tracked: Record<string, { additions: number; deletions: number; binary?: boolean }>,
  untracked: Record<string, { additions: number; deletions: number; binary?: boolean }> = {}
): WorkspaceChurnSample {
  return { tracked, untracked }
}

describe('parseNumstatByPath', () => {
  it('parses plain numstat records', () => {
    expect(parseNumstatByPath('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n')).toEqual({
      'src/a.ts': { additions: 12, deletions: 3 },
      'src/b.ts': { additions: 0, deletions: 7 }
    })
  })

  it('attributes a rename to the NEW path', () => {
    // `add del old new` — content lives at the new path now.
    expect(parseNumstatByPath('4\t2\tsrc/old.ts\tsrc/new.ts\n')).toEqual({
      'src/new.ts': { additions: 4, deletions: 2 }
    })
  })

  it('marks binary files instead of inventing line counts', () => {
    expect(parseNumstatByPath('-\t-\tassets/icon.png\n')).toEqual({
      'assets/icon.png': { additions: 0, deletions: 0, binary: true }
    })
  })

  it('ignores blank, short, and non-numeric records rather than throwing', () => {
    expect(parseNumstatByPath('\n\nnot-a-record\nx\ty\tsrc/c.ts\n5\t1\tsrc/d.ts\n')).toEqual({
      'src/d.ts': { additions: 5, deletions: 1 }
    })
  })

  it('tolerates CRLF output', () => {
    expect(parseNumstatByPath('3\t1\tsrc/a.ts\r\n')).toEqual({
      'src/a.ts': { additions: 3, deletions: 1 }
    })
  })

  it('returns an empty map for empty input', () => {
    expect(parseNumstatByPath('')).toEqual({})
  })
})

describe('diffWorkspaceChurn', () => {
  it('reports only churn added SINCE the baseline on an already-dirty file', () => {
    // The regression that motivated this module: status-code comparison sees
    // "modified" both before and after and reports nothing.
    const delta = diffWorkspaceChurn(
      sample({ 'src/a.ts': { additions: 100, deletions: 20 } }),
      sample({ 'src/a.ts': { additions: 142, deletions: 27 } })
    )
    expect(delta.entries).toEqual([
      { path: 'src/a.ts', additions: 42, deletions: 7, kind: 'changed' }
    ])
    expect(delta.decreasedPaths).toEqual([])
  })

  it('classifies a file that was clean at baseline as appeared', () => {
    const delta = diffWorkspaceChurn(
      sample({}),
      sample({ 'src/new.ts': { additions: 9, deletions: 0 } })
    )
    expect(delta.entries).toEqual([
      { path: 'src/new.ts', additions: 9, deletions: 0, kind: 'appeared' }
    ])
  })

  it('emits nothing when the tree has not moved', () => {
    const identical = { 'src/a.ts': { additions: 5, deletions: 5 } }
    const delta = diffWorkspaceChurn(sample(identical), sample({ ...identical }))
    expect(delta.entries).toEqual([])
    expect(delta.decreasedPaths).toEqual([])
  })

  it('flags churn that shrank, including all the way to clean', () => {
    const delta = diffWorkspaceChurn(
      sample({
        'src/shrunk.ts': { additions: 40, deletions: 10 },
        'src/reverted.ts': { additions: 8, deletions: 1 }
      }),
      sample({ 'src/shrunk.ts': { additions: 5, deletions: 2 } })
    )
    expect(delta.entries).toEqual([])
    // `reverted.ts` vanished from the sample entirely — a decrease to zero.
    expect(delta.decreasedPaths).toEqual(['src/reverted.ts', 'src/shrunk.ts'])
  })

  it('reports a newly untracked file with its line count', () => {
    const delta = diffWorkspaceChurn(
      sample({}, { 'already-there.md': { additions: 3, deletions: 0 } }),
      sample(
        {},
        {
          'already-there.md': { additions: 3, deletions: 0 },
          'brand-new.md': { additions: 40, deletions: 0 }
        }
      )
    )
    expect(delta.entries).toEqual([
      { path: 'brand-new.md', additions: 40, deletions: 0, kind: 'untracked' }
    ])
  })

  it('keeps seeing an untracked file GROW after its first appearance', () => {
    // The live-probe regression: name-only untracked entries meant a seat could
    // keep adding to a new module across turns and the panel saw nothing.
    const delta = diffWorkspaceChurn(
      sample({}, { 'src/new-module.ts': { additions: 40, deletions: 0 } }),
      sample({}, { 'src/new-module.ts': { additions: 440, deletions: 0 } })
    )
    expect(delta.entries).toEqual([
      { path: 'src/new-module.ts', additions: 400, deletions: 0, kind: 'changed' }
    ])
  })

  it('does not double-report a file that was git added mid-round', () => {
    // It moves from the untracked map to the tracked one; only the growth since
    // baseline is new information.
    const delta = diffWorkspaceChurn(
      sample({}, { 'src/added.ts': { additions: 40, deletions: 0 } }),
      sample({ 'src/added.ts': { additions: 45, deletions: 0 } })
    )
    expect(delta.entries).toEqual([
      { path: 'src/added.ts', additions: 5, deletions: 0, kind: 'changed' }
    ])
  })

  it('treats a deleted untracked file as a decrease, not silence', () => {
    const delta = diffWorkspaceChurn(
      sample({}, { 'scratch.md': { additions: 12, deletions: 0 } }),
      sample({})
    )
    expect(delta.entries).toEqual([])
    expect(delta.decreasedPaths).toEqual(['scratch.md'])
  })

  it('reports a binary file only when it was clean at baseline', () => {
    const already = diffWorkspaceChurn(
      sample({ 'a.png': { additions: 0, deletions: 0, binary: true } }),
      sample({ 'a.png': { additions: 0, deletions: 0, binary: true } })
    )
    expect(already.entries).toEqual([])

    const fresh = diffWorkspaceChurn(
      sample({}),
      sample({ 'a.png': { additions: 0, deletions: 0, binary: true } })
    )
    expect(fresh.entries).toEqual([{ path: 'a.png', additions: 0, deletions: 0, kind: 'binary' }])
  })

  it('orders entries by descending churn, then by path', () => {
    const delta = diffWorkspaceChurn(
      sample({}),
      sample({
        'small.ts': { additions: 1, deletions: 0 },
        'big.ts': { additions: 50, deletions: 50 },
        'mid-b.ts': { additions: 5, deletions: 0 },
        'mid-a.ts': { additions: 5, deletions: 0 }
      })
    )
    expect(delta.entries.map((entry) => entry.path)).toEqual([
      'big.ts',
      'mid-a.ts',
      'mid-b.ts',
      'small.ts'
    ])
  })
})

describe('formatWorkspaceChurnStanza', () => {
  const heading = 'Workspace changes so far this round:'

  it('returns null when there is nothing to report', () => {
    expect(formatWorkspaceChurnStanza({ entries: [], decreasedPaths: [] }, { heading })).toBeNull()
  })

  it('renders churn, the heading, and the provenance caveat', () => {
    const stanza = formatWorkspaceChurnStanza(
      {
        entries: [{ path: 'src/a.ts', additions: 42, deletions: 7, kind: 'changed' }],
        decreasedPaths: []
      },
      { heading }
    )
    expect(stanza).toContain(heading)
    expect(stanza).toContain('src/a.ts +42/-7')
    // The instrument must disclose that it measures the tree, not the panel.
    expect(stanza).toContain('git diff --numstat')
    expect(stanza).toContain('edits made outside this panel appear here too')
    expect(stanza).toContain('prefer them over any per-turn')
  })

  it('reports the CHURN it dropped at the cap, not just the file count', () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      path: `src/f${index}.ts`,
      additions: 10,
      deletions: 5,
      kind: 'changed' as const
    }))
    const stanza = formatWorkspaceChurnStanza(
      { entries, decreasedPaths: [] },
      {
        heading,
        maxPaths: 2
      }
    )
    expect(stanza).toContain('src/f0.ts')
    expect(stanza).toContain('src/f1.ts')
    expect(stanza).not.toContain('src/f2.ts +')
    // 3 dropped files × +10/-5 — a silent "+3 more" would hide 45 lines.
    expect(stanza).toContain('3 more files totalling +30/-15')
  })

  it('labels untracked and binary entries distinctly from tracked churn', () => {
    const stanza = formatWorkspaceChurnStanza(
      {
        entries: [
          { path: 'notes.md', additions: 12, deletions: 0, kind: 'untracked' },
          { path: 'icon.png', additions: 0, deletions: 0, kind: 'binary' }
        ],
        decreasedPaths: []
      },
      { heading }
    )
    expect(stanza).toContain('notes.md +12 (new file, not yet tracked by git)')
    expect(stanza).toContain('icon.png (binary')
    // A binary file must never be rendered as a measured zero.
    expect(stanza).not.toContain('+0/-0')
  })

  it('surfaces decreased paths even with no forward churn', () => {
    const stanza = formatWorkspaceChurnStanza(
      { entries: [], decreasedPaths: ['src/peer-work.ts'] },
      { heading }
    )
    expect(stanza).toContain('Moved BACK toward the last commit')
    expect(stanza).toContain('src/peer-work.ts')
  })

  it('caps the decreased-path list too', () => {
    const stanza = formatWorkspaceChurnStanza(
      { entries: [], decreasedPaths: ['a.ts', 'b.ts', 'c.ts'] },
      { heading, maxPaths: 2 }
    )
    expect(stanza).toContain('a.ts, b.ts')
    expect(stanza).toContain('(+1 more)')
  })
})
