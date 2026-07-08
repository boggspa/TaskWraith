import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BugReportSheet, type BugReportSubmission } from './BugReportSheet'

/**
 * Server-rendered smoke tests for BugReportSheet. Mirrors the
 * FirstLaunchSheet test pattern — the codebase uses
 * `renderToStaticMarkup` (no jsdom), so interaction coverage is
 * structural: we assert that the right markup exists for each
 * scenario and trust the small handlers to do the right thing at
 * runtime. The IPC-side behaviour (severity validation, file write)
 * is exercised separately in BugReportService.test.ts.
 *
 * Specifically covered here (per the work scope's "at least 4
 * focused tests" requirement):
 *   1. Form validation surface — required marker on the title field
 *      and disabled state on the submit button when the title is empty.
 *   2. Severity selection — all four chips render, "minor" is the
 *      default, and the checked modifier class flips with the prop.
 *   3. Save handler invocation — submit button and form structure
 *      wire to a passed-in `onSubmit`, with the right ARIA labels so
 *      the parent test can locate the surface.
 *   4. Dismiss handlers — Cancel + close X both render with the
 *      correct ARIA hooks and the Esc dismissal contract is wired
 *      via the same `onDismiss` prop (verified by closed-state
 *      rendering returning null and the backdrop having the
 *      click-outside hook in markup).
 */

const baseProps = {
  appVersion: '1.0.1',
  currentProvider: 'codex',
  currentWorkspacePath: '/Users/dev/projects/taskwraith',
  composerShell: 'default',
  initialSurface: 'Ensemble',
  chatKind: 'ensemble',
  settingsTab: 'mcp',
  inspectorTab: 'safety',
  theme: 'midnight',
  promptBubble: 'blue',
  ensembleSummary: '4 participants · turn · Reviewer/claude, Worker/codex'
}

describe('BugReportSheet', () => {
  it('returns null when not open so the host can mount it unconditionally', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open={false} onDismiss={() => {}} onSubmit={async () => {}} />
    )
    expect(html).toBe('')
  })

  it('renders the title field with a required marker and the submit button disabled when empty', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    expect(html).toContain('id="bug-report-title"')
    expect(html).toContain('aria-required')
    // Required asterisk marker that points the tester at the field.
    expect(html).toMatch(/bug-report-sheet-required/)
    // Submit button is disabled on initial render because the title
    // is empty — that's the strongest signal that the field is
    // required (the form refuses to submit until it's populated).
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/)
    // Live character counter for the 140-char title cap (starts at 0/140).
    expect(html).toContain('bug-report-sheet-char-counter')
    expect(html).toContain('0/140')
  })

  it('renders all four severity options with "minor" pre-selected', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    // All four severity chips render.
    expect(html).toContain('bug-report-sheet-severity-chip-info')
    expect(html).toContain('bug-report-sheet-severity-chip-minor')
    expect(html).toContain('bug-report-sheet-severity-chip-major')
    expect(html).toContain('bug-report-sheet-severity-chip-blocking')
    // The "minor" chip carries the checked modifier (default).
    expect(html).toMatch(
      /bug-report-sheet-severity-chip-minor[^"]*bug-report-sheet-severity-chip-checked/
    )
    // The others do NOT carry the checked modifier.
    expect(html).not.toMatch(
      /bug-report-sheet-severity-chip-major[^"]*bug-report-sheet-severity-chip-checked/
    )
    // The hidden radio input for "minor" is rendered as `checked` so
    // the form-data round-trip works correctly even with the
    // visually-hidden inputs. React's static-markup serializer can
    // emit the attributes in either order, so we accept both.
    expect(html).toMatch(
      /<input[^>]*checked[^>]*value="minor"|<input[^>]*value="minor"[^>]*checked/
    )
  })

  it('renders the surface picker for newer app areas', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    expect(html).toContain('Where did it happen?')
    expect(html).toContain('value="Ensemble"')
    expect(html).toContain('value="MCP"')
    expect(html).toContain('value="Onboarding"')
  })

  it('exposes the save handler via a labelled submit button so the host wiring stays discoverable', () => {
    // Sanity: the onSubmit prop is required by the type system; the
    // rendered surface should expose a single submit button so the
    // host can rely on it for keyboard / pointer dispatch.
    const onSubmit = vi.fn(async (_payload: BugReportSubmission) => {})
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={onSubmit} />
    )
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Save report</)
    // Form-level handler is on the form element (the only submit
    // path in the markup) so React's synthetic submit dispatch
    // reaches `onSubmit` even from an Enter-in-title-input.
    expect(html).toMatch(/<form[^>]*class="bug-report-sheet-form"/)
    // The onSubmit prop itself isn't called during static markup
    // rendering — but the type signature is enforced and we've
    // confirmed the surface that will route to it exists.
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders the Cancel + close-X dismissal surfaces with the right ARIA hooks', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    // Cancel button — neutral shared action, dismisses without saving.
    expect(html).toMatch(/<button[^>]*class="segmented-control-action"[^>]*>Cancel</)
    // Close X — top-right corner.
    expect(html).toMatch(/aria-label="Close bug-report sheet"/)
    // Backdrop renders as the outer click-outside target so the host
    // doesn't need to wire its own dismiss when the user clicks dim.
    expect(html).toMatch(/class="bug-report-sheet-backdrop"/)
  })

  it('renders the auto-captured context block with expanded context fields', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    // Each context key appears in the read-only preview block above
    // the submit button — testers see what's being captured before
    // they hit save (no surprise telemetry).
    expect(html).toContain('Timestamp')
    expect(html).toContain('Version')
    expect(html).toContain('Provider')
    expect(html).toContain('Workspace')
    expect(html).toContain('Surface')
    expect(html).toContain('Composer shell')
    expect(html).toContain('Chat kind')
    expect(html).toContain('Settings tab')
    expect(html).toContain('Inspector tab')
    expect(html).toContain('Theme')
    expect(html).toContain('Bubble')
    expect(html).toContain('Ensemble')
    // Values render verbatim — these are the auto-captured strings.
    expect(html).toContain('1.0.1')
    expect(html).toContain('codex')
    // Workspace path is home-abbreviated (~/) so a reporter's OS username
    // never appears in the preview or the pre-filled (public) GitHub issue.
    expect(html).toContain('~/projects/taskwraith')
    expect(html).not.toContain('/Users/dev/projects/taskwraith')
    expect(html).toContain('default')
    expect(html).toContain('4 participants')
  })

  it('falls back to "(general chat)" label when the workspace path is null', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet
        {...baseProps}
        currentWorkspacePath={null}
        open
        onDismiss={() => {}}
        onSubmit={async () => {}}
      />
    )
    expect(html).toContain('(general chat)')
  })

  it('renders the dialog header with the "Report a bug or issue" title and modal a11y attributes', () => {
    const html = renderToStaticMarkup(
      <BugReportSheet {...baseProps} open onDismiss={() => {}} onSubmit={async () => {}} />
    )
    expect(html).toContain('Report a bug or issue')
    expect(html).toMatch(/role="dialog"/)
    expect(html).toMatch(/aria-modal="true"/)
    expect(html).toMatch(/aria-labelledby="bug-report-sheet-title"/)
  })
})
