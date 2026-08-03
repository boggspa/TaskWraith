import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  readLicenseNoticeStatus,
  registerLicenseNoticeHandlers,
  type LicenseNoticeHandlerDeps
} from './licenseNoticeHandlers'

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '9.9.9' },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(async () => '') }
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const tempRoots: string[] = []

beforeEach(() => mockedHandle.mockReset())
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function packagedNotices(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-notice-ipc-'))
  tempRoots.push(root)
  const files = {
    'TASKWRAITH-LICENSE.txt': 'TaskWraith license\n',
    'THIRD-PARTY-NOTICES.txt': 'Dependency notices\n',
    'LICENSES.chromium.html': '<html>Chromium notices</html>\n'
  }
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents)
  }
  fs.writeFileSync(
    path.join(root, 'THIRD-PARTY-NOTICES.json'),
    JSON.stringify({
      schemaVersion: 1,
      source: 'exact-packaged-app-asar',
      app: {
        version: '9.9.9',
        license: 'Apache-2.0',
        sha256: sha256(files['TASKWRAITH-LICENSE.txt'])
      },
      summary: {
        packageIdentityCount: 10,
        packageInstanceCount: 11,
        reviewedOverrideCount: 2,
        upstreamLimitationCount: 1
      },
      files: {
        thirdPartyNoticesSha256: sha256(files['THIRD-PARTY-NOTICES.txt']),
        chromiumNoticesSha256: sha256(files['LICENSES.chromium.html'])
      }
    })
  )
  return root
}

describe('license notice IPC', () => {
  it('reports verified exact-package coverage and opens only fixed notice paths', async () => {
    const resourcesPath = packagedNotices()
    const deps = {
      resourcesPath: () => resourcesPath,
      openPath: vi.fn<LicenseNoticeHandlerDeps['openPath']>(async () => '')
    }
    registerLicenseNoticeHandlers(deps)

    expect(handlerFor('licenses:get-status')({})).toMatchObject({
      exactPackagedTree: true,
      appVersion: '9.9.9',
      appLicense: 'Apache-2.0',
      summary: { packageInstanceCount: 11, upstreamLimitationCount: 1 },
      available: { taskwraith: true, 'third-party': true, chromium: true }
    })
    await expect(handlerFor('licenses:open-notice')({}, 'third-party')).resolves.toEqual({
      ok: true
    })
    expect(deps.openPath).toHaveBeenCalledWith(path.join(resourcesPath, 'THIRD-PARTY-NOTICES.txt'))
  })

  it('rejects unknown notice kinds before reaching the OS', async () => {
    const resourcesPath = packagedNotices()
    const deps = {
      resourcesPath: () => resourcesPath,
      openPath: vi.fn<LicenseNoticeHandlerDeps['openPath']>(async () => '')
    }
    registerLicenseNoticeHandlers(deps)

    await expect(handlerFor('licenses:open-notice')({}, '../secret')).rejects.toThrow(
      /unknown legal notice kind/i
    )
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('fails closed when a packaged notice no longer matches the inventory', async () => {
    const resourcesPath = packagedNotices()
    fs.appendFileSync(path.join(resourcesPath, 'THIRD-PARTY-NOTICES.txt'), 'tampered\n')
    const deps = {
      resourcesPath: () => resourcesPath,
      openPath: vi.fn<LicenseNoticeHandlerDeps['openPath']>(async () => '')
    }
    registerLicenseNoticeHandlers(deps)

    expect(readLicenseNoticeStatus(resourcesPath)).toMatchObject({
      exactPackagedTree: false,
      available: { taskwraith: false, 'third-party': false, chromium: false },
      message: expect.stringMatching(/failed verification/i)
    })
    await expect(handlerFor('licenses:open-notice')({}, 'third-party')).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/failed verification/i)
    })
    expect(deps.openPath).not.toHaveBeenCalled()
  })
})
