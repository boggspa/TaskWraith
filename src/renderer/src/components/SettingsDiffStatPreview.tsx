import type React from 'react'

const MINIMUM_EXAMPLE_LINE_COUNT = 1_000_000
const MAXIMUM_EXAMPLE_LINE_COUNT = 9_999_999

interface DiffStatPreviewExample {
  additions: number
  deletions: number
}

function randomExampleLineCount(random: () => number): number {
  const range = MAXIMUM_EXAMPLE_LINE_COUNT - MINIMUM_EXAMPLE_LINE_COUNT + 1
  const offset = Math.min(range - 1, Math.max(0, Math.floor(random() * range)))
  return MINIMUM_EXAMPLE_LINE_COUNT + offset
}

function createDiffStatPreviewExample(random = Math.random): DiffStatPreviewExample {
  return {
    additions: randomExampleLineCount(random),
    deletions: randomExampleLineCount(random)
  }
}

// Deliberately stable for the renderer session: it changes on relaunch, not
// every time someone switches away from and back to Appearance settings.
const SESSION_DIFF_STAT_PREVIEW = createDiffStatPreviewExample()
const numberFormatter = new Intl.NumberFormat('en-US')

export function SettingsDiffStatPreview({
  additionsColor,
  deletionsColor
}: {
  additionsColor: string
  deletionsColor: string
}): React.JSX.Element {
  return (
    <section
      className="settings-diff-stat-preview"
      aria-label="Diff stat color preview"
      style={{
        ['--settings-diff-stat-additions' as string]: additionsColor,
        ['--settings-diff-stat-deletions' as string]: deletionsColor
      }}
    >
      <p className="settings-diff-stat-preview-label">A perfectly normal “small cleanup”:</p>
      <div className="settings-diff-stat-preview-counts">
        <span className="settings-diff-stat-preview-additions">
          +{numberFormatter.format(SESSION_DIFF_STAT_PREVIEW.additions)}
        </span>
        <span className="settings-diff-stat-preview-deletions">
          −{numberFormatter.format(SESSION_DIFF_STAT_PREVIEW.deletions)}
        </span>
      </div>
      <p className="settings-diff-stat-preview-note">
        At this size, the color read is doing real work.
      </p>
    </section>
  )
}
