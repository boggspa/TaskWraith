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

  it('bundles the current 1.8.1 release notes', () => {
    const entry = resolveChangelogEntry({ currentVersion: '1.8.1' }, null)
    expect(entry).toMatchObject({
      version: '1.8.1',
      releaseDate: '2026-07-12'
    })
    expect(entry.releaseNotes).toContain('Background lanes for Ensemble work')
    expect(entry.releaseNotes).toContain('Remote iPhone actions stay safe when a Mac sleeps')
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
