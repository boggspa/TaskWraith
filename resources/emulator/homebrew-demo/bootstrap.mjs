import createTwemu from './twgb.mjs'

const WIDTH = 160
const HEIGHT = 144
const TWGB_OFFSET = 0x100
const TWGB_ABI_WINDOW_BYTES = 0x0d
const TWGB_MIN_BYTES = TWGB_OFFSET + TWGB_ABI_WINDOW_BYTES
const TWGB_MAGIC = [0x54, 0x57, 0x47, 0x42]
const TWGB_SCHEMA = 1
const READY_STATUS = 0x03
const BOOT_FRAME_LIMIT = 600
const HUMAN_FRAME_INTERVAL_MS = 1000 / 60
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const MAX_PNG_DATA_URL_CHARS = 512 * 1024
const BUTTON_BITS = Object.freeze({
  B: 1 << 0,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
  A: 1 << 8
})
const KEY_BUTTONS = Object.freeze({
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  KeyZ: 'B',
  KeyX: 'A',
  Enter: 'START',
  ShiftLeft: 'SELECT',
  ShiftRight: 'SELECT'
})
const OPPOSITE_DIRECTIONS = Object.freeze([
  Object.freeze(['UP', 'DOWN']),
  Object.freeze(['LEFT', 'RIGHT'])
])

const screen = document.getElementById('screen')
const playPause = document.getElementById('play-pause')
const status = document.getElementById('status')
if (
  !(screen instanceof HTMLCanvasElement) ||
  !(playPause instanceof HTMLButtonElement) ||
  !(status instanceof HTMLOutputElement)
) {
  throw new Error('twemu DOM is incomplete')
}
const context = screen.getContext('2d', { alpha: false, willReadFrequently: true })
if (!context) throw new Error('Canvas2D is unavailable')
context.imageSmoothingEnabled = false

const pressedButtons = new Set()
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0))

let moduleInstance = null
let closed = false
let listenersAttached = false
let operationTail = Promise.resolve()
let trustedHumanInputEpoch = 0
let humanPlayActive = false
let humanAnimationFrame = null
let humanLoopGeneration = 0
let humanFrameQueued = false
let lastHumanFrameAt = Number.NEGATIVE_INFINITY
let readyForHumanPlay = false
let humanRuntimeFailure = null

function updatePlayPauseControl() {
  playPause.disabled = closed || !readyForHumanPlay
  playPause.textContent = humanPlayActive ? 'Pause' : 'Play'
  playPause.setAttribute('aria-pressed', humanPlayActive ? 'true' : 'false')
  playPause.setAttribute('aria-label', humanPlayActive ? 'Pause human play' : 'Start human play')
}

function bumpTrustedHumanInputEpoch() {
  trustedHumanInputEpoch += 1
}

function clearTrustedHeldButtons() {
  if (pressedButtons.size === 0) return false
  pressedButtons.clear()
  return true
}

function cancelHumanLoop() {
  if (humanAnimationFrame !== null) {
    cancelAnimationFrame(humanAnimationFrame)
    humanAnimationFrame = null
  }
  humanLoopGeneration += 1
  lastHumanFrameAt = Number.NEGATIVE_INFINITY
}

function stopHumanPlay(announcement = null) {
  const wasActive = humanPlayActive
  humanPlayActive = false
  cancelHumanLoop()
  const clearedButtons = clearTrustedHeldButtons()
  if (wasActive || clearedButtons) bumpTrustedHumanInputEpoch()
  updatePlayPauseControl()
  if (announcement) status.value = announcement
}

function recordHumanRuntimeFailure(error) {
  humanRuntimeFailure = error instanceof Error ? error : new Error(String(error))
  readyForHumanPlay = false
  stopHumanPlay()
  status.value = `Human play stopped: ${humanRuntimeFailure.message}`
}

function assertRuntimeHealthy() {
  if (humanRuntimeFailure) throw humanRuntimeFailure
}

function recordTrustedButtonTransition(event, button, pressed) {
  if (event.isTrusted !== true) return
  const changed = pressed ? !pressedButtons.has(button) : pressedButtons.has(button)
  if (!changed) return
  if (pressed) pressedButtons.add(button)
  else pressedButtons.delete(button)
  bumpTrustedHumanInputEpoch()
}

function onKeyDown(event) {
  const button = KEY_BUTTONS[event.code]
  if (!button || !humanPlayActive) return
  recordTrustedButtonTransition(event, button, true)
  event.preventDefault()
}

function onKeyUp(event) {
  const button = KEY_BUTTONS[event.code]
  if (!button || !humanPlayActive) return
  recordTrustedButtonTransition(event, button, false)
  event.preventDefault()
}

function onWindowBlur(event) {
  if (event.isTrusted !== true || !humanPlayActive) return
  stopHumanPlay('Human play paused because focus left the emulator.')
}

function onVisibilityChange(event) {
  if (event.isTrusted !== true || !humanPlayActive || document.visibilityState === 'visible') return
  stopHumanPlay('Human play paused because the emulator is hidden.')
}

function onPlayPause(event) {
  if (event.isTrusted !== true || closed || !readyForHumanPlay || humanRuntimeFailure) return
  if (humanPlayActive) {
    stopHumanPlay('Human play paused.')
    return
  }
  humanPlayActive = true
  bumpTrustedHumanInputEpoch()
  updatePlayPauseControl()
  screen.focus()
  status.value = 'Human play active.'
  scheduleHumanFrame(humanLoopGeneration)
}

function attachListeners() {
  if (listenersAttached) return
  window.addEventListener('keydown', onKeyDown, { passive: false })
  window.addEventListener('keyup', onKeyUp, { passive: false })
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
  playPause.addEventListener('click', onPlayPause)
  listenersAttached = true
}

function detachListeners() {
  if (!listenersAttached) return
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  playPause.removeEventListener('click', onPlayPause)
  stopHumanPlay()
  playPause.disabled = true
  listenersAttached = false
}

function enqueueOperation(operation) {
  const scheduled = operationTail.then(operation, operation)
  operationTail = scheduled.catch(() => undefined)
  return scheduled
}

function namedButtonMask(buttons) {
  const trustedHeldButtons = buttons === undefined
  const values = trustedHeldButtons ? [...pressedButtons] : buttons
  if (!Array.isArray(values) || values.length > Object.keys(BUTTON_BITS).length) {
    throw new Error('twemu accepts at most eight named buttons')
  }
  const namedButtons = new Set()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('twemu button names must be strings')
    const name = value.toUpperCase()
    const bit = BUTTON_BITS[name]
    if (bit === undefined) throw new Error(`Unsupported twemu button: ${value}`)
    if (namedButtons.has(name)) throw new Error(`Duplicate twemu button: ${value}`)
    namedButtons.add(name)
  }
  for (const [first, second] of OPPOSITE_DIRECTIONS) {
    if (!namedButtons.has(first) || !namedButtons.has(second)) continue
    if (!trustedHeldButtons) throw new Error('twemu does not accept opposite direction pairs')
    // A human can physically hold both keys. Neutralize that axis instead of
    // throwing from the rAF loop and taking human play down with it.
    namedButtons.delete(first)
    namedButtons.delete(second)
  }
  let mask = 0
  for (const name of namedButtons) mask |= BUTTON_BITS[name]
  return mask
}

function sameMagic(magic) {
  return (
    magic.length === TWGB_MAGIC.length && magic.every((value, index) => value === TWGB_MAGIC[index])
  )
}

function readU32le(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function readAbiOrNull() {
  if (!moduleInstance) return null
  const ramPointer = moduleInstance._twemu_system_ram_ptr()
  const ramSize = moduleInstance._twemu_system_ram_size()
  const heap = moduleInstance.HEAPU8
  if (
    !Number.isSafeInteger(ramPointer) ||
    ramPointer <= 0 ||
    !Number.isSafeInteger(ramSize) ||
    ramSize < TWGB_MIN_BYTES ||
    ramPointer > heap.byteLength - TWGB_MIN_BYTES
  ) {
    return null
  }
  const offset = ramPointer + TWGB_OFFSET
  // Copy this fixed, reviewed C100..C10C window while the shared operation
  // queue holds core mutation. Never return a live Emscripten heap view.
  const abiWindow = Object.freeze(Array.from(heap.subarray(offset, offset + TWGB_ABI_WINDOW_BYTES)))
  return {
    abiWindow,
    magic: abiWindow.slice(0, 4),
    schema: abiWindow[4],
    status: abiWindow[5],
    x: abiWindow[6],
    y: abiWindow[7],
    input: abiWindow[8],
    frameCounter: readU32le(abiWindow, 9)
  }
}

function isStableReady(abi) {
  return (
    abi &&
    sameMagic(abi.magic) &&
    abi.schema === TWGB_SCHEMA &&
    abi.status === READY_STATUS &&
    abi.input === 0 &&
    abi.frameCounter > 0
  )
}

function assertObservableAbi() {
  const abi = readAbiOrNull()
  if (!abi || !sameMagic(abi.magic) || abi.schema !== TWGB_SCHEMA) {
    throw new Error('TWGB ABI is unavailable')
  }
  if (abi.status !== READY_STATUS || abi.frameCounter === 0) {
    throw new Error('TWGB fixture is not running')
  }
  return abi
}

async function rgbaHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

function pngDataUrlFromCanvas() {
  const value = screen.toDataURL('image/png')
  if (
    typeof value !== 'string' ||
    !value.startsWith(PNG_DATA_URL_PREFIX) ||
    value.length <= PNG_DATA_URL_PREFIX.length ||
    value.length > MAX_PNG_DATA_URL_CHARS
  ) {
    throw new Error('Canvas PNG encoding is unavailable or exceeds its cap')
  }
  return value
}

function paintCurrentFrame(includePng = false) {
  if (closed || !moduleInstance) throw new Error('twemu is shut down')
  const width = moduleInstance._twemu_framebuffer_width()
  const height = moduleInstance._twemu_framebuffer_height()
  const pointer = moduleInstance._twemu_framebuffer_ptr()
  if (!Number.isSafeInteger(pointer) || pointer <= 0 || width !== WIDTH || height !== HEIGHT) {
    throw new Error(`Unexpected framebuffer ${width}x${height}`)
  }
  const byteLength = width * height * 4
  const heap = moduleInstance.HEAPU8
  if (byteLength > heap.byteLength || pointer > heap.byteLength - byteLength) {
    throw new Error('Framebuffer lies outside the Emscripten heap')
  }
  const source = heap.subarray(pointer, pointer + byteLength)
  if (source.byteLength !== byteLength) throw new Error('Framebuffer length is truncated')
  const image = context.createImageData(width, height)
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < source.length; sourceOffset += 4) {
    // SameBoy host pixels are little-endian XRGB8888: B, G, R, unused.
    image.data[targetOffset++] = source[sourceOffset + 2]
    image.data[targetOffset++] = source[sourceOffset + 1]
    image.data[targetOffset++] = source[sourceOffset]
    image.data[targetOffset++] = 0xff
  }
  context.putImageData(image, 0, 0)
  const abi = assertObservableAbi()
  const frameId = moduleInstance._twemu_frames_presented()
  if (!Number.isSafeInteger(frameId) || frameId <= 0) {
    throw new Error('TWGB fixture did not provide a positive frame identity')
  }
  return {
    image,
    abi,
    frameId,
    ...(includePng ? { pngDataUrl: pngDataUrlFromCanvas() } : {})
  }
}

async function drawAndObserve() {
  assertRuntimeHealthy()
  // The framebuffer swizzle, canvas paint, PNG encoding, ABI, and frame id are
  // captured before the asynchronous hash yields. The enclosing operation queue
  // keeps core mutation serialized while the hash yields. Trusted key/mode
  // transitions do not mutate the core, so read that non-core arbitration state
  // at transaction close without retrying/hash-looping.
  const snapshot = paintCurrentFrame(true)
  const frameHash = await rgbaHash(snapshot.image.data)
  assertRuntimeHealthy()
  const inputEpoch = trustedHumanInputEpoch
  const humanActive = humanPlayActive
  status.value = `frame ${snapshot.frameId} · x ${snapshot.abi.x} · y ${snapshot.abi.y}`
  return Object.freeze({
    frameId: snapshot.frameId,
    frameHash,
    width: WIDTH,
    height: HEIGHT,
    pngDataUrl: snapshot.pngDataUrl,
    inputEpoch,
    humanActive,
    abiWindow: snapshot.abi.abiWindow,
    magic: Object.freeze([...snapshot.abi.magic]),
    schema: snapshot.abi.schema,
    status: snapshot.abi.status,
    x: snapshot.abi.x,
    y: snapshot.abi.y,
    input: snapshot.abi.input,
    frameCounter: snapshot.abi.frameCounter
  })
}

function paintHumanFrame() {
  return paintCurrentFrame(false)
}

function queueHumanFrame(loopGeneration) {
  if (humanFrameQueued) return
  humanFrameQueued = true
  void enqueueOperation(async () => {
    try {
      if (!humanPlayActive || closed || !moduleInstance || loopGeneration !== humanLoopGeneration) {
        return
      }
      const now = performance.now()
      if (now - lastHumanFrameAt < HUMAN_FRAME_INTERVAL_MS) return
      assertRuntimeHealthy()
      // One queued core mutation, shared with agent observe/step. Human frames
      // deliberately omit PNG/data-URL/hash work; only the visible canvas is
      // painted on this <=60Hz path.
      const mask = namedButtonMask(undefined)
      if (moduleInstance._twemu_step(mask, 1) !== 1) {
        throw new Error('twemu refused one human frame')
      }
      lastHumanFrameAt = now
      paintHumanFrame()
    } catch (error) {
      recordHumanRuntimeFailure(error)
    } finally {
      humanFrameQueued = false
      if (
        humanPlayActive &&
        !closed &&
        !humanRuntimeFailure &&
        loopGeneration === humanLoopGeneration
      ) {
        scheduleHumanFrame(loopGeneration)
      }
    }
  })
}

function scheduleHumanFrame(loopGeneration) {
  if (
    !humanPlayActive ||
    closed ||
    !moduleInstance ||
    humanAnimationFrame !== null ||
    loopGeneration !== humanLoopGeneration
  ) {
    return
  }
  humanAnimationFrame = requestAnimationFrame((_timestamp) => {
    humanAnimationFrame = null
    if (!humanPlayActive || closed || !moduleInstance || loopGeneration !== humanLoopGeneration) {
      return
    }
    if (humanFrameQueued || performance.now() - lastHumanFrameAt < HUMAN_FRAME_INTERVAL_MS) {
      scheduleHumanFrame(loopGeneration)
      return
    }
    queueHumanFrame(loopGeneration)
  })
}

function staleStepCode(expectedFrameId, expectedInputEpoch) {
  if (!Number.isSafeInteger(expectedFrameId) || expectedFrameId <= 0) {
    throw new Error('twemu expectedFrameId must be a positive integer')
  }
  if (!Number.isSafeInteger(expectedInputEpoch) || expectedInputEpoch < 0) {
    throw new Error('twemu expectedInputEpoch must be a non-negative integer')
  }
  if (humanPlayActive) return 'user_active'
  if (expectedInputEpoch !== trustedHumanInputEpoch) {
    return 'stale_input_epoch'
  }
  if (closed || !moduleInstance || moduleInstance._twemu_frames_presented() !== expectedFrameId) {
    return 'stale_observation'
  }
  return null
}

async function stepOneFrame(buttons, expectedFrameId, expectedInputEpoch) {
  if (closed || !moduleInstance) throw new Error('twemu is shut down')
  assertRuntimeHealthy()
  // Both freshness checks run INSIDE the serialized operation queue, before
  // `_twemu_step`, so two callers planned from the same observation cannot
  // both advance the emulator.
  const refusalCode = staleStepCode(expectedFrameId, expectedInputEpoch)
  if (refusalCode) {
    return Object.freeze({
      kind: 'refusal',
      code: refusalCode,
      framesAdvanced: 0,
      observation: await drawAndObserve()
    })
  }
  const beforeFrame = moduleInstance._twemu_frames_presented()
  const mask = namedButtonMask(buttons)
  if (moduleInstance._twemu_step(mask, 1) !== 1) {
    throw new Error('twemu refused one-frame step')
  }
  await yieldToEventLoop()
  const observation = await drawAndObserve()
  if (observation.frameId !== beforeFrame + 1) {
    throw new Error(`Frame identity mismatch (${beforeFrame} -> ${observation.frameId})`)
  }
  if (observation.humanActive) {
    return Object.freeze({
      kind: 'refusal',
      code: 'user_active',
      framesAdvanced: 1,
      observation
    })
  }
  if (observation.inputEpoch !== expectedInputEpoch) {
    return Object.freeze({
      kind: 'refusal',
      code: 'stale_input_epoch',
      framesAdvanced: 1,
      observation
    })
  }
  return Object.freeze({ kind: 'observation', observation })
}

async function initialize() {
  const wasmUrl = new URL('./twgb.wasm', import.meta.url).href
  moduleInstance = await createTwemu({
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    locateFile: (requested) => {
      if (requested !== 'twgb.wasm') throw new Error(`Unexpected SameBoy sidecar: ${requested}`)
      return wasmUrl
    }
  })
  if (moduleInstance._twemu_initialize() !== 1) throw new Error('twemu initialization failed')
  attachListeners()
  for (let attempt = 0; attempt < BOOT_FRAME_LIMIT; attempt += 1) {
    if (moduleInstance._twemu_step(0, 1) !== 1) throw new Error('twemu boot step failed')
    await yieldToEventLoop()
    if (isStableReady(readAbiOrNull())) {
      const initialObservation = await drawAndObserve()
      readyForHumanPlay = true
      updatePlayPauseControl()
      return initialObservation
    }
  }
  throw new Error(`TWGB fixture did not become ready within ${BOOT_FRAME_LIMIT} one-frame yields`)
}

async function shutdownInternal() {
  if (closed) {
    return Object.freeze({
      closed: true,
      listenersDetached: !listenersAttached,
      systemRamAvailable: false
    })
  }
  closed = true
  readyForHumanPlay = false
  detachListeners()
  const activeModule = moduleInstance
  moduleInstance = null
  try {
    activeModule?._twemu_shutdown()
    return Object.freeze({
      closed: true,
      listenersDetached: !listenersAttached,
      systemRamAvailable: Boolean(activeModule?._twemu_system_ram_ptr())
    })
  } finally {
    status.value = 'Shut down'
  }
}

const readyPromise = initialize()
const facade = Object.freeze({
  async ready() {
    return readyPromise
  },
  async observe() {
    await readyPromise
    assertRuntimeHealthy()
    return enqueueOperation(drawAndObserve)
  },
  async step(buttons = undefined, expectedFrameId = undefined, expectedInputEpoch = undefined) {
    await readyPromise
    assertRuntimeHealthy()
    return enqueueOperation(() => stepOneFrame(buttons, expectedFrameId, expectedInputEpoch))
  },
  async shutdown() {
    await readyPromise.catch(() => undefined)
    // Cancel the human loop before this teardown is appended to operationTail:
    // a frame already queued ahead of it will recheck active/generation and skip.
    readyForHumanPlay = false
    stopHumanPlay()
    return enqueueOperation(shutdownInternal)
  }
})

Object.defineProperty(globalThis, '__twemu', {
  value: facade,
  configurable: false,
  enumerable: false,
  writable: false
})

readyPromise.catch((error) => {
  readyForHumanPlay = false
  updatePlayPauseControl()
  status.value = `Failed: ${error instanceof Error ? error.message : String(error)}`
})
