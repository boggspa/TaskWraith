import createTwemu from './twgb.mjs'

const WIDTH = 160
const HEIGHT = 144
const TWGB_OFFSET = 0x100
const TWGB_MIN_BYTES = TWGB_OFFSET + 0x0d
const TWGB_MAGIC = [0x54, 0x57, 0x47, 0x42]
const TWGB_SCHEMA = 1
const READY_STATUS = 0x03
const BOOT_FRAME_LIMIT = 600
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
const status = document.getElementById('status')
if (!(screen instanceof HTMLCanvasElement) || !(status instanceof HTMLOutputElement)) {
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

function onKeyDown(event) {
  const button = KEY_BUTTONS[event.code]
  if (!button) return
  pressedButtons.add(button)
  event.preventDefault()
}

function onKeyUp(event) {
  const button = KEY_BUTTONS[event.code]
  if (!button) return
  pressedButtons.delete(button)
  event.preventDefault()
}

function attachListeners() {
  if (listenersAttached) return
  window.addEventListener('keydown', onKeyDown, { passive: false })
  window.addEventListener('keyup', onKeyUp, { passive: false })
  listenersAttached = true
}

function detachListeners() {
  if (!listenersAttached) return
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  pressedButtons.clear()
  listenersAttached = false
}

function enqueueOperation(operation) {
  const scheduled = operationTail.then(operation, operation)
  operationTail = scheduled.catch(() => undefined)
  return scheduled
}

function namedButtonMask(buttons) {
  const values = buttons === undefined ? [...pressedButtons] : buttons
  if (!Array.isArray(values) || values.length > Object.keys(BUTTON_BITS).length) {
    throw new Error('twemu accepts at most eight named buttons')
  }
  let mask = 0
  const namedButtons = new Set()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('twemu button names must be strings')
    const name = value.toUpperCase()
    const bit = BUTTON_BITS[name]
    if (bit === undefined) throw new Error(`Unsupported twemu button: ${value}`)
    if (namedButtons.has(name)) throw new Error(`Duplicate twemu button: ${value}`)
    namedButtons.add(name)
    mask |= bit
  }
  if (
    OPPOSITE_DIRECTIONS.some(
      ([first, second]) => namedButtons.has(first) && namedButtons.has(second)
    )
  ) {
    throw new Error('twemu does not accept opposite direction pairs')
  }
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
  return {
    magic: Array.from(heap.subarray(offset, offset + 4)),
    schema: heap[offset + 4],
    status: heap[offset + 5],
    x: heap[offset + 6],
    y: heap[offset + 7],
    input: heap[offset + 8],
    frameCounter: readU32le(heap, offset + 9)
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

async function drawAndObserve() {
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
  const frameHash = await rgbaHash(image.data)
  status.value = `frame ${frameId} · x ${abi.x} · y ${abi.y}`
  return Object.freeze({
    frameId,
    frameHash,
    width,
    height,
    ...abi
  })
}

async function stepOneFrame(buttons) {
  if (closed || !moduleInstance) throw new Error('twemu is shut down')
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
  return observation
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
    if (isStableReady(readAbiOrNull())) return drawAndObserve()
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
    return enqueueOperation(drawAndObserve)
  },
  async step(buttons = undefined) {
    await readyPromise
    return enqueueOperation(() => stepOneFrame(buttons))
  },
  async shutdown() {
    await readyPromise.catch(() => undefined)
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
  status.value = `Failed: ${error instanceof Error ? error.message : String(error)}`
})
