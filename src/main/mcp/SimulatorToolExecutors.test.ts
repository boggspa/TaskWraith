import { describe, expect, it, vi } from 'vitest'
import {
  createSimulatorToolExecutors,
  isSimulatorMcpToolName,
  SIMULATOR_MCP_TOOL_NAMES
} from './SimulatorToolExecutors'
import type { SimulatorHostControl } from '../simulator/SimulatorHostControl'
import type { IdbClient } from '../simulator/IdbClient'
import { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import type { SimulatorCapabilityStatus } from '../../shared/simulatorCanvas'
import { TASKWRAITH_TOOL_ACTIONS } from '../../shared/providerActionTaxonomy'
import { MCP_AUTO_ALLOWED_TOOLS } from './McpAutoAllowedTools'

const statusFixture: SimulatorCapabilityStatus = {
  platform: 'darwin',
  installed: true,
  simctlAvailable: true,
  simulatorAppPath: '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
  xcodeAppPath: '/Applications/Xcode.app',
  bootedDevices: [
    { udid: '11111111-1111-1111-1111-111111111111', name: 'iPhone 16', state: 'Booted' }
  ],
  availableDevices: [
    { udid: '11111111-1111-1111-1111-111111111111', name: 'iPhone 16', state: 'Booted' }
  ],
  installHint: '',
  docsUrl: 'https://developer.apple.com/xcode/'
}

const runCtx = { appChatId: 'chat-1', appRunId: 'run-1', participantId: 'seat-a' }
const udid = '11111111-1111-1111-1111-111111111111'

function fakeIdb(
  overrides: Partial<Pick<IdbClient, 'isAvailable' | 'describeAll' | 'hardwareButton' | 'rotate'>> = {}
): Pick<IdbClient, 'isAvailable' | 'describeAll' | 'hardwareButton' | 'rotate'> {
  return {
    isAvailable: () => true,
    describeAll: vi.fn(async () => ({
      ok: true as const,
      tree: [{ AXLabel: 'Home' }],
      truncated: false
    })),
    hardwareButton: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    rotate: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    ...overrides
  }
}

function fakeHost(
  overrides: Partial<SimulatorHostControl> = {}
): Pick<
  SimulatorHostControl,
  'status' | 'openSimulatorApp' | 'boot' | 'install' | 'launch' | 'terminate' | 'screenshot'
> {
  const status = {
    ...statusFixture,
    simulatorAppRunning: false,
    ownedByUs: false,
    ownedPid: null
  }
  return {
    status: vi.fn(async () => status),
    openSimulatorApp: vi.fn(async () => ({ ok: true, status })),
    boot: vi.fn(async (udid: string) => ({ ok: true, udid })),
    install: vi.fn(async (udid: string) => ({ ok: true, udid })),
    launch: vi.fn(async (udid: string) => ({ ok: true, udid })),
    terminate: vi.fn(async (udid: string) => ({ ok: true, udid })),
    screenshot: vi.fn(async (udid: string) => ({
      ok: true,
      udid,
      frame: {
        pngBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        width: 2,
        height: 2,
        capturedAt: '2026-08-07T00:00:00.000Z',
        udid
      }
    })),
    ...overrides
  } as Pick<
    SimulatorHostControl,
    'status' | 'openSimulatorApp' | 'boot' | 'install' | 'launch' | 'terminate' | 'screenshot'
  >
}

describe('SimulatorToolExecutors', () => {
  it('recognises the catalog simulator tool names', () => {
    for (const name of SIMULATOR_MCP_TOOL_NAMES) {
      expect(isSimulatorMcpToolName(name)).toBe(true)
    }
    expect(isSimulatorMcpToolName('canvas_status')).toBe(false)
  })

  it('simulator_status returns host.status() without approval taxonomy service', async () => {
    const hostControl = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease: new SimulatorControllerLease(),
      idb: fakeIdb()
    })
    const result = await executeSimulatorTool('simulator_status', {}, {}, 'claude')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'simulator_status',
      status: statusFixture
    })
    expect(hostControl.status).toHaveBeenCalledOnce()
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_status.service).toBe('mcpTools')
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('simulator_status')).toBe(true)
  })

  it('simulator_open / boot / install / launch / terminate require run context + lease', async () => {
    const hostControl = fakeHost()
    const controllerLease = new SimulatorControllerLease({ createId: () => 'tok-run' })
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease,
      idb: fakeIdb()
    })

    expect((await executeSimulatorTool('simulator_open', {}, {}, 'codex')).isError).toBe(true)
    expect(hostControl.openSimulatorApp).not.toHaveBeenCalled()

    expect(
      (await executeSimulatorTool('simulator_open', {}, runCtx, 'codex')).isError
    ).toBeFalsy()
    expect(hostControl.openSimulatorApp).toHaveBeenCalledWith({
      chatId: 'chat-1',
      controllerTokenId: 'tok-run'
    })

    expect(
      (await executeSimulatorTool('simulator_boot', { udid }, runCtx, 'codex')).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_install',
          { udid, appPath: '/tmp/Demo.app' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_launch',
          { udid, bundleId: 'com.example.Demo' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_terminate',
          { udid, bundleId: 'com.example.Demo' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, udid })
    for (const tool of [
      'simulator_open',
      'simulator_boot',
      'simulator_install',
      'simulator_launch',
      'simulator_terminate'
    ] as const) {
      expect(TASKWRAITH_TOOL_ACTIONS[tool].service).toBe('simulatorCanvas')
      expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has(tool)).toBe(false)
    }
  })

  it('fails when another run already holds the controller', async () => {
    const hostControl = fakeHost()
    const controllerLease = new SimulatorControllerLease({ createId: () => 'tok-1' })
    expect(controllerLease.mint({ chatId: 'chat-1', runId: 'run-holder' }).ok).toBe(true)
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease,
      idb: fakeIdb()
    })
    const result = await executeSimulatorTool(
      'simulator_boot',
      { udid },
      { appChatId: 'chat-1', appRunId: 'run-other' },
      'codex'
    )
    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error || '')).toMatch(/another run/i)
    expect(hostControl.boot).not.toHaveBeenCalled()
  })

  it('simulator_screenshot returns an image block and keeps base64 out of structuredContent', async () => {
    const hostControl = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease: new SimulatorControllerLease(),
      idb: fakeIdb()
    })
    const result = await executeSimulatorTool(
      'simulator_screenshot',
      { udid },
      runCtx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'simulator_screenshot',
      mimeType: 'image/png',
      width: 2,
      height: 2
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('pngBase64')
    expect(result.content?.some((block) => block.type === 'image')).toBe(true)
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_screenshot.service).toBe('simulatorCanvas')
  })

  it('requires udid / appPath / bundleId before calling the host', async () => {
    const hostControl = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease: new SimulatorControllerLease(),
      idb: fakeIdb()
    })
    expect((await executeSimulatorTool('simulator_boot', {}, runCtx, 'claude')).isError).toBe(true)
    expect(hostControl.boot).not.toHaveBeenCalled()
    expect(
      (await executeSimulatorTool('simulator_install', { udid: 'booted' }, runCtx, 'claude'))
        .isError
    ).toBe(true)
    expect(hostControl.install).not.toHaveBeenCalled()
    expect(
      (await executeSimulatorTool('simulator_launch', { udid: 'booted' }, runCtx, 'claude')).isError
    ).toBe(true)
    expect(hostControl.launch).not.toHaveBeenCalled()
  })

  it('simulator_inspect is auto-allowed observation and returns a truncated tree without a lease', async () => {
    const idb = fakeIdb()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease: new SimulatorControllerLease(),
      idb
    })
    const result = await executeSimulatorTool('simulator_inspect', { udid }, {}, 'claude')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'simulator_inspect',
      udid,
      tree: [{ AXLabel: 'Home' }],
      truncated: false
    })
    expect(idb.describeAll).toHaveBeenCalledWith(udid)
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_inspect.service).toBe('mcpTools')
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('simulator_inspect')).toBe(true)
  })

  it('simulator_button / simulator_rotate require lease + idb and validate allowlists', async () => {
    const idb = fakeIdb()
    const controllerLease = new SimulatorControllerLease({ createId: () => 'tok-hw' })
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease,
      idb
    })

    expect(
      (await executeSimulatorTool('simulator_button', { udid, button: 'HOME' }, {}, 'codex'))
        .isError
    ).toBe(true)
    expect(idb.hardwareButton).not.toHaveBeenCalled()

    expect(
      (
        await executeSimulatorTool(
          'simulator_button',
          { udid, button: 'HOME' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, button: 'HOME' })
    expect(idb.hardwareButton).toHaveBeenCalledWith(udid, 'HOME')

    expect(
      (
        await executeSimulatorTool(
          'simulator_rotate',
          { udid, direction: 'clockwise' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, direction: 'clockwise' })
    expect(idb.rotate).toHaveBeenCalledWith(udid, 'clockwise')

    expect(
      (
        await executeSimulatorTool(
          'simulator_button',
          { udid, button: 'POWER' },
          runCtx,
          'codex'
        )
      ).isError
    ).toBe(true)
    expect(
      (
        await executeSimulatorTool(
          'simulator_rotate',
          { udid, direction: 'upside-down' },
          runCtx,
          'codex'
        )
      ).isError
    ).toBe(true)

    for (const tool of ['simulator_button', 'simulator_rotate'] as const) {
      expect(TASKWRAITH_TOOL_ACTIONS[tool].service).toBe('simulatorCanvas')
      expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has(tool)).toBe(false)
    }
  })
})
