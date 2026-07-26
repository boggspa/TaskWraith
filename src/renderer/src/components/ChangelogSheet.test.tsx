import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChangelogSheet, formatReleaseNotes, resolveChangelogEntry } from './ChangelogSheet'
import { isUpdatePillVisible, UpdatePill } from './UpdatePill'
import type { ProductChangelogSnapshot } from '../../../main/store/types'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'

const changelogSnapshot: ProductChangelogSnapshot = {
  currentVersion: '1.0.72',
  lastSeenChangelogVersion: '1.0.71'
}

describe('UpdatePill', () => {
  it('stays hidden for quiet update states', () => {
    const html = renderToStaticMarkup(
      <UpdatePill
        snapshot={{ status: 'idle', enabled: true, channel: 'stable' }}
        onOpen={() => {}}
      />
    )
    expect(html).toBe('')
  })

  it('renders an accent pill for available updates', () => {
    const html = renderToStaticMarkup(
      <UpdatePill
        snapshot={{
          status: 'available',
          enabled: true,
          channel: 'stable',
          latestVersion: '1.0.73'
        }}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('chat-corner-update-pill-available')
    expect(html).toContain('Update 1.0.73')
  })

  it('renders a rim-highlight sidebar pill for available updates', () => {
    const html = renderToStaticMarkup(
      <UpdatePill
        snapshot={{
          status: 'available',
          enabled: true,
          channel: 'stable',
          latestVersion: '1.4.4'
        }}
        onQuickUpdate={() => {}}
        variant="sidebar"
      />
    )
    expect(html).toContain('sidebar-update-pill-available')
    expect(html).toContain('Update 1.4.4')
  })

  it('isUpdatePillVisible gates quiet update states', () => {
    expect(isUpdatePillVisible({ status: 'idle', enabled: true, channel: 'stable' })).toBe(false)
    expect(
      isUpdatePillVisible({
        status: 'available',
        enabled: true,
        channel: 'stable',
        latestVersion: '1.4.4'
      })
    ).toBe(true)
  })

  it('renders download progress for downloading updates', () => {
    const html = renderToStaticMarkup(
      <UpdatePill
        snapshot={{
          status: 'downloading',
          enabled: true,
          channel: 'stable',
          latestVersion: '1.0.73',
          downloadProgress: {
            bytesPerSecond: 10,
            delta: 1,
            percent: 42.4,
            transferred: 42,
            total: 100
          }
        }}
        onOpen={() => {}}
      />
    )
    expect(html).toContain('chat-corner-update-pill-downloading')
    expect(html).toContain('42%')
  })
})

describe('ChangelogSheet', () => {
  it('returns null when closed', () => {
    const html = renderToStaticMarkup(
      <ChangelogSheet
        open={false}
        onDismiss={() => {}}
        changelogSnapshot={changelogSnapshot}
        updateSnapshot={null}
      />
    )
    expect(html).toBe('')
  })

  it('shows release notes and download action for available updates', () => {
    const updateSnapshot: UpdateStateSnapshot = {
      status: 'available',
      enabled: true,
      channel: 'stable',
      latestVersion: '1.0.73',
      releaseName: 'TaskWraith 1.0.73',
      releaseDate: '2026-06-04T12:00:00.000Z',
      releaseNotes: 'Updater pill and changelog sheet.'
    }
    const html = renderToStaticMarkup(
      <ChangelogSheet
        open
        onDismiss={() => {}}
        changelogSnapshot={changelogSnapshot}
        updateSnapshot={updateSnapshot}
        onDownloadUpdate={() => {}}
      />
    )
    expect(html).toContain('changelog-sheet-backdrop')
    expect(html).toContain('TaskWraith 1.0.73')
    expect(html).toContain('Updater pill and changelog sheet.')
    expect(html).toContain('Download update')
  })

  it('shows restart action for downloaded updates', () => {
    const html = renderToStaticMarkup(
      <ChangelogSheet
        open
        onDismiss={() => {}}
        changelogSnapshot={changelogSnapshot}
        updateSnapshot={{
          status: 'downloaded',
          enabled: true,
          channel: 'stable',
          latestVersion: '1.0.73',
          releaseNotes: 'Ready.'
        }}
        onInstallUpdateNow={() => {}}
      />
    )
    expect(html).toContain('Restart to install')
  })

  it('falls back to bundled current-version release notes when updater metadata is missing', () => {
    const html = renderToStaticMarkup(
      <ChangelogSheet
        open
        onDismiss={() => {}}
        changelogSnapshot={changelogSnapshot}
        updateSnapshot={null}
      />
    )
    expect(html).toContain('Release notes')
    expect(html).toContain('TaskWraith')
  })

  it('bundles the frozen 1.8.0 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.0' }, null)
    expect(entry).toMatchObject({
      version: '1.8.0',
      releaseDate: '2026-07-11'
    })
    expect(entry.releaseNotes).toContain('Durable delegated workers')
    expect(entry.releaseNotes).toContain('Async delegated workers cannot inherit Trusted Session')
  })

  it('bundles the frozen 1.8.1 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.1' }, null)
    expect(entry).toMatchObject({
      version: '1.8.1',
      releaseDate: '2026-07-12'
    })
    expect(entry.releaseNotes).toContain('Background lanes for Ensemble work')
    expect(entry.releaseNotes).toContain('Remote iPhone actions stay safe when a Mac sleeps')
    expect(entry.releaseNotes).toContain('Select roster presets during import or export')
    expect(entry.releaseNotes).toContain('Foreground seats now also hold their reader/writer fan-out lanes')
  })

  it('bundles the frozen 1.8.2 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.2' }, null)
    expect(entry).toMatchObject({
      version: '1.8.2',
      releaseDate: '2026-07-16'
    })
    expect(entry.releaseNotes).toContain('Kimi Code now runs through a contained ACP transport')
    expect(entry.releaseNotes).toContain('Workflow controls from the iPhone/iPad companion')
    expect(entry.releaseNotes).toContain('Kimi Code HighSpeed')
    expect(entry.releaseNotes).toContain('Transcript navigation keeps the reader\'s place')
    expect(entry.releaseNotes).toContain('Native provider file and shell tools stay brokered')
    expect(entry.releaseNotes).toContain('Remote favicon fetches are pinned and bounded')
  })

  it('bundles the frozen 1.8.3 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.3' }, null)
    expect(entry).toMatchObject({
      version: '1.8.3',
      releaseDate: '2026-07-16'
    })
    expect(entry.releaseNotes).toContain('Kimi K3')
    expect(entry.releaseNotes).toContain('Windows is a first-class platform again')
    expect(entry.releaseNotes).toContain('Linux media staging is safe against inode reuse')
    expect(entry.releaseNotes).toContain('Concurrent identical media ingests always deduplicate')
  })

  it('bundles the current 1.8.4 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.4' }, null)
    expect(entry).toMatchObject({
      version: '1.8.4',
      releaseDate: '2026-07-16'
    })
    expect(entry.releaseNotes).toContain('Transcript scrolling stays under the reader\'s control')
    expect(entry.releaseNotes).toContain('Concurrent Ensemble seats no longer collide')
    expect(entry.releaseNotes).toContain('Sidebar update pill stays inside the fixed chrome band')
    expect(entry.releaseNotes).toContain('Jump to latest')
  })

  it('bundles the frozen 1.8.5 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.5' }, null)
    expect(entry).toMatchObject({
      version: '1.8.5',
      releaseDate: '2026-07-20'
    })
    expect(entry.releaseNotes).toContain('Kimi ACP sessions can resume as durable, isolated seats')
    expect(entry.releaseNotes).toContain('Cursor runs again under Path-B contained native sandbox')
    expect(entry.releaseNotes).toContain('Needs your input surfaces pending agent questions')
    expect(entry.releaseNotes).toContain('canvas_eval')
  })

  it('bundles the frozen 1.8.7 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.7' }, null)
    expect(entry).toMatchObject({
      version: '1.8.7',
      releaseDate: '2026-07-22'
    })
    expect(entry.releaseNotes).toContain('Blackboard posts can land in their intended section')
    expect(entry.releaseNotes).toContain('Settled transcript activity folds into readable one-line summaries')
    expect(entry.releaseNotes).toContain('welcome usage heatmap can build a full 90-day view')
    expect(entry.releaseNotes).toContain('File changes display official provider marks')
  })

  it('bundles the frozen 1.8.8 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.8' }, null)
    expect(entry).toMatchObject({
      version: '1.8.8',
      releaseDate: '2026-07-24'
    })
    expect(entry.releaseNotes).toContain('AntiGravity joins the provider roster')
    expect(entry.releaseNotes).toContain('estimated-spend meter with a soft monthly budget')
    expect(entry.releaseNotes).toContain('ChatGPT composer shell')
    expect(entry.releaseNotes).toContain('Live token telemetry while providers work')
    expect(entry.releaseNotes).toContain('Closing the window no longer ends active runs')
    expect(entry.releaseNotes).toContain('Read-only plans can run `git status`')
  })

  it('bundles the frozen 1.8.9 release notes (narrative format)', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.9' }, null)
    expect(entry).toMatchObject({
      version: '1.8.9',
      releaseDate: '2026-07-24'
    })
    // 1.8.9 is written as a story (themed sections, no Added/Changed/Fixed) —
    // pin the narrative beats rather than taxonomy headers.
    expect(entry.releaseNotes).toContain('A room of their own')
    expect(entry.releaseNotes).toContain('isolated worktree before dispatch')
    expect(entry.releaseNotes).toContain('Watch this PR')
    expect(entry.releaseNotes).toContain('AntiGravity takes a full seat')
    expect(entry.releaseNotes).toContain('Claude Opus 5')
    // Wrap-safe: the source hard-wraps between "Work" and "Session".
    expect(entry.releaseNotes).toContain('Session mode retires in favor of the primitives')
    expect(entry.releaseNotes).toContain('folds instead of jumping')
  })

  it('bundles the current 1.9.0 release notes (narrative format)', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.9.0' }, null)
    expect(entry).toMatchObject({
      version: '1.9.0',
      releaseDate: '2026-07-26'
    })
    // 1.9.0 continues the story format and evolves 1.8.9's separate rooms
    // into a connected workshop. Pin the user-facing beats, not taxonomy.
    expect(entry.releaseNotes).toContain('connects those rooms into a')
    expect(entry.releaseNotes).toContain('Branches come back as candidates')
    expect(entry.releaseNotes).toContain('isolated worktree')
    expect(entry.releaseNotes).toContain('Threads can knock on another door')
    expect(entry.releaseNotes).toContain('Office dock')
    expect(entry.releaseNotes).toContain('stand down while a human is driving')
    expect(entry.releaseNotes).toContain('must never target')
    expect(entry.releaseNotes).toContain('surface you approved')
    expect(entry.releaseNotes).toContain('is not rewritten')
    expect(entry.releaseNotes).toContain('Pi opens the model bench')
    expect(entry.releaseNotes).toContain("actual upstream's hue")
    expect(entry.releaseNotes).toContain('Mistral gets its own door')
    expect(entry.releaseNotes).toContain('vibe-acp 2.22.0')
    expect(entry.releaseNotes).toContain('The workshop can wear your colours')
    expect(entry.releaseNotes).toContain('theme_tokens_set')
    expect(entry.releaseNotes).toContain('Every provider leaves a clearer receipt')
    expect(entry.releaseNotes).toContain('The phone keeps the same map')
    expect(entry.releaseNotes).toContain('keeps first-party observation off')
    expect(entry.releaseNotes).toContain('Share minimal activity')
    expect(entry.releaseNotes).toContain('neither choice removes a feature')
  })

  it('formats full changelog arrays from electron-updater metadata', () => {
    expect(
      formatReleaseNotes([
        { version: '1.0.73', note: 'New update UI.' },
        { version: '1.0.72', note: null }
      ])
    ).toBe('## 1.0.73\nNew update UI.')
  })

  it('prefers live update metadata over pending changelog snapshots', () => {
    const entry = resolveChangelogEntry(
      {
        currentVersion: '1.0.72',
        pendingUpdateChangelog: {
          version: '1.0.72',
          releaseNotes: 'Current app.'
        }
      },
      {
        status: 'available',
        enabled: true,
        channel: 'stable',
        latestVersion: '1.0.73',
        releaseNotes: 'Available app.'
      }
    )
    expect(entry).toMatchObject({
      version: '1.0.73',
      releaseNotes: 'Available app.'
    })
  })

  it('ignores stale pending changelog snapshots after the app has moved past them', () => {
    const entry = resolveChangelogEntry(
      {
        currentVersion: '1.2.0',
        pendingUpdateChangelog: {
          version: '1.0.75',
          releaseNotes: 'Old downloaded update.'
        }
      },
      null,
      [
        '# Changelog',
        '',
        '## 1.2.0 - 2026-06-07',
        'Current bundled notes.',
        '',
        '## 1.0.75 - 2026-06-05',
        'Old bundled notes.'
      ].join('\n')
    )
    expect(entry).toMatchObject({
      version: '1.2.0',
      releaseNotes: 'Current bundled notes.'
    })
  })

  it('keeps pending downloaded update notes while they are newer than the running app', () => {
    const entry = resolveChangelogEntry(
      {
        currentVersion: '1.0.74',
        pendingUpdateChangelog: {
          version: '1.0.75',
          releaseNotes: 'Downloaded update.'
        }
      },
      null,
      '# Changelog\n\n## 1.0.74 - 2026-06-05\nCurrent bundled notes.'
    )
    expect(entry).toMatchObject({
      version: '1.0.75',
      releaseNotes: 'Downloaded update.'
    })
  })
})
