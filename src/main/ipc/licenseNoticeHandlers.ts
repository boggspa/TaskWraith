import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, shell } from 'electron'
import type {
  LicenseNoticeKind,
  LicenseNoticeStatus,
  OpenLicenseNoticeResult
} from '../../shared/licenseNotices'

const NOTICE_FILES: Record<LicenseNoticeKind, string> = {
  taskwraith: 'TASKWRAITH-LICENSE.txt',
  'third-party': 'THIRD-PARTY-NOTICES.txt',
  chromium: 'LICENSES.chromium.html'
}
const INVENTORY_FILE = 'THIRD-PARTY-NOTICES.json'

interface NoticeInventory {
  schemaVersion?: unknown
  source?: unknown
  app?: { version?: unknown; license?: unknown; sha256?: unknown }
  summary?: Record<string, unknown>
  files?: {
    thirdPartyNoticesSha256?: unknown
    chromiumNoticesSha256?: unknown
  }
}

export interface LicenseNoticeHandlerDeps {
  resourcesPath: () => string
  openPath: (filePath: string) => Promise<string>
}

const defaultDeps: LicenseNoticeHandlerDeps = {
  resourcesPath: () => process.resourcesPath,
  openPath: (filePath) => shell.openPath(filePath)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function readSummary(value: Record<string, unknown> | undefined) {
  const packageIdentityCount = value?.packageIdentityCount
  const packageInstanceCount = value?.packageInstanceCount
  const reviewedOverrideCount = value?.reviewedOverrideCount
  const upstreamLimitationCount = value?.upstreamLimitationCount
  if (
    !isNonNegativeInteger(packageIdentityCount) ||
    !isNonNegativeInteger(packageInstanceCount) ||
    packageInstanceCount < 1 ||
    !isNonNegativeInteger(reviewedOverrideCount) ||
    !isNonNegativeInteger(upstreamLimitationCount)
  ) {
    throw new Error('Packaged legal-notice inventory has an invalid summary.')
  }
  return {
    packageIdentityCount,
    packageInstanceCount,
    reviewedOverrideCount,
    upstreamLimitationCount
  }
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Packaged legal-notice inventory has no valid ${label} hash.`)
  }
  return value
}

function exactNoticeFile(resourcesPath: string, fileName: string): string {
  const filePath = path.join(resourcesPath, fileName)
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`Packaged legal notice is not a non-empty regular file: ${fileName}`)
  }
  return filePath
}

function unavailableStatus(message: string): LicenseNoticeStatus {
  return {
    exactPackagedTree: false,
    appVersion: app.isPackaged ? app.getVersion() : null,
    appLicense: null,
    summary: null,
    available: { taskwraith: false, 'third-party': false, chromium: false },
    message
  }
}

export function readLicenseNoticeStatus(resourcesPath: string): LicenseNoticeStatus {
  try {
    const inventoryPath = exactNoticeFile(resourcesPath, INVENTORY_FILE)
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as NoticeInventory
    if (inventory.schemaVersion !== 1 || inventory.source !== 'exact-packaged-app-asar') {
      throw new Error('Packaged legal-notice inventory has an unsupported schema or source.')
    }
    const appLicensePath = exactNoticeFile(resourcesPath, NOTICE_FILES.taskwraith)
    const thirdPartyPath = exactNoticeFile(resourcesPath, NOTICE_FILES['third-party'])
    const chromiumPath = exactNoticeFile(resourcesPath, NOTICE_FILES.chromium)
    const expectedHashes = {
      taskwraith: requireHash(inventory.app?.sha256, 'TaskWraith license'),
      'third-party': requireHash(inventory.files?.thirdPartyNoticesSha256, 'third-party notices'),
      chromium: requireHash(inventory.files?.chromiumNoticesSha256, 'Chromium notices')
    }
    const actualHashes = {
      taskwraith: hashFile(appLicensePath),
      'third-party': hashFile(thirdPartyPath),
      chromium: hashFile(chromiumPath)
    }
    for (const kind of Object.keys(NOTICE_FILES) as LicenseNoticeKind[]) {
      if (expectedHashes[kind] !== actualHashes[kind]) {
        throw new Error(`Packaged ${kind} legal notice failed its integrity check.`)
      }
    }
    return {
      exactPackagedTree: true,
      appVersion: typeof inventory.app?.version === 'string' ? inventory.app.version : null,
      appLicense: typeof inventory.app?.license === 'string' ? inventory.app.license : null,
      summary: readSummary(inventory.summary),
      available: { taskwraith: true, 'third-party': true, chromium: true },
      message: null
    }
  } catch (error) {
    return unavailableStatus(
      app.isPackaged
        ? `Packaged legal notices are unavailable or failed verification: ${error instanceof Error ? error.message : String(error)}`
        : 'Exact legal notices are generated from the staged application during packaging.'
    )
  }
}

function requireNoticeKind(value: unknown): LicenseNoticeKind {
  if (value === 'taskwraith' || value === 'third-party' || value === 'chromium') return value
  throw new TypeError('Unknown legal notice kind.')
}

export function registerLicenseNoticeHandlers(deps: LicenseNoticeHandlerDeps = defaultDeps): void {
  ipcMain.handle('licenses:get-status', () => readLicenseNoticeStatus(deps.resourcesPath()))
  ipcMain.handle(
    'licenses:open-notice',
    async (_event, requestedKind: unknown): Promise<OpenLicenseNoticeResult> => {
      const kind = requireNoticeKind(requestedKind)
      const resourcesPath = deps.resourcesPath()
      const status = readLicenseNoticeStatus(resourcesPath)
      if (!status.available[kind]) {
        return { ok: false, error: status.message || 'Legal notice is unavailable.' }
      }
      try {
        const openError = await deps.openPath(exactNoticeFile(resourcesPath, NOTICE_FILES[kind]))
        return openError ? { ok: false, error: openError } : { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
