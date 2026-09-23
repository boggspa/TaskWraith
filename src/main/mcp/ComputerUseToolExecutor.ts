/**
 * A small observe-act-observe facade over the canonical Canvas MCP tools.
 * Every contained call re-enters the normal tool route, including capture.
 */
import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'

export const COMPUTER_USE_ACTIONS = [
  'list',
  'open',
  'observe',
  'click',
  'fill',
  'key',
  'scroll',
  'hover',
  'select',
  'navigate',
  'close'
] as const

export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number]
export type ExecuteCanonicalComputerUseTool = (
  name: string,
  args: Record<string, unknown>
) => Promise<McpToolExecutionResult>

const ACTION_SET: ReadonlySet<string> = new Set(COMPUTER_USE_ACTIONS)
const WEB_ACTIONS = [
  'observe',
  'click',
  'fill',
  'key',
  'scroll',
  'hover',
  'select',
  'navigate',
  'close'
] as const
const WINDOW_ACTIONS = ['observe', 'click', 'fill', 'close'] as const

type ParsedInput = {
  action: ComputerUseAction
  canvasId?: string
  url?: string
  navigation?: 'back' | 'forward' | 'reload' | 'stop'
  launchId?: string
  ref?: string
  selector?: string
  x?: number
  y?: number
  text?: string
  key?: string
  deltaX?: number
  deltaY?: number
  expectedInputEpoch?: number
  expectedObservationId?: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasForbiddenControl(value: string, allowLineBreaks: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code === 127 ||
      (code < 32 && !(allowLineBreaks && (code === 9 || code === 10 || code === 13)))
    ) {
      return true
    }
  }
  return false
}

function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false
): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    (!allowEmpty && (value.length === 0 || value.trim() !== value)) ||
    hasForbiddenControl(value, allowEmpty)
  ) {
    throw new Error(
      `\`${name}\` must be a bounded string${allowEmpty ? '' : ' without surrounding whitespace'}.`
    )
  }
  return value
}

function boundedNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`\`${name}\` must be a finite number from ${min} to ${max}.`)
  }
  return value
}

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`\`${name}\` is required.`)
  return value
}

function parseInput(rawArgs: unknown): ParsedInput {
  const args = object(rawArgs)
  if (!args || typeof args.action !== 'string' || !ACTION_SET.has(args.action)) {
    throw new Error(`\`action\` must be one of: ${COMPUTER_USE_ACTIONS.join(', ')}.`)
  }
  const action = args.action as ComputerUseAction
  const allowed: Record<ComputerUseAction, readonly string[]> = {
    list: [],
    open: ['url', 'launchId'],
    observe: ['canvasId'],
    click: ['canvasId', 'ref', 'selector', 'x', 'y', 'expectedInputEpoch', 'expectedObservationId'],
    fill: ['canvasId', 'ref', 'selector', 'text', 'expectedInputEpoch', 'expectedObservationId'],
    key: ['canvasId', 'ref', 'selector', 'key', 'expectedInputEpoch', 'expectedObservationId'],
    scroll: [
      'canvasId',
      'ref',
      'selector',
      'x',
      'y',
      'deltaX',
      'deltaY',
      'expectedInputEpoch',
      'expectedObservationId'
    ],
    hover: ['canvasId', 'ref', 'selector', 'expectedInputEpoch', 'expectedObservationId'],
    select: ['canvasId', 'ref', 'selector', 'text', 'expectedInputEpoch', 'expectedObservationId'],
    navigate: ['canvasId', 'url', 'navigation'],
    close: ['canvasId']
  }
  const allowedKeys = new Set(['action', ...allowed[action]])
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) throw new Error(`\`${key}\` is not valid for ${action}.`)
  }

  const input: ParsedInput = {
    action,
    canvasId: boundedString(args.canvasId, 'canvasId', 256),
    url: boundedString(args.url, 'url', 4096),
    navigation: undefined,
    launchId: boundedString(args.launchId, 'launchId', 256),
    ref: boundedString(args.ref, 'ref', 512),
    selector: boundedString(args.selector, 'selector', 2048),
    x: boundedNumber(args.x, 'x', 0, 1_000_000),
    y: boundedNumber(args.y, 'y', 0, 1_000_000),
    text: boundedString(args.text, 'text', 8192, true),
    // Canvas's allowlisted Space key is represented by one literal space.
    key: args.key === ' ' ? ' ' : boundedString(args.key, 'key', 128),
    deltaX: boundedNumber(args.deltaX, 'deltaX', -10_000, 10_000),
    deltaY: boundedNumber(args.deltaY, 'deltaY', -10_000, 10_000),
    expectedInputEpoch: boundedNumber(
      args.expectedInputEpoch,
      'expectedInputEpoch',
      0,
      Number.MAX_SAFE_INTEGER
    ),
    expectedObservationId: boundedString(args.expectedObservationId, 'expectedObservationId', 256)
  }
  if (input.expectedInputEpoch !== undefined && !Number.isSafeInteger(input.expectedInputEpoch)) {
    throw new Error('`expectedInputEpoch` must be a non-negative safe integer.')
  }

  if (action === 'open') {
    if ((input.url === undefined) === (input.launchId === undefined)) {
      throw new Error('Provide exactly one of `url` or `launchId`.')
    }
  } else if (action !== 'list') {
    requireField(input.canvasId, 'canvasId')
  }
  if (args.navigation !== undefined) {
    if (
      args.navigation !== 'back' &&
      args.navigation !== 'forward' &&
      args.navigation !== 'reload' &&
      args.navigation !== 'stop'
    ) {
      throw new Error('`navigation` must be back, forward, reload, or stop.')
    }
    input.navigation = args.navigation
  }
  if (action === 'navigate' && (input.url === undefined) === (input.navigation === undefined)) {
    throw new Error('Navigate requires exactly one of `url` or `navigation`.')
  }
  if (input.url !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw new Error('`url` must be an absolute http(s) URL.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('`url` must be an absolute http(s) URL.')
    }
  }
  if (action === 'click') {
    if (!input.ref && !input.selector && (input.x === undefined || input.y === undefined)) {
      throw new Error('Click requires a `ref`, `selector`, or both `x` and `y`.')
    }
  }
  if ((input.x === undefined) !== (input.y === undefined)) {
    throw new Error('Coordinates require both `x` and `y`.')
  }
  if (action === 'fill' || action === 'key' || action === 'hover' || action === 'select') {
    if (!input.ref && !input.selector)
      throw new Error(`${action} requires a \`ref\` or \`selector\`.`)
  }
  if (action === 'fill' || action === 'select') requireField(input.text, 'text')
  if (action === 'key') requireField(input.key, 'key')
  if (action === 'scroll' && !input.deltaX && !input.deltaY) {
    throw new Error('Scroll requires a non-zero `deltaX` or `deltaY`.')
  }
  return input
}

function result(
  value: Record<string, unknown>,
  isError = false,
  image?: McpToolContentBlock
): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return {
    text,
    ...(isError ? { isError: true } : {}),
    structuredContent: value,
    content: [{ type: 'text', text }, ...(image ? [image] : [])]
  }
}

function payload(canonical: McpToolExecutionResult): Record<string, unknown> | null {
  return object(canonical.structuredContent)
}

function canonicalFailed(canonical: McpToolExecutionResult): boolean {
  return canonical.isError === true || payload(canonical)?.ok === false
}

function canonicalDetail(canonical: McpToolExecutionResult): Record<string, unknown> {
  return payload(canonical) ?? { error: 'The canonical tool returned no structured result.' }
}

function actionsForDriver(driver: unknown): readonly string[] {
  return driver === 'window' ? WINDOW_ACTIONS : driver === 'web' ? WEB_ACTIONS : ['close']
}

function isNativeWindowObservation(observation: Record<string, unknown>): boolean {
  return (
    typeof observation.url === 'string' &&
    (observation.url.startsWith('window://managed/') || observation.url === 'window://native')
  )
}

function observationGuidance(observation: Record<string, unknown>): Record<string, unknown> {
  const url = observation.url
  if (isNativeWindowObservation(observation)) {
    return {
      availableActions: WINDOW_ACTIONS,
      surfaceGuidance:
        'Native actions use AX refs from this observation. Click and fill require expectedObservationId and expectedInputEpoch; coordinate actions are unavailable.'
    }
  }
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    return { availableActions: WEB_ACTIONS }
  }
  return {}
}

function coordinateSpace(
  observation: Record<string, unknown>,
  screenshot?: Record<string, unknown>
): Record<string, unknown> {
  const viewport = object(observation.viewport)
  const nativeWindow = isNativeWindowObservation(observation)
  const web = typeof observation.url === 'string' && /^https?:\/\//.test(observation.url)
  return {
    actionUnit: nativeWindow ? 'ax-ref-only' : web ? 'viewport-css-pixels' : 'unavailable',
    ...(viewport ? { actionViewport: { width: viewport.width, height: viewport.height } } : {}),
    ...(screenshot && typeof screenshot.width === 'number' && typeof screenshot.height === 'number'
      ? {
          screenshot: {
            unit: 'png-pixels',
            width: screenshot.width,
            height: screenshot.height
          }
        }
      : {}),
    guidance: nativeWindow
      ? 'Use AX refs from the latest observation. Native window coordinate actions are unavailable.'
      : web
        ? 'Prefer refs. Browser x/y use viewport CSS pixels; screenshot PNG dimensions can differ.'
        : 'Coordinate actions are unavailable for this surface.'
  }
}

function actionArgs(input: ParsedInput): Record<string, unknown> {
  const args: Record<string, unknown> = { canvasId: input.canvasId }
  if (input.ref !== undefined) args.ref = input.ref
  if (input.selector !== undefined) args.selector = input.selector
  if (input.x !== undefined) args.x = input.x
  if (input.y !== undefined) args.y = input.y
  if (input.expectedInputEpoch !== undefined) args.expectedInputEpoch = input.expectedInputEpoch
  if (input.expectedObservationId !== undefined) {
    args.expectedObservationId = input.expectedObservationId
  }
  if (input.action === 'fill' || input.action === 'select') args.value = input.text
  if (input.action === 'key') args.key = input.key
  if (input.action === 'scroll') {
    if (input.deltaX !== undefined) args.deltaX = input.deltaX
    if (input.deltaY !== undefined) args.deltaY = input.deltaY
  }
  if (input.action === 'navigate') {
    if (input.url !== undefined) args.url = input.url
    if (input.navigation !== undefined) args.action = input.navigation
  }
  return args
}

export async function executeComputerUseTool(
  rawArgs: unknown,
  executeCanonical: ExecuteCanonicalComputerUseTool
): Promise<McpToolExecutionResult> {
  let input: ParsedInput
  try {
    input = parseInput(rawArgs)
  } catch (error) {
    return result({ ok: false, tool: 'computer_use', error: (error as Error).message }, true)
  }

  const call = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolExecutionResult> => executeCanonical(name, args)
  const { action } = input
  let canvasId = input.canvasId
  let actionResult: Record<string, unknown> | undefined

  try {
    if (action === 'list') {
      const listed = await call('canvas_list', {})
      if (canonicalFailed(listed)) {
        return result(
          {
            ok: false,
            tool: 'computer_use',
            action,
            stage: 'list',
            canonicalResult: canonicalDetail(listed)
          },
          true
        )
      }
      const listing = canonicalDetail(listed)
      const sessions = Array.isArray(listing.sessions)
        ? listing.sessions.map((session) => {
            const value = object(session)
            return value
              ? {
                  ...value,
                  availableActions: value.status === 'active' ? actionsForDriver(value.driver) : []
                }
              : session
          })
        : listing.sessions
      return result({
        ...listing,
        ok: true,
        tool: 'computer_use',
        action,
        sessions,
        availableActions: COMPUTER_USE_ACTIONS
      })
    }

    if (action === 'open') {
      const name = input.url === undefined ? 'canvas_open_launch' : 'canvas_open'
      const args =
        input.url === undefined
          ? { attemptId: input.launchId }
          : { driver: 'web', url: input.url, presentation: 'dock' }
      const opened = await call(name, args)
      actionResult = canonicalDetail(opened)
      if (canonicalFailed(opened)) {
        return result(
          { ok: false, tool: 'computer_use', action, stage: 'open', actionResult },
          true
        )
      }
      const openedCanvasId = actionResult.canvasId
      if (typeof openedCanvasId !== 'string' || !openedCanvasId) {
        return result(
          {
            ok: false,
            tool: 'computer_use',
            action,
            stage: 'open',
            error: 'Open returned no canvasId.',
            actionResult
          },
          true
        )
      }
      canvasId = openedCanvasId
    } else if (action === 'close') {
      const closed = await call('canvas_close', { canvasId })
      actionResult = canonicalDetail(closed)
      return result(
        { ok: !canonicalFailed(closed), tool: 'computer_use', action, canvasId, actionResult },
        canonicalFailed(closed)
      )
    } else if (action !== 'observe') {
      const acted = await call(`canvas_${action}`, actionArgs(input))
      actionResult = canonicalDetail(acted)
      if (canonicalFailed(acted) || (action !== 'navigate' && actionResult.executed !== true)) {
        return result(
          { ok: false, tool: 'computer_use', action, stage: 'action', canvasId, actionResult },
          true
        )
      }
    }
  } catch {
    return result(
      {
        ok: false,
        tool: 'computer_use',
        action,
        stage: action === 'list' ? 'list' : action === 'open' ? 'open' : 'action',
        canvasId,
        error:
          'The canonical tool call failed. Its outcome may be indeterminate; do not blindly replay an action.'
      },
      true
    )
  }

  let observation: Record<string, unknown>
  try {
    const snapshotArgs: Record<string, unknown> = { canvasId }
    if (typeof actionResult?.driveActionId === 'string') {
      snapshotArgs.driveActionId = actionResult.driveActionId
    }
    const observed = await call('canvas_snapshot', snapshotArgs)
    observation = canonicalDetail(observed)
    if (canonicalFailed(observed)) {
      return result(
        {
          ok: false,
          tool: 'computer_use',
          action,
          stage: 'observation',
          canvasId,
          ...(actionResult ? { actionResult } : {}),
          observationError: observation,
          message:
            'The action may have taken effect. Re-observe before planning another action; do not blindly replay it.'
        },
        true
      )
    }
  } catch {
    return result(
      {
        ok: false,
        tool: 'computer_use',
        action,
        stage: 'observation',
        canvasId,
        ...(actionResult ? { actionResult } : {}),
        message: 'Observation failed after the canonical action. Do not blindly replay that action.'
      },
      true
    )
  }

  const base = {
    ok: true,
    tool: 'computer_use',
    action,
    canvasId,
    ...(actionResult ? { actionResult } : {}),
    observation,
    coordinateSpace: coordinateSpace(observation),
    ...observationGuidance(observation)
  }
  try {
    const captured = await call('canvas_screenshot', { canvasId })
    const screenshot = canonicalDetail(captured)
    const image = captured.content?.find((block) => block.type === 'image')
    if (canonicalFailed(captured) || !image || image.mimeType !== 'image/png' || !image.data) {
      return result({
        ...base,
        screenshotAvailable: false,
        screenshotError: screenshot,
        message:
          'Action and observation succeeded; screenshot unavailable. Do not replay the action to obtain a frame.'
      })
    }
    return result(
      {
        ...base,
        coordinateSpace: coordinateSpace(observation, screenshot),
        screenshotAvailable: true,
        screenshot
      },
      false,
      image
    )
  } catch {
    return result({
      ...base,
      screenshotAvailable: false,
      message:
        'Action and observation succeeded; screenshot unavailable. Do not replay the action to obtain a frame.'
    })
  }
}
