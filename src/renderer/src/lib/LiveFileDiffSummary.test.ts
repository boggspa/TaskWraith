import { describe, it, expect } from 'vitest'
import {
  getLiveToolFileDiffSummaries,
  extractToolFileContributions,
  liveSummariesAreFuzzy,
  applyWorkspaceDiffOverlay,
  __test__
} from './LiveFileDiffSummary'
import type { ChatMessage, ToolActivity, DiffFileSummary } from '../../../main/store/types'

const baseActivity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: overrides.id || 't1',
  toolName: overrides.toolName || 'edit_file',
  displayName: overrides.displayName || 'Edited file',
  category: overrides.category || 'write',
  status: overrides.status || 'success',
  parameters: overrides.parameters,
  diffSummary: overrides.diffSummary,
  resultSummary: overrides.resultSummary,
  outputPreview: overrides.outputPreview,
  filePath: overrides.filePath,
  affectedFilePath: overrides.affectedFilePath
})

const messageWith = (activities: ToolActivity[]): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  timestamp: new Date().toISOString(),
  toolActivities: activities
})

describe('LiveFileDiffSummary', () => {
  describe('extractToolFileContributions', () => {
    it('reads per-file additions/deletions directly when Codex provides them', () => {
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          changes: [
            { path: 'src/App.tsx', kind: 'modify', additions: 12, deletions: 3 },
            { path: 'src/main.css', kind: 'modify', added: 4, deleted: 1 }
          ]
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions).toHaveLength(2)
      expect(contributions[0]).toMatchObject({
        path: 'src/App.tsx',
        additions: 12,
        deletions: 3,
        status: 'modified'
      })
      expect(contributions[1]).toMatchObject({
        path: 'src/main.css',
        additions: 4,
        deletions: 1,
        status: 'modified'
      })
    })

    it('parses per-file unified diffs when Codex apply_patch omits numstat', () => {
      // Codex apply_patch_call emits each change as {path, type: 'update', diff}
      // — the previous extractor returned 0/0 because it only looked at the
      // additions/deletions fields. This regression covers the screenshot.
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          changes: [
            {
              path: 'Package.swift',
              type: 'update',
              unified_diff: [
                'diff --git a/Package.swift b/Package.swift',
                '--- a/Package.swift',
                '+++ b/Package.swift',
                '@@ -1,2 +1,3 @@',
                ' line',
                '-old',
                '+new',
                '+next'
              ].join('\n')
            }
          ]
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions).toHaveLength(1)
      expect(contributions[0]).toMatchObject({
        path: 'Package.swift',
        additions: 2,
        deletions: 1,
        status: 'modified'
      })
    })

    it('downgrades deleted status hints when the attached patch only edits lines', () => {
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          changes: [
            {
              path: 'src/important.ts',
              type: 'delete',
              patch: [
                'diff --git a/src/important.ts b/src/important.ts',
                '--- a/src/important.ts',
                '+++ b/src/important.ts',
                '@@ -1,2 +1,1 @@',
                ' keep',
                '-remove just this line'
              ].join('\n')
            }
          ]
        }
      })

      expect(extractToolFileContributions(activity)[0]).toMatchObject({
        path: 'src/important.ts',
        status: 'modified',
        additions: 0,
        deletions: 1
      })
    })

    it('downgrades deleted status hints without whole-file evidence', () => {
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          changes: [
            {
              path: 'src/renderer/src/components/FirstLaunchSheet.tsx',
              status: 'deleted',
              deletions: 1
            }
          ]
        }
      })

      expect(extractToolFileContributions(activity)[0]).toMatchObject({
        path: 'src/renderer/src/components/FirstLaunchSheet.tsx',
        status: 'modified',
        deletions: 1
      })
    })

    it('keeps deleted status hints when the patch deletes the whole file', () => {
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          changes: [
            {
              path: 'src/old.ts',
              type: 'delete',
              patch: [
                'diff --git a/src/old.ts b/src/old.ts',
                'deleted file mode 100644',
                '--- a/src/old.ts',
                '+++ /dev/null',
                '@@ -1 +0,0 @@',
                '-old'
              ].join('\n')
            }
          ]
        }
      })

      expect(extractToolFileContributions(activity)[0]).toMatchObject({
        path: 'src/old.ts',
        status: 'deleted',
        additions: 0,
        deletions: 1
      })
    })

    it('keeps explicit delete_file activities deleted without diff text', () => {
      const activity = baseActivity({
        toolName: 'delete_file',
        parameters: {
          file_path: 'src/old.ts'
        }
      })

      expect(extractToolFileContributions(activity)[0]).toMatchObject({
        path: 'src/old.ts',
        status: 'deleted'
      })
    })

    it('keeps parsed patch-preview file deletions deleted', () => {
      const activity = baseActivity({
        toolName: 'apply_patch',
        parameters: {
          patch: [
            'diff --git a/src/old.ts b/src/old.ts',
            'deleted file mode 100644',
            '--- a/src/old.ts',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-old'
          ].join('\n')
        }
      })

      expect(extractToolFileContributions(activity)[0]).toMatchObject({
        path: 'src/old.ts',
        status: 'deleted',
        additions: 0,
        deletions: 1
      })
    })

    it('infers additions from content for `add` change records', () => {
      const activity = baseActivity({
        toolName: 'apply_patch',
        parameters: {
          changes: [{ path: 'new.swift', type: 'add', content: 'line1\nline2\nline3\n' }]
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions[0]).toMatchObject({ path: 'new.swift', additions: 3, status: 'created' })
      expect(contributions[0].deletions).toBeUndefined()
    })

    it('falls back to a single-file content count for Claude Write', () => {
      const activity = baseActivity({
        toolName: 'write_file',
        parameters: {
          file_path: 'README.md',
          content: 'line1\nline2\nline3'
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions).toHaveLength(1)
      expect(contributions[0]).toMatchObject({ path: 'README.md', additions: 3, status: 'created' })
    })

    it('counts old_string/new_string for Claude Edit', () => {
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          file_path: 'a.ts',
          old_string: 'one\ntwo',
          new_string: 'one\ntwo\nthree\nfour'
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions[0]).toMatchObject({ path: 'a.ts', additions: 4, deletions: 2 })
    })

    it('aggregates Claude MultiEdit edits[] per file', () => {
      const activity = baseActivity({
        toolName: 'MultiEdit',
        parameters: {
          file_path: 'src/foo.ts',
          edits: [
            { old_string: 'a', new_string: 'a\nb' },
            { old_string: 'c\nd', new_string: 'c' }
          ]
        }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions).toHaveLength(1)
      expect(contributions[0]).toMatchObject({
        path: 'src/foo.ts',
        additions: 3,
        deletions: 3,
        status: 'modified'
      })
    })

    it('counts new content lines for Gemini MCP write_file', () => {
      // 3 non-empty lines + trailing newline produces 4 raw split entries.
      // The base estimator counts raw split length so the row pill matches the
      // content the agent actually wrote.
      const activity = baseActivity({
        toolName: 'write_file',
        parameters: {
          path: '/abs/workspace/build.yml',
          content: 'jobs:\n  build:\n    steps: []\n'
        }
      })

      const contributions = extractToolFileContributions(activity, '/abs/workspace')
      expect(contributions).toHaveLength(1)
      expect(contributions[0]).toMatchObject({ path: 'build.yml', additions: 4, status: 'created' })
    })

    it('handles Gemini MCP replace with old_string/new_string', () => {
      const activity = baseActivity({
        toolName: 'replace',
        parameters: {
          path: '/abs/workspace/src/foo.ts',
          old_string: 'alpha\nbeta',
          new_string: 'alpha\nbeta\ngamma'
        }
      })

      const contributions = extractToolFileContributions(activity, '/abs/workspace')
      expect(contributions[0]).toMatchObject({ path: 'src/foo.ts', additions: 3, deletions: 2 })
    })

    it('returns no contributions when the tool result has no diff hints', () => {
      const activity = baseActivity({
        toolName: 'run_shell_command',
        category: 'shell',
        parameters: { command: 'ls -la' }
      })

      expect(extractToolFileContributions(activity)).toEqual([])
    })

    it('records a write-style activity with undefined counts when no signal is present', () => {
      // This is the "fuzzy row" case — we know the file was touched but we
      // don't know the diff stats. The UI should render `...` (or hide the
      // pill), not `+0 -0`.
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: { file_path: 'mystery.md' }
      })

      const contributions = extractToolFileContributions(activity)
      expect(contributions).toHaveLength(1)
      expect(contributions[0].path).toBe('mystery.md')
      expect(contributions[0].additions).toBeUndefined()
      expect(contributions[0].deletions).toBeUndefined()
    })
  })

  describe('getLiveToolFileDiffSummaries', () => {
    it('returns empty for an empty transcript', () => {
      expect(getLiveToolFileDiffSummaries([])).toEqual([])
    })

    it('aggregates additions/deletions across messages and preserves status precedence', () => {
      const summaries = getLiveToolFileDiffSummaries([
        messageWith([
          baseActivity({
            id: 'a',
            toolName: 'write_file',
            parameters: { file_path: 'src/feature.ts', content: 'line1\nline2\nline3' }
          })
        ]),
        messageWith([
          baseActivity({
            id: 'b',
            toolName: 'edit_file',
            parameters: { file_path: 'src/feature.ts', old_string: 'a\nb', new_string: 'a\nb\nc' }
          })
        ])
      ])

      expect(summaries).toHaveLength(1)
      // 3 from initial write + 3 from edit additions; 2 from edit deletions.
      expect(summaries[0]).toMatchObject({
        path: 'src/feature.ts',
        // The write fires `created` (it was a fresh write), the edit reports
        // `modified` — `created` outranks `modified`.
        status: 'created',
        additions: 6,
        deletions: 2
      })
    })

    it('preserves undefined per-file counts when no contributor knows them', () => {
      // The screenshot's bug: 4 edited files, exact diff missing, in-message
      // hints lack line counts. The renderer should see `undefined` and
      // suppress the +0 -0 pill, not anchor at zero.
      const summaries = getLiveToolFileDiffSummaries([
        messageWith([
          baseActivity({ id: 'a', toolName: 'edit_file', parameters: { file_path: 'mystery.md' } })
        ])
      ])

      expect(summaries).toHaveLength(1)
      expect(summaries[0].path).toBe('mystery.md')
      expect(summaries[0].additions).toBeUndefined()
      expect(summaries[0].deletions).toBeUndefined()
    })

    it('does not collapse a known count to zero when later contributors lack stats', () => {
      // Activity A reports concrete additions; activity B has no diff hints.
      // The aggregator must keep A's number rather than overwriting it with 0
      // just because B couldn't compute anything.
      const summaries = getLiveToolFileDiffSummaries([
        messageWith([
          baseActivity({
            id: 'a',
            toolName: 'edit_file',
            parameters: { file_path: 'README.md', old_string: 'x', new_string: 'x\ny\nz' }
          })
        ]),
        messageWith([
          baseActivity({ id: 'b', toolName: 'edit_file', parameters: { file_path: 'README.md' } })
        ])
      ])

      // A: additions=3 (new_string), deletions=1 (old_string). B contributes nothing.
      expect(summaries[0].additions).toBe(3)
      expect(summaries[0].deletions).toBe(1)
    })

    it('handles a real Codex apply_patch chain end-to-end', () => {
      // Simulates the actual transcript shape: a single Codex apply_patch_call
      // collapsing to one synthetic `edit_file` activity with per-file
      // unified_diff entries. The previous implementation returned `+0 -0`.
      const activity = baseActivity({
        toolName: 'edit_file',
        parameters: {
          path: '.github/workflows/build.yml',
          changes: [
            {
              path: '.github/workflows/build.yml',
              type: 'update',
              unified_diff:
                'diff --git a/.github/workflows/build.yml b/.github/workflows/build.yml\n--- a/.github/workflows/build.yml\n+++ b/.github/workflows/build.yml\n@@ -1,2 +1,3 @@\n-old line\n+new line\n+another'
            },
            {
              path: 'Sources/SDLTextureFramePresenter.swift',
              type: 'update',
              unified_diff:
                'diff --git a/Sources/SDLTextureFramePresenter.swift b/Sources/SDLTextureFramePresenter.swift\n--- a/Sources/SDLTextureFramePresenter.swift\n+++ b/Sources/SDLTextureFramePresenter.swift\n@@ -1,1 +1,4 @@\n-old\n+new\n+other\n+more'
            }
          ]
        }
      })

      const summaries = getLiveToolFileDiffSummaries([messageWith([activity])])

      expect(summaries).toHaveLength(2)
      const buildYml = summaries.find((s) => s.path === '.github/workflows/build.yml')
      const swift = summaries.find((s) => s.path === 'Sources/SDLTextureFramePresenter.swift')
      expect(buildYml).toMatchObject({ additions: 2, deletions: 1 })
      expect(swift).toMatchObject({ additions: 3, deletions: 1 })
    })

    it('normalises absolute workspace-prefixed paths to repo-relative ones', () => {
      const summaries = getLiveToolFileDiffSummaries(
        [
          messageWith([
            baseActivity({
              toolName: 'write_file',
              parameters: { file_path: '/Users/me/proj/src/foo.ts', content: 'a\nb\nc' }
            })
          ])
        ],
        '/Users/me/proj'
      )

      expect(summaries).toHaveLength(1)
      expect(summaries[0].path).toBe('src/foo.ts')
    })

    it('drops activities that are not write-like and lack a diff summary', () => {
      const summaries = getLiveToolFileDiffSummaries([
        messageWith([
          baseActivity({
            toolName: 'read_file',
            category: 'read',
            parameters: { file_path: 'src/foo.ts' }
          })
        ])
      ])

      expect(summaries).toEqual([])
    })
  })

  describe('liveSummariesAreFuzzy', () => {
    it('returns false when every row carries line counts', () => {
      const summaries: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', additions: 5, deletions: 1, previewKind: 'none' },
        { path: 'b.ts', status: 'created', additions: 3, deletions: 0, previewKind: 'none' }
      ]
      expect(liveSummariesAreFuzzy(summaries)).toBe(false)
    })

    it('returns true when at least one row is missing line counts', () => {
      const summaries: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', additions: 5, deletions: 1, previewKind: 'none' },
        { path: 'b.ts', status: 'modified', previewKind: 'none' }
      ]
      expect(liveSummariesAreFuzzy(summaries)).toBe(true)
    })

    it('returns false on an empty input', () => {
      expect(liveSummariesAreFuzzy([])).toBe(false)
    })
  })

  describe('applyWorkspaceDiffOverlay', () => {
    it('fills in missing additions/deletions from the workspace snapshot', () => {
      const summaries: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', previewKind: 'none' },
        { path: 'b.ts', status: 'modified', additions: 1, deletions: 1, previewKind: 'none' }
      ]
      const workspace: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', additions: 42, deletions: 7, previewKind: 'git_diff' },
        {
          path: 'b.ts',
          status: 'modified',
          additions: 999,
          deletions: 999,
          previewKind: 'git_diff'
        }
      ]

      const overlaid = applyWorkspaceDiffOverlay(summaries, workspace)
      expect(overlaid[0]).toMatchObject({ path: 'a.ts', additions: 42, deletions: 7 })
      // b.ts already had values — they must NOT be clobbered.
      expect(overlaid[1]).toMatchObject({ path: 'b.ts', additions: 1, deletions: 1 })
    })

    it('does not introduce extra rows for unrelated workspace dirt by default', () => {
      const summaries: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', previewKind: 'none' }
      ]
      const workspace: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', additions: 5, deletions: 5, previewKind: 'git_diff' },
        {
          path: 'untouched.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          previewKind: 'git_diff'
        }
      ]

      const overlaid = applyWorkspaceDiffOverlay(summaries, workspace)
      expect(overlaid).toHaveLength(1)
      expect(overlaid[0]).toMatchObject({ path: 'a.ts', additions: 5, deletions: 5 })
    })

    it('uses workspace status to correct misleading live deleted rows for existing files', () => {
      const summaries: DiffFileSummary[] = [
        {
          path: 'FirstLaunchSheet.tsx',
          status: 'deleted',
          additions: 0,
          deletions: 3,
          previewKind: 'none'
        }
      ]
      const workspace: DiffFileSummary[] = [
        {
          path: 'FirstLaunchSheet.tsx',
          status: 'modified',
          additions: 2,
          deletions: 3,
          previewKind: 'git_diff'
        }
      ]

      expect(applyWorkspaceDiffOverlay(summaries, workspace)[0]).toMatchObject({
        path: 'FirstLaunchSheet.tsx',
        status: 'modified',
        additions: 0,
        deletions: 3
      })
    })

    it('returns the input unchanged when the overlay is empty', () => {
      const summaries: DiffFileSummary[] = [
        { path: 'a.ts', status: 'modified', additions: 5, deletions: 1, previewKind: 'none' }
      ]
      expect(applyWorkspaceDiffOverlay(summaries, undefined)).toBe(summaries)
      expect(applyWorkspaceDiffOverlay(summaries, [])).toBe(summaries)
    })
  })

  describe('countDiffStatsFromUnifiedDiff', () => {
    it('does not count the `+++`/`---` header lines', () => {
      const stats = __test__.countDiffStatsFromUnifiedDiff(
        [
          'diff --git a/foo b/foo',
          '--- a/foo',
          '+++ b/foo',
          '@@ -1 +1,3 @@',
          '+real addition',
          '+real addition two',
          '-real deletion'
        ].join('\n')
      )
      expect(stats).toEqual({ additions: 2, deletions: 1 })
    })

    it('returns empty when the diff body has no +/- lines', () => {
      expect(__test__.countDiffStatsFromUnifiedDiff('not a diff')).toEqual({})
    })
  })

  describe('rejected / errored edits do not count as file changes', () => {
    // Repro: a read-only ("Plan / Read-only") Grok seat asks to edit the
    // README, Grok calls native `search_replace`, and TaskWraith's gate
    // auto-denies it — the tool_result is `{ status: 'error', output: 'User
    // rejected the execution for tool search_replace' }`. The file on disk
    // is unchanged, so the attempted +6/−4 must NOT surface as an applied
    // change anywhere downstream.
    const rejectedEdit = (): ToolActivity =>
      baseActivity({
        toolName: 'search_replace',
        status: 'error',
        filePath: 'README.md',
        parameters: {
          file_path: 'README.md',
          old_string: 'one\ntwo\nthree\nfour',
          new_string: 'one\nTWO\nthree\nfour\nfive\nsix'
        },
        // The activity still carries the diff it WANTED to apply — the gate
        // must honour the result status, not the attempted diff.
        diffSummary: {
          additions: 6,
          deletions: 4,
          files: [{ path: 'README.md', status: 'modified', additions: 6, deletions: 4 }],
          source: 'string_replace',
          confidence: 'estimated'
        },
        resultSummary: 'User rejected the execution for tool search_replace'
      })

    it('extractToolFileContributions returns nothing for a denied edit', () => {
      expect(extractToolFileContributions(rejectedEdit())).toEqual([])
    })

    it('getLiveToolFileDiffSummaries reports 0 files for a denied-edit-only run', () => {
      const summaries = getLiveToolFileDiffSummaries([messageWith([rejectedEdit()])])
      expect(summaries).toEqual([])
    })

    it('still counts the SAME edit when it succeeds (gate is on status, not the tool)', () => {
      const applied = { ...rejectedEdit(), status: 'success' as const }
      const contributions = extractToolFileContributions(applied)
      expect(contributions).toHaveLength(1)
      expect(contributions[0]).toMatchObject({
        path: 'README.md',
        status: 'modified',
        additions: 6,
        deletions: 4
      })
      const summaries = getLiveToolFileDiffSummaries([messageWith([applied])])
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ path: 'README.md', status: 'modified' })
    })

    it('drops the denied edit but keeps a sibling applied edit in the same run', () => {
      const applied = baseActivity({
        id: 't2',
        toolName: 'edit_file',
        status: 'success',
        filePath: 'src/App.tsx',
        parameters: {
          file_path: 'src/App.tsx',
          old_string: 'a',
          new_string: 'a\nb'
        }
      })
      const summaries = getLiveToolFileDiffSummaries([messageWith([rejectedEdit(), applied])])
      expect(summaries).toHaveLength(1)
      expect(summaries[0].path).toBe('src/App.tsx')
    })
  })
})
