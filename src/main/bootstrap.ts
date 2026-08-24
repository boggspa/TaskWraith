// MUST stay first — configures the unpackaged/private userData path before the
// singleton lock is acquired or any other Electron module can resolve it.
import './devAppName'

import * as fs from 'node:fs'
import os from 'node:os'
import { basename, isAbsolute, parse, resolve } from 'node:path'
import { app, protocol } from 'electron'
import type { Event } from 'electron'
import { isTaskWraithHelperProcess } from './HelperProcessPresentation'
import { migrateLegacyUserDataSync } from './LegacyUserDataMigration'
import { bootstrapMainProcess, type SecondInstanceEventArguments } from './MainProcessBootstrap'
import {
  createHostExternalPreparation,
  type HostExternalPreparation
} from './host/HostExternalPreparation'
import { resolveHostExternalLaunch } from './host/HostExternalLaunchResolver'
import { HostExternalSupervisor } from './host/HostExternalSupervisor'
import { TW_MEDIA_PRIVILEGE } from './media/TwMediaProtocol'
import { MESH_ASSET_PRIVILEGE } from './mesh/MeshAssetProtocol'

function configureElectronBeforeReady(): void {
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  const rendererHeapCeilingMaxMb = 8_192
  const rendererHeapCeilingMinMb = 4_096
  const hostMemoryMb = Math.floor(os.totalmem() / (1024 * 1024))
  const rendererHeapCeilingMb = Math.min(rendererHeapCeilingMaxMb, Math.floor(hostMemoryMb / 8))
  if (rendererHeapCeilingMb >= rendererHeapCeilingMinMb) {
    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${rendererHeapCeilingMb}`)
  }
  protocol.registerSchemesAsPrivileged([TW_MEDIA_PRIVILEGE, MESH_ASSET_PRIVILEGE])
}

configureElectronBeforeReady()

function subscribeSecondInstance(
  listener: (...args: SecondInstanceEventArguments) => void
): () => void {
  const handler = (
    event: Event,
    argv: string[],
    workingDirectory: string,
    additionalData: unknown
  ) => listener(event, argv, workingDirectory, additionalData)
  app.on('second-instance', handler)
  return () => app.removeListener('second-instance', handler)
}

function canonicalProfilePath(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !isAbsolute(value)) {
    throw new Error('External Host requires a canonical profile directory.')
  }
  const resolved = resolve(value)
  if (resolved === parse(resolved).root) {
    throw new Error('External Host refuses a filesystem-root profile.')
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const canonical = fs.realpathSync(resolved)
  if (canonical === parse(canonical).root) {
    throw new Error('External Host refuses a filesystem-root profile.')
  }
  return canonical
}

function developmentRepoRoot(): string {
  const value = app.getAppPath() || process.cwd()
  if (typeof value !== 'string' || value.trim() !== value || !isAbsolute(value)) {
    throw new Error('External Host requires an absolute development repository path.')
  }
  return resolve(value)
}

function developmentNodeExecutable(repoRoot: string): string {
  for (const value of [process.env.npm_node_execpath, process.env.NODE]) {
    if (typeof value === 'string' && value.trim() === value && isAbsolute(value))
      return resolve(value)
  }
  return resolve(
    repoRoot,
    'build',
    'tui-runtime',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'node.exe' : 'node'
  )
}

function isOrdinaryNodeExecutable(value: string): boolean {
  const name = basename(value).toLowerCase()
  return (name === 'node' || name === 'node.exe') && !/electron/i.test(value)
}

function createExternalHostPreparation(): HostExternalPreparation {
  const profilePath = canonicalProfilePath(app.getPath('userData'))
  const packaged = app.isPackaged
  const repoRoot = packaged ? undefined : developmentRepoRoot()
  const nodeExecutable = repoRoot ? developmentNodeExecutable(repoRoot) : undefined
  return createHostExternalPreparation({
    profilePath,
    migrateLegacyUserData: () => {
      const migration = migrateLegacyUserDataSync({
        userDataPath: profilePath,
        log: {
          log: () => console.log('[rebrand-migration] legacy userData copied'),
          warn: () => console.warn('[rebrand-migration] legacy userData migration skipped')
        }
      })
      if (migration.state === 'failed' || migration.state === 'invalid_profile') {
        throw new Error('Legacy userData migration did not complete safely.')
      }
    },
    createSupervisor: () =>
      new HostExternalSupervisor({
        profilePath,
        resolveLaunch: () =>
          resolveHostExternalLaunch({
            profilePath,
            packaged,
            ...(packaged ? { resourcesPath: process.resourcesPath } : { repoRoot, nodeExecutable }),
            env: process.env,
            isOrdinaryNode: isOrdinaryNodeExecutable
          })
      })
  })
}

let externalHostPreparation: HostExternalPreparation | null = null
void bootstrapMainProcess({
  isHelperProcess: isTaskWraithHelperProcess(process.argv, process.env),
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  // index.ts retains its existing guard during this extraction. Electron's
  // requestSingleInstanceLock is idempotent for the process that owns it.
  prepareMainProcess: async () => {
    externalHostPreparation = createExternalHostPreparation()
    await externalHostPreparation.prepare()
  },
  cleanupPreparedMainProcess: async () => {
    await externalHostPreparation?.cleanup()
  },
  loadMainProcess: () => import('./index'),
  subscribeSecondInstance,
  replaySecondInstance: ([event, argv, workingDirectory, additionalData]) => {
    app.emit('second-instance', event as Event, argv, workingDirectory, additionalData)
  },
  log: (message) => console.log(message)
}).catch((error) => {
  console.error('[main-bootstrap] failed to load the main process', error)
  app.exit(1)
})
