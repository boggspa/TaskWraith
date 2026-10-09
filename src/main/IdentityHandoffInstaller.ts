import { spawn } from 'node:child_process'
import { chmodSync } from 'node:fs'
import type { IdentityHandoffArtifact, IdentityHandoffLaunchResult } from './IdentityHandoffService'
import {
  isValidPackagedIsolatedInstanceId,
  PACKAGED_ISOLATED_INSTANCE_ARG
} from './InstanceLaunchPosture'

export type IdentityHandoffRelaunch = (options: { execPath: string; args: string[] }) => void

export interface IdentityHandoffInstallerOptions {
  relaunch?: IdentityHandoffRelaunch
  isolatedInstanceId?: string
  spawn?: typeof spawn
}

/** A portable target starts only after Electron has finished shutting down beta. */
export function launchIdentityHandoffInstaller(
  filePath: string,
  artifact: IdentityHandoffArtifact,
  options: IdentityHandoffInstallerOptions = {}
): Promise<IdentityHandoffLaunchResult> {
  if (artifact.launchKind === 'appimage') {
    try {
      if (!options.relaunch) throw new Error('The application restart service is unavailable.')
      // The pinned public AppImage must also start on beta installations that
      // used a deb and have no FUSE device/library. The runtime consumes this
      // argument, then forwards only the app's own isolated-profile selector.
      const args: string[] = ['--appimage-extract-and-run']
      if (options.isolatedInstanceId !== undefined) {
        if (!isValidPackagedIsolatedInstanceId(options.isolatedInstanceId)) {
          throw new Error('The isolated instance selector is invalid.')
        }
        args.push(`${PACKAGED_ISOLATED_INSTANCE_ARG}${options.isolatedInstanceId}`)
      }
      chmodSync(filePath, 0o700)
      // Electron's relaunch helper waits for the current process to exit. A
      // detached direct spawn can lose the shared-profile single-instance race.
      options.relaunch({ execPath: filePath, args })
      return Promise.resolve({ ok: true })
    } catch (error) {
      return Promise.resolve({ ok: false, error: launchError(error) })
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: IdentityHandoffLaunchResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({ ok: false, error: 'The operating system did not acknowledge installer launch.' }),
      10_000
    )
    timer.unref?.()
    try {
      const child = (options.spawn || spawn)(
        artifact.launchKind === 'dmg' ? '/usr/bin/open' : filePath,
        artifact.launchKind === 'dmg' ? [filePath] : [],
        { detached: true, stdio: 'ignore', shell: false }
      )
      child.once('error', (error) => finish({ ok: false, error: launchError(error) }))
      child.once('spawn', () => {
        child.unref()
        if (artifact.launchKind !== 'dmg') finish({ ok: true })
      })
      if (artifact.launchKind === 'dmg') {
        child.once('exit', (code) =>
          finish(
            code === 0
              ? { ok: true }
              : { ok: false, error: `The disk image could not be opened (exit ${String(code)}).` }
          )
        )
      }
    } catch (error) {
      finish({ ok: false, error: launchError(error) })
    }
  })
}

function launchError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
