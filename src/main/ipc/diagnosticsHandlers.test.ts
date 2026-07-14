import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ProductOperationsStatus } from '../store/types'
import {
  assertProductAuditBundleVerificationSize,
  PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES,
  SECONDARY_RENDERER_CRASH_REPORT_LIMIT,
  registerDiagnosticsHandlers
} from './diagnosticsHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
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

function createDeps() {
  const status: ProductOperationsStatus = {
    runtime: {
      version: '1.0.0',
      node: '20.0.0'
    },
    recentCrashes: [],
    config: {},
    capabilities: [],
    isHealthy: true
  } as unknown as ProductOperationsStatus

  const deps = {
    getProductOperationsStatus: vi.fn(async () => status),
    getProductCrashes: vi.fn(() => [] as unknown[]),
    recordProductCrash: vi.fn((input) => ({
      ...input,
      id: 'crash-1',
      occurredAt: new Date().toISOString()
    })),
    exportProductDiagnostics: vi.fn(async (requestedPath?: string) => ({
      path: requestedPath || '/tmp/diagnostics.json',
      kind: 'diagnostics-exported'
    })),
    exportProductAuditBundle: vi.fn(async (request?: { path?: string }) => ({
      path: request?.path || '/tmp/audit-bundle.json',
      kind: 'audit-bundle-exported'
    })),
    verifyProductAuditBundle: vi.fn(async (request?: { path?: string }) => ({
      path: request?.path || '/tmp/audit-bundle.json',
      kind: 'audit-bundle-verified'
    })),
    purgeProductAuditRetention: vi.fn((request?: { dryRun?: boolean }) => ({
      ok: true,
      dryRun: request?.dryRun !== false
    })),
    repairProductInstall: vi.fn(async () => status),
    getAppShellStatsSnapshot: vi.fn(() => ({ isActive: false, polls: 1 })),
    getAppVersion: vi.fn(() => '1.2.3'),
    getUserDataPath: vi.fn(() => '/tmp/user-data'),
    appendBugReport: vi.fn(async (_path, _submission) => ({
      path: '/tmp/bug-report.json',
      sizeWarning: false,
      totalBytes: 123
    })),
    isMainRendererSender: vi.fn(() => true),
    nowMs: vi.fn(() => 1_000)
  }
  return deps
}

type BugReportSubmissionInput = {
  title?: string
  description?: string
  expected?: string
  severity?: string
  context?: {
    timestamp?: string
    version?: string
  }
  [key: string]: unknown
}

describe('registerDiagnosticsHandlers', () => {
  it('bounds audit bundle verification before the main process parses JSON', () => {
    expect(() =>
      assertProductAuditBundleVerificationSize(PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES)
    ).not.toThrow()
    expect(() =>
      assertProductAuditBundleVerificationSize(PRODUCT_AUDIT_BUNDLE_MAX_VERIFY_BYTES + 1)
    ).toThrow('Audit bundle exceeds')
    expect(() => assertProductAuditBundleVerificationSize(Number.NaN)).toThrow(
      'could not be verified safely'
    )
  })

  it('registers product/diagnostics IPC channels', () => {
    registerDiagnosticsHandlers(createDeps())

    expect(handlerFor('get-product-operations-status')).toBeTypeOf('function')
    expect(handlerFor('get-product-crashes')).toBeTypeOf('function')
    expect(handlerFor('record-product-crash')).toBeTypeOf('function')
    expect(handlerFor('export-product-diagnostics')).toBeTypeOf('function')
    expect(handlerFor('export-product-audit-bundle')).toBeTypeOf('function')
    expect(handlerFor('verify-product-audit-bundle')).toBeTypeOf('function')
    expect(handlerFor('purge-product-audit-retention')).toBeTypeOf('function')
    expect(handlerFor('repair-product-install')).toBeTypeOf('function')
    expect(handlerFor('app-shell-stats:snapshot')).toBeTypeOf('function')
    expect(handlerFor('get-app-version')).toBeTypeOf('function')
    expect(handlerFor('submit-bug-report')).toBeTypeOf('function')
  })

  it('routes product operations and crash queries through deps', async () => {
    const deps = createDeps()
    registerDiagnosticsHandlers(deps)

    await handlerFor('get-product-operations-status')({})
    expect(deps.getProductOperationsStatus).toHaveBeenCalledOnce()

    await handlerFor('get-product-crashes')({}, { source: 'main' })
    expect(deps.getProductCrashes).toHaveBeenCalledWith({ source: 'main' })

    await handlerFor('export-product-diagnostics')({}, '/tmp/custom.json')
    expect(deps.exportProductDiagnostics).toHaveBeenCalledWith('/tmp/custom.json')

    await handlerFor('export-product-audit-bundle')({}, {
      path: '/tmp/audit.json',
      redactionMode: 'default',
      filter: { chatId: 'chat-1' }
    })
    expect(deps.exportProductAuditBundle).toHaveBeenCalledWith({
      path: '/tmp/audit.json',
      redactionMode: 'default',
      filter: { chatId: 'chat-1' }
    })

    await handlerFor('verify-product-audit-bundle')({}, { path: '/tmp/audit.json' })
    expect(deps.verifyProductAuditBundle).toHaveBeenCalledWith({ path: '/tmp/audit.json' })

    await handlerFor('purge-product-audit-retention')({}, {
      dryRun: false,
      policy: { enabled: true }
    })
    expect(deps.purgeProductAuditRetention).toHaveBeenCalledWith({
      dryRun: false,
      policy: { enabled: true }
    })

    await handlerFor('repair-product-install')({})
    expect(deps.repairProductInstall).toHaveBeenCalledOnce()
  })

  it('rejects unsupported audit-bundle sensitive export modes before export', async () => {
    const deps = createDeps()
    registerDiagnosticsHandlers(deps)

    await expect(
      handlerFor('export-product-audit-bundle')({}, {
        path: '/tmp/audit-sensitive.json',
        redactionMode: 'sensitive'
      })
    ).rejects.toThrow('Sensitive audit-bundle export modes are not available.')
    expect(deps.exportProductAuditBundle).not.toHaveBeenCalled()
  })

  it('defaults record-product-crash source when missing', () => {
    const deps = createDeps()
    registerDiagnosticsHandlers(deps)

    const result = handlerFor('record-product-crash')({}, { id: 'event-1', severity: 'warning', message: 'x' })
    expect(result).toMatchObject({ id: 'crash-1' })
    expect(deps.recordProductCrash).toHaveBeenCalledWith({
      id: 'event-1',
      severity: 'warning',
      message: 'x',
      source: 'renderer'
    })
  })

  it('derives secondary crash identity and bounds cyclic metadata before persistence', () => {
    const deps = createDeps()
    deps.isMainRendererSender.mockReturnValue(false)
    registerDiagnosticsHandlers(deps)
    const metadata: Record<string, unknown> = {
      filename: '/work/Test 1/src/App.tsx',
      accessToken: 'plaintext-secret'
    }
    metadata.self = metadata

    handlerFor('record-product-crash')(
      { sender: { id: 42 } },
      {
        id: 'forged-id',
        source: 'main',
        severity: 'fatal',
        occurredAt: '1999-01-01T00:00:00.000Z',
        appVersion: 'forged-version',
        platform: 'forged-platform',
        arch: 'forged-arch',
        message: 'Renderer exploded',
        metadata
      }
    )

    expect(deps.recordProductCrash).toHaveBeenCalledWith({
      source: 'renderer',
      severity: 'error',
      message: 'Renderer exploded',
      metadata: {
        filename: '/work/Test 1/src/App.tsx',
        accessToken: '[redacted]',
        self: '[circular]'
      }
    })
  })

  it('rate-limits secondary crash telemetry per sender while leaving main reports exempt', () => {
    const secondaryDeps = createDeps()
    secondaryDeps.isMainRendererSender.mockReturnValue(false)
    registerDiagnosticsHandlers(secondaryDeps)
    const secondaryEvent = { sender: { id: 77 } }
    for (let index = 0; index < SECONDARY_RENDERER_CRASH_REPORT_LIMIT; index += 1) {
      handlerFor('record-product-crash')(secondaryEvent, {
        source: 'renderer',
        severity: 'error',
        message: `error ${index}`
      })
    }
    expect(() =>
      handlerFor('record-product-crash')(secondaryEvent, {
        source: 'renderer',
        severity: 'error',
        message: 'one too many'
      })
    ).toThrow('rate limit exceeded')
    expect(secondaryDeps.recordProductCrash).toHaveBeenCalledTimes(
      SECONDARY_RENDERER_CRASH_REPORT_LIMIT
    )

    mockedHandle.mockReset()
    const mainDeps = createDeps()
    registerDiagnosticsHandlers(mainDeps)
    for (let index = 0; index <= SECONDARY_RENDERER_CRASH_REPORT_LIMIT; index += 1) {
      handlerFor('record-product-crash')(
        { sender: { id: 1 } },
        { source: 'renderer', severity: 'error', message: `main ${index}` }
      )
    }
    expect(mainDeps.recordProductCrash).toHaveBeenCalledTimes(
      SECONDARY_RENDERER_CRASH_REPORT_LIMIT + 1
    )
  })

  it('returns app version and falls back to unknown when blank', () => {
    const deps = createDeps()
    const getAppVersion = vi.spyOn(deps, 'getAppVersion')
    registerDiagnosticsHandlers(deps)

    expect(handlerFor('get-app-version')({})).toBe('1.2.3')
    getAppVersion.mockReturnValue('')
    expect(handlerFor('get-app-version')({})).toBe('unknown')
  })

  it('submits bug reports with stamped version + timestamp', async () => {
    const deps = createDeps()
    registerDiagnosticsHandlers(deps)

    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload: BugReportSubmissionInput = {
      kind: 'bug-report',
      context: { timestamp: '', version: '0.0.0' }
    }

    const result = await handlerFor('submit-bug-report')({}, payload)
    expect(result).toMatchObject({ ok: true, path: '/tmp/bug-report.json' })
    expect(deps.appendBugReport).toHaveBeenCalledWith('/tmp/user-data', expect.objectContaining({
      kind: 'bug-report',
      context: expect.objectContaining({
        timestamp: expect.any(String),
        version: '1.2.3'
      })
    }))
    expect(warningSpy).not.toHaveBeenCalled()
    warningSpy.mockRestore()
  })

  it('returns failure payload on submit-bug-report errors and logs', async () => {
    const deps = createDeps()
    deps.appendBugReport = vi.fn(async () => {
      throw new Error('append failed')
    })
    registerDiagnosticsHandlers(deps)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload: BugReportSubmissionInput = {
      kind: 'bug-report',
      context: {}
    }

    const result = await handlerFor('submit-bug-report')({}, payload)
    expect(result).toEqual({ ok: false, error: 'append failed' })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
