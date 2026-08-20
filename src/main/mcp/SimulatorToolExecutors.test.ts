import { describe, expect, it, vi } from 'vitest'
import {
  createSimulatorToolExecutors,
  isSimulatorMcpToolName,
  SIMULATOR_MCP_TOOL_NAMES
} from './SimulatorToolExecutors'
import type { SimulatorHostControl } from '../simulator/SimulatorHostControl'
import type { IdbClient } from '../simulator/IdbClient'
import { SimulatorControllerLease } from '../simulator/SimulatorControllerLease'
import { SimulatorSessionStore } from '../simulator/SimulatorSessionStore'
import type { SimulatorCapabilityStatus } from '../../shared/simulatorCanvas'
import { SIMULATOR_CONTROL_DISABLED_MESSAGE } from '../../shared/simulatorControlSetup'
import { TASKWRAITH_TOOL_ACTIONS } from '../../shared/providerActionTaxonomy'
import { MCP_AUTO_ALLOWED_TOOLS } from './McpAutoAllowedTools'
import { resolveAppDriveSurfaceDescriptor } from '../../shared/appDriveSurface'

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

function approveTool(
  lease: SimulatorControllerLease,
  toolName: string,
  args: Record<string, unknown>,
  options: { provider?: string; sessionStore?: SimulatorSessionStore } = {}
): void {
  const session = options.sessionStore?.get('chat-1')
  const surface = resolveAppDriveSurfaceDescriptor(toolName, args, {
    simulatorUdid: session?.udid,
    simulatorBundleId: session?.bundleId
  })
  if (!surface) throw new Error(`No simulator surface for ${toolName}`)
  const authorized = lease.authorizeUserLease({
    chatId: 'chat-1',
    runId: 'run-1',
    provider: options.provider || 'codex',
    surfaceId: surface.surfaceId,
    verb: surface.verb,
    allowedVerbs: surface.allowedVerbs,
    target: surface.target,
    ownerParticipantId: 'seat-a',
    approvedBy: 'user',
    stepBudget: 20
  })
  if (!authorized.ok) throw new Error(authorized.error)
}

function fakeIdb(
  overrides: Partial<
    Pick<
      IdbClient,
      'isAvailable' | 'describeAll' | 'hardwareButton' | 'rotate' | 'tap' | 'text' | 'swipe'
    >
  > = {}
): Pick<
  IdbClient,
  'isAvailable' | 'describeAll' | 'hardwareButton' | 'rotate' | 'tap' | 'text' | 'swipe'
> {
  return {
    isAvailable: () => true,
    describeAll: vi.fn(async () => ({
      ok: true as const,
      tree: [{ AXLabel: 'Home' }],
      truncated: false
    })),
    hardwareButton: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    rotate: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    tap: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    text: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    swipe: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
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
        pointWidth: 1,
        pointHeight: 1,
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
  it('stops agent mutations when the user turns Simulator control off, while keeping preview read-only', async () => {
    const hostControl = fakeHost()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl,
      controllerLease: new SimulatorControllerLease(),
      idb: fakeIdb(),
      isSimulatorControlEnabled: () => false
    })

    const mutation = await executeSimulatorTool('simulator_boot', { udid }, runCtx, 'codex')
    expect(mutation.isError).toBe(true)
    expect(mutation.structuredContent).toMatchObject({
      error: SIMULATOR_CONTROL_DISABLED_MESSAGE
    })
    expect(hostControl.boot).not.toHaveBeenCalled()

    const preview = await executeSimulatorTool('simulator_screenshot', { udid }, runCtx, 'codex')
    expect(preview.isError).toBeFalsy()
    expect(hostControl.screenshot).toHaveBeenCalledWith(udid, { chatId: 'chat-1' })
  })

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

    approveTool(controllerLease, 'simulator_open', {})
    expect(
      (await executeSimulatorTool('simulator_open', {}, runCtx, 'codex')).isError
    ).toBeFalsy()
    expect(hostControl.openSimulatorApp).toHaveBeenCalledWith({
      chatId: 'chat-1',
      controllerTokenId: 'tok-run'
    })

    approveTool(controllerLease, 'simulator_boot', { udid })
    expect(
      (await executeSimulatorTool('simulator_boot', { udid }, runCtx, 'codex')).structuredContent
    ).toMatchObject({ ok: true, udid })
    approveTool(controllerLease, 'simulator_install', { udid, appPath: '/tmp/Demo.app' })
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
    approveTool(controllerLease, 'simulator_launch', {
      udid,
      bundleId: 'com.example.Demo'
    })
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
    approveTool(controllerLease, 'simulator_terminate', {
      udid,
      bundleId: 'com.example.Demo'
    })
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
    expect(
      controllerLease.authorizeUserLease({
        chatId: 'chat-1',
        runId: 'run-holder',
        provider: 'codex',
        surfaceId: `simulator:${udid}:-`,
        verb: 'simulator_boot',
        allowedVerbs: ['simulator_boot'],
        target: { udid },
        approvedBy: 'user'
      }).ok
    ).toBe(true)
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

  it('presents the in-app Canvas for agent QA tools but not status or standalone open', async () => {
    const presentCanvas = vi.fn()
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease: new SimulatorControllerLease({ createId: () => 'tok-present' }),
      idb: fakeIdb(),
      presentCanvas
    })

    await executeSimulatorTool('simulator_status', {}, runCtx, 'claude')
    await executeSimulatorTool('simulator_open', {}, runCtx, 'claude')
    expect(presentCanvas).not.toHaveBeenCalled()

    await executeSimulatorTool('simulator_screenshot', { udid }, runCtx, 'claude')
    expect(presentCanvas).toHaveBeenCalledWith({
      chatId: 'chat-1',
      tool: 'simulator_screenshot'
    })
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

    approveTool(controllerLease, 'simulator_button', { udid, button: 'HOME' })
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

    approveTool(controllerLease, 'simulator_rotate', {
      udid,
      direction: 'LANDSCAPE_RIGHT'
    })
    expect(
      (
        await executeSimulatorTool(
          'simulator_rotate',
          { udid, direction: 'LANDSCAPE_RIGHT' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, direction: 'LANDSCAPE_RIGHT' })
    expect(idb.rotate).toHaveBeenCalledWith(udid, 'LANDSCAPE_RIGHT')

    const sessionStore = new SimulatorSessionStore({ now: () => 't' })
    const orientationLease = new SimulatorControllerLease({ createId: () => 'tok-orient' })
    const withSession = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease: orientationLease,
      idb: fakeIdb(),
      sessionStore
    })
    approveTool(
      orientationLease,
      'simulator_rotate',
      { udid, direction: 'PORTRAIT_UPSIDE_DOWN' },
      { sessionStore }
    )
    expect(
      (
        await withSession.executeSimulatorTool(
          'simulator_rotate',
          { udid, direction: 'PORTRAIT_UPSIDE_DOWN' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, direction: 'PORTRAIT_UPSIDE_DOWN' })
    expect(sessionStore.get('chat-1')?.orientation).toBe('PORTRAIT_UPSIDE_DOWN')

    const failingIdb = fakeIdb({
      rotate: vi.fn(async () => ({
        ok: false as const,
        stdout: '',
        stderr: '',
        error: 'rotate failed'
      }))
    })
    const failStore = new SimulatorSessionStore({ now: () => 't' })
    const failingLease = new SimulatorControllerLease({ createId: () => 'tok-orient-fail' })
    const failing = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease: failingLease,
      idb: failingIdb,
      sessionStore: failStore
    })
    approveTool(
      failingLease,
      'simulator_rotate',
      { udid, direction: 'LANDSCAPE_LEFT' },
      { sessionStore: failStore }
    )
    expect(
      (
        await failing.executeSimulatorTool(
          'simulator_rotate',
          { udid, direction: 'LANDSCAPE_LEFT' },
          runCtx,
          'codex'
        )
      ).isError
    ).toBe(true)
    expect(failStore.get('chat-1')?.orientation).toBeUndefined()

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
          { udid, direction: 'clockwise' },
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

  it('simulator_tap / type / scroll require lease + idb and map normalized coords via session point dims', async () => {
    const idb = fakeIdb()
    const controllerLease = new SimulatorControllerLease({ createId: () => 'tok-hid' })
    const getActuationTarget = vi.fn(() => ({
      udid,
      pointWidth: 390,
      pointHeight: 844,
      width: 780,
      height: 1688
    }))
    const { executeSimulatorTool } = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease,
      idb,
      getActuationTarget
    })

    expect(
      (await executeSimulatorTool('simulator_tap', { udid, x: 0.5, y: 0.25 }, {}, 'codex'))
        .isError
    ).toBe(true)
    expect(idb.tap).not.toHaveBeenCalled()

    approveTool(controllerLease, 'simulator_tap', { udid, x: 0.5, y: 0.25 })
    expect(
      (
        await executeSimulatorTool(
          'simulator_tap',
          { udid, x: 0.5, y: 0.25 },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, tool: 'simulator_tap', udid, x: 195, y: 211 })
    expect(idb.tap).toHaveBeenCalledWith(udid, 195, 211)
    expect(getActuationTarget).toHaveBeenCalledWith('chat-1')

    approveTool(controllerLease, 'simulator_type', { udid, text: 'hello' })
    expect(
      (
        await executeSimulatorTool(
          'simulator_type',
          { udid, text: 'hello' },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, tool: 'simulator_type', udid })
    expect(idb.text).toHaveBeenCalledWith(udid, 'hello')

    // Agent scroll deltas are point-space (no pixel→point rescale).
    approveTool(controllerLease, 'simulator_scroll', {
      udid,
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: -80
    })
    expect(
      (
        await executeSimulatorTool(
          'simulator_scroll',
          { udid, x: 0.5, y: 0.5, deltaX: 0, deltaY: -80 },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, tool: 'simulator_scroll', udid })
    expect(idb.swipe).toHaveBeenCalledWith(udid, 195, 422, 195, 502)

    // Optional width/height args supply point extents when session has none.
    const noSessionLease = new SimulatorControllerLease({ createId: () => 'tok-args' })
    const noSession = createSimulatorToolExecutors({
      hostControl: fakeHost(),
      controllerLease: noSessionLease,
      idb: fakeIdb(),
      getActuationTarget: () => null
    })
    approveTool(noSessionLease, 'simulator_tap', {
      udid,
      x: 1,
      y: 1,
      width: 100,
      height: 200
    })
    expect(
      (
        await noSession.executeSimulatorTool(
          'simulator_tap',
          { udid, x: 1, y: 1, width: 100, height: 200 },
          runCtx,
          'codex'
        )
      ).structuredContent
    ).toMatchObject({ ok: true, x: 100, y: 200 })

    expect(
      (
        await noSession.executeSimulatorTool(
          'simulator_tap',
          { udid, x: 0.5, y: 0.5 },
          runCtx,
          'codex'
        )
      ).isError
    ).toBe(true)

    for (const tool of ['simulator_tap', 'simulator_type', 'simulator_scroll'] as const) {
      expect(TASKWRAITH_TOOL_ACTIONS[tool].service).toBe('simulatorCanvas')
      expect((MCP_AUTO_ALLOWED_TOOLS as ReadonlySet<string>).has(tool)).toBe(false)
    }
  })
})
