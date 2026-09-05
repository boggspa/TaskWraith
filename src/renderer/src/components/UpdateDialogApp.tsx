import { useEffect, useState } from 'react'
import type { ProductChangelogSnapshot } from '../../../main/store/types'
import { useAppearance } from '../hooks/useAppearance'
import { useUpdateStatus } from '../hooks/useUpdateStatus'
import { ChangelogSheet } from './ChangelogSheet'

export function UpdateDialogApp(): React.JSX.Element {
  useAppearance()
  const update = useUpdateStatus()
  const [changelog, setChangelog] = useState<ProductChangelogSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.api
      .changelogSnapshot()
      .then(setChangelog)
      .catch(() => {})
  }, [])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The update action failed. Please try again.'
      )
    }
  }
  const snapshot = {
    ...(update.snapshot ?? { status: 'idle' as const, enabled: true, channel: 'stable' as const }),
    // The release page remains usable when the updater cannot reach its feed.
    releasePageUrl:
      update.snapshot?.releasePageUrl || 'https://github.com/boggspa/TaskWraith/releases',
    ...(error ? { status: 'error' as const, errorMessage: error } : {}),
    ...(update.snapshot?.status === 'disabled'
      ? {
          feedNote:
            'Update checks are disabled for this configuration. Open release to update manually.'
        }
      : {})
  }

  return (
    <ChangelogSheet
      open
      onDismiss={() => window.close()}
      changelogSnapshot={changelog}
      updateSnapshot={snapshot}
      busy={update.busy}
      onCheckForUpdates={() => run(update.checkForUpdates)}
      onDownloadUpdate={() => run(update.downloadUpdate)}
      onInstallUpdateNow={(options) => run(() => update.installUpdateNow(options))}
    />
  )
}
