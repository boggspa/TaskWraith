import { webFrame } from 'electron'
import {
  BLINK_CACHE_CATEGORIES,
  sanitizeBlinkCacheUsage,
  type RendererBlinkCacheUsage,
  type RendererDiagnosticClientSample
} from '../shared/rendererDiagnostics'

/**
 * Reads one Blink cache-category snapshot. Injected so tests can supply fake
 * readings; production passes the Electron `webFrame` reader. Anything the
 * reader returns or throws is treated as untrusted.
 */
export type BlinkResourceUsageReader = () => unknown

function defaultResourceUsageReader(): unknown {
  return webFrame.getResourceUsage()
}

/**
 * Maps the Electron `ResourceUsage` shape (`{ count, size, liveSize }` per
 * category) onto the persisted wire shape (`{ count, sizeBytes,
 * decodedSizeBytes }`). `liveSize` carries Blink's decoded cache size, hence
 * the rename. Unknown categories are dropped; validation and bounding stay in
 * the shared sanitizer.
 */
function toWireShape(reading: unknown): unknown {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) return undefined
  const source = reading as Record<string, unknown>
  const mapped: Record<string, unknown> = {}
  for (const category of BLINK_CACHE_CATEGORIES) {
    const entry = source[category]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const detail = entry as Record<string, unknown>
    mapped[category] = {
      count: detail.count,
      sizeBytes: detail.size,
      decodedSizeBytes: detail.liveSize
    }
  }
  return mapped
}

/**
 * Captures Blink's internal cache-category usage for this renderer. Returns
 * undefined when the API is unavailable, throws, or yields no valid category —
 * the caller omits the field rather than recording zero.
 */
export function captureBlinkCacheUsage(
  reader: BlinkResourceUsageReader = defaultResourceUsageReader
): RendererBlinkCacheUsage | undefined {
  try {
    return sanitizeBlinkCacheUsage(toWireShape(reader()))
  } catch {
    return undefined
  }
}

/**
 * Attaches a fresh Blink cache reading to an outgoing diagnostic sample. Never
 * throws and never mutates its input: when no reading is available the sample
 * passes through unchanged.
 */
export function withBlinkCacheUsage(
  input: RendererDiagnosticClientSample,
  reader: BlinkResourceUsageReader = defaultResourceUsageReader
): RendererDiagnosticClientSample {
  const captured = captureBlinkCacheUsage(reader)
  if (!captured) return input
  return { ...input, blinkCacheUsage: captured }
}
