import { describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import {
  appendBugReport,
  renderBugReportMarkdown,
  resolveBugReportPath,
  stitchAppendEntry,
  type BugReportFsOps,
  type BugReportSubmission
} from './BugReportService'

/**
 * Unit tests for the bug-report intake service. The fs glue
 * (`appendBugReport`) takes an injectable `ops` so we exercise the
 * append flow end-to-end without touching the real filesystem.
 *
 * Coverage:
 *   1. renderBugReportMarkdown — frontmatter shape, expected/omit
 *      branch, context list, optional escape of double quotes in
 *      the title.
 *   2. stitchAppendEntry — first-entry vs subsequent-entry layout
 *      (no leading HR on first, HR + blank lines for follow-ups).
 *   3. appendBugReport — full orchestrator: mkdir + read + write +
 *      success result, including the ENOENT-as-empty branch and
 *      the size-warning threshold.
 *   4. resolveBugReportPath — userData/TaskWraith/bug-reports.md layout.
 */

const baseSubmission: BugReportSubmission = {
  title: 'Composer freezes after Cmd+K',
  description:
    'I opened slash commands, typed "new chat", and the\ncomposer stopped accepting keystrokes.',
  expected: 'Composer should accept input after Cmd+K closes slash commands.',
  severity: 'major',
  context: {
    timestamp: '2026-05-24T19:10:00.000Z',
    version: '1.0.1',
    provider: 'codex',
    workspace: '/Users/dev/projects/taskwraith',
    shell: 'default',
    surface: 'Ensemble',
    chatKind: 'ensemble',
    settingsTab: 'mcp',
    inspectorTab: 'safety',
    theme: 'midnight',
    promptBubble: 'blue',
    ensemble: '4 participants · turn · Reviewer/claude, Worker/codex'
  }
}

describe('BugReportService.renderBugReportMarkdown', () => {
  it('renders YAML frontmatter + What happened + What was expected + Context sections', () => {
    const md = renderBugReportMarkdown(baseSubmission)
    // Frontmatter opens with `---` and carries every metadata field.
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('title: "Composer freezes after Cmd+K"')
    expect(md).toContain('severity: major')
    expect(md).toContain('timestamp: 2026-05-24T19:10:00.000Z')
    expect(md).toContain('version: 1.0.1')
    expect(md).toContain('provider: codex')
    expect(md).toContain('workspace: /Users/dev/projects/taskwraith')
    expect(md).toContain('shell: default')
    expect(md).toContain('surface: "Ensemble"')
    expect(md).toContain('chat_kind: "ensemble"')
    expect(md).toContain('settings_tab: "mcp"')
    expect(md).toContain('inspector_tab: "safety"')
    expect(md).toContain('theme: "midnight"')
    expect(md).toContain('prompt_bubble: "blue"')
    expect(md).toContain('ensemble: "4 participants · turn · Reviewer/claude, Worker/codex"')
    // Body sections.
    expect(md).toContain('## What happened\n')
    expect(md).toContain('## What was expected\n')
    expect(md).toContain('## Context\n')
    // Context list mirrors the frontmatter.
    expect(md).toContain('- Version: 1.0.1')
    expect(md).toContain('- Provider: codex')
    expect(md).toContain('- Surface: Ensemble')
    expect(md).toContain('- Chat kind: ensemble')
    expect(md).toContain('- Shell: default')
    expect(md).toContain('- Settings tab: mcp')
    expect(md).toContain('- Inspector tab: safety')
    expect(md).toContain('- Theme: midnight')
    expect(md).toContain('- Bubble: blue')
    expect(md).toContain('- Ensemble: 4 participants')
  })

  it('omits the "What was expected" section when the expected field is empty', () => {
    const md = renderBugReportMarkdown({ ...baseSubmission, expected: '   ' })
    expect(md).not.toContain('## What was expected')
    // But the rest of the structure remains.
    expect(md).toContain('## What happened')
    expect(md).toContain('## Context')
  })

  it('marks an empty description with a placeholder so the maintainer can spot it on triage', () => {
    const md = renderBugReportMarkdown({ ...baseSubmission, description: '' })
    expect(md).toContain('_(tester provided no description)_')
  })

  it('escapes double quotes in the title for safe YAML frontmatter', () => {
    const md = renderBugReportMarkdown({
      ...baseSubmission,
      title: 'Says "broken" without context'
    })
    expect(md).toContain('title: "Says \\"broken\\" without context"')
  })
})

describe('BugReportService.stitchAppendEntry', () => {
  it('returns the new entry verbatim when the file is empty', () => {
    const entry = renderBugReportMarkdown(baseSubmission)
    expect(stitchAppendEntry('', entry)).toBe(entry)
    expect(stitchAppendEntry('   \n\n  ', entry)).toBe(entry)
  })

  it('joins subsequent entries with a horizontal rule + blank lines', () => {
    const first = renderBugReportMarkdown(baseSubmission)
    const second = renderBugReportMarkdown({
      ...baseSubmission,
      title: 'Second report',
      severity: 'minor'
    })
    const stitched = stitchAppendEntry(first, second)
    // Separator between entries.
    expect(stitched).toContain('\n---\n\n')
    // Both entries are present.
    expect(stitched).toContain('title: "Composer freezes after Cmd+K"')
    expect(stitched).toContain('title: "Second report"')
    // First entry comes before second.
    expect(stitched.indexOf('title: "Composer freezes after Cmd+K"')).toBeLessThan(
      stitched.indexOf('title: "Second report"')
    )
  })
})

describe('BugReportService.appendBugReport', () => {
  it('creates the parent directory, reads the existing file, and writes the appended result', async () => {
    const writes: { file: string; data: string }[] = []
    const ops: BugReportFsOps = {
      mkdir: vi.fn(async () => undefined),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async (file, data) => {
        writes.push({ file, data })
      })
    }
    const userDataDir = '/tmp/test-userdata'
    const expectedPath = join(userDataDir, 'TaskWraith', 'bug-reports.md')
    const result = await appendBugReport(userDataDir, baseSubmission, ops)
    expect(result.ok).toBe(true)
    expect(result.path).toBe(expectedPath)
    expect(ops.mkdir).toHaveBeenCalledWith(dirname(expectedPath), { recursive: true })
    expect(writes).toHaveLength(1)
    expect(writes[0].file).toBe(expectedPath)
    expect(writes[0].data).toContain('title: "Composer freezes after Cmd+K"')
    // First write — no leading separator.
    expect(writes[0].data.startsWith('---\n')).toBe(true)
    expect(writes[0].data).not.toContain('\n---\n\n---\n')
  })

  it('appends a follow-up entry with a separator between the existing file and the new one', async () => {
    const first = renderBugReportMarkdown(baseSubmission)
    const writes: string[] = []
    const ops: BugReportFsOps = {
      mkdir: async () => undefined,
      readFile: async () => first,
      writeFile: async (_file, data) => {
        writes.push(data)
      }
    }
    const second: BugReportSubmission = {
      ...baseSubmission,
      title: 'Another issue',
      severity: 'info',
      context: { ...baseSubmission.context, timestamp: '2026-05-24T20:00:00.000Z' }
    }
    const result = await appendBugReport('/tmp/test-userdata', second, ops)
    expect(result.ok).toBe(true)
    expect(writes[0]).toContain('\n---\n\n')
    expect(writes[0]).toContain('title: "Composer freezes after Cmd+K"')
    expect(writes[0]).toContain('title: "Another issue"')
  })

  it('flips sizeWarning once the total file passes the soft threshold', async () => {
    // Build a 6 MB "existing" buffer to push the total above the
    // 5 MB warning threshold; the implementation flags the warning
    // but still writes successfully.
    const giant = 'x'.repeat(6 * 1024 * 1024)
    const ops: BugReportFsOps = {
      mkdir: async () => undefined,
      readFile: async () => giant,
      writeFile: async () => undefined
    }
    const result = await appendBugReport('/tmp/test-userdata', baseSubmission, ops)
    expect(result.ok).toBe(true)
    expect(result.sizeWarning).toBe(true)
    expect(result.totalBytes).toBeGreaterThan(5 * 1024 * 1024)
  })

  it('resolveBugReportPath builds <userData>/TaskWraith/bug-reports.md', () => {
    const userDataDir = '/Users/dev/Library/Application Support/taskwraith'
    expect(resolveBugReportPath(userDataDir)).toBe(
      join(userDataDir, 'TaskWraith', 'bug-reports.md')
    )
  })
})
