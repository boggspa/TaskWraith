export const APP_DRIVE_WEB_CONTROL_TOOLS = [
  'canvas_click',
  'canvas_fill',
  'canvas_key',
  'canvas_scroll',
  'canvas_hover',
  'canvas_select'
] as const

export const APP_DRIVE_SIMULATOR_CONTROL_TOOLS = [
  'canvas_open',
  'simulator_open',
  'simulator_boot',
  'simulator_install',
  'simulator_launch',
  'simulator_terminate',
  'simulator_button',
  'simulator_rotate',
  'simulator_tap',
  'simulator_type',
  'simulator_scroll'
] as const

export type AppDriveWebControlTool = (typeof APP_DRIVE_WEB_CONTROL_TOOLS)[number]
export type AppDriveSimulatorControlTool = (typeof APP_DRIVE_SIMULATOR_CONTROL_TOOLS)[number]
export type AppDriveLeasedTool = AppDriveWebControlTool | AppDriveSimulatorControlTool

export interface AppDriveSurfaceDescriptor {
  surfaceId: string
  surfaceKind: 'web' | 'simulator'
  target: {
    canvasId?: string
    origin?: string
    udid?: string
    bundleId?: string
  }
  verb: string
  allowedVerbs: readonly string[]
  independentVerificationRequired?: boolean
}

export interface AppDriveSurfaceContext {
  simulatorUdid?: string
  simulatorBundleId?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function canonical(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed === value && trimmed.length <= max ? trimmed : undefined
}

function simulatorSurfaceId(udid: string, bundleId?: string): string {
  return `simulator:${encodeURIComponent(udid)}:${encodeURIComponent(bundleId || '-')}`
}

export function resolveAppDriveSurfaceDescriptor(
  toolName: string,
  rawArgs: unknown,
  context: AppDriveSurfaceContext = {}
): AppDriveSurfaceDescriptor | null {
  const args = record(rawArgs)
  if ((APP_DRIVE_WEB_CONTROL_TOOLS as readonly string[]).includes(toolName)) {
    const canvasId = canonical(args.canvasId, 256)
    if (!canvasId) return null
    return {
      surfaceId: canvasId,
      surfaceKind: 'web',
      target: { canvasId },
      verb: toolName.slice('canvas_'.length),
      allowedVerbs: APP_DRIVE_WEB_CONTROL_TOOLS.map((name) => name.slice('canvas_'.length)),
      independentVerificationRequired: args.requireIndependentVerifier === true
    }
  }

  const deviceCanvasOpen = toolName === 'canvas_open' && canonical(args.driver) === 'device'
  const simulatorTool =
    toolName !== 'canvas_open' &&
    (APP_DRIVE_SIMULATOR_CONTROL_TOOLS as readonly string[]).includes(toolName)
  if (!deviceCanvasOpen && !simulatorTool) {
    return null
  }
  const udid = canonical(args.udid, 128) || canonical(context.simulatorUdid, 128) || 'simulator-app'
  const bundleId =
    canonical(args.bundleId, 256) || canonical(context.simulatorBundleId, 256) || undefined
  return {
    surfaceId: simulatorSurfaceId(udid, bundleId),
    surfaceKind: 'simulator',
    target: { udid, ...(bundleId ? { bundleId } : {}) },
    verb: deviceCanvasOpen ? 'canvas_open_device' : toolName,
    allowedVerbs: [
      'canvas_open_device',
      ...APP_DRIVE_SIMULATOR_CONTROL_TOOLS.filter((name) => name !== 'canvas_open')
    ],
    independentVerificationRequired: args.requireIndependentVerifier === true
  }
}

export function isAppDriveLeasedTool(toolName: string, rawArgs: unknown): boolean {
  return Boolean(resolveAppDriveSurfaceDescriptor(toolName, rawArgs))
}
