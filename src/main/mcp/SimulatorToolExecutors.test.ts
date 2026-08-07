import { describe, expect, it, vi } from 'vitest'
import {
  createSimulatorToolExecutors,
  isSimulatorMcpToolName,
  SIMULATOR_MCP_TOOL_NAMES
} from './SimulatorToolExecutors'
import type { SimulatorHostService } from '../simulator/SimulatorHostService'
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

function fakeHost(overrides: Partial<SimulatorHostService> = {}): SimulatorHostService {
  return {
    status: vi.fn(async () => statusFixture),
    openSimulatorApp: vi.fn(async () => ({ ok: true, status: statusFixture })),
    listDevices: vi.fn(async () => ({
      ok: true,
      devices: statusFixture.availableDevices,
      status: statusFixture
    })),
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
    getOwnedSimulatorPid: vi.fn(() => null),
    ...overrides
  } as unknown as SimulatorHostService
}

describe('SimulatorToolExecutors', () => {
  it('recognises the catalog simulator tool names', () => {
    for (const name of SIMULATOR_MCP_TOOL_NAMES) {
      expect(isSimulatorMcpToolName(name)).toBe(true)
    }
    expect(isSimulatorMcpToolName('canvas_status')).toBe(false)
  })

  it('simulator_status returns host.status() without approval taxonomy service', async () => {
    const host = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors(host)
    const result = await executeSimulatorTool('simulator_status', {}, {}, 'claude')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'simulator_status',
      status: statusFixture
    })
    expect(host.status).toHaveBeenCalledOnce()
    expect(TASKWRAITH_TOOL_ACTIONS.simulator_status.service).toBe('mcpTools')
    expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has('simulator_status')).toBe(true)
  })

  it('simulator_open / boot / install / launch / terminate route to the host', async () => {
    const host = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors(host)
    const udid = '11111111-1111-1111-1111-111111111111'
    expect((await executeSimulatorTool('simulator_open', {}, {}, 'codex')).isError).toBeFalsy()
    expect(host.openSimulatorApp).toHaveBeenCalledOnce()
    expect(
      (await executeSimulatorTool('simulator_boot', { udid }, {}, 'codex')).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_install',
          { udid, appPath: '/tmp/Demo.app' },
          {},
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_launch',
          { udid, bundleId: 'com.example.Demo' },
          {},
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, udid })
    expect(
      (
        await executeSimulatorTool(
          'simulator_terminate',
          { udid, bundleId: 'com.example.Demo' },
          {},
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

  it('simulator_screenshot returns an image block and keeps base64 out of structuredContent', async () => {
    const host = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors(host)
    const result = await executeSimulatorTool(
      'simulator_screenshot',
      { udid: '11111111-1111-1111-1111-111111111111' },
      {},
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
    const host = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors(host)
    expect((await executeSimulatorTool('simulator_boot', {}, {}, 'claude')).isError).toBe(true)
    expect(host.boot).not.toHaveBeenCalled()
    expect(
      (await executeSimulatorTool('simulator_install', { udid: 'booted' }, {}, 'claude')).isError
    ).toBe(true)
    expect(host.install).not.toHaveBeenCalled()
    expect(
      (await executeSimulatorTool('simulator_launch', { udid: 'booted' }, {}, 'claude')).isError
    ).toBe(true)
    expect(host.launch).not.toHaveBeenCalled()
  })
})
