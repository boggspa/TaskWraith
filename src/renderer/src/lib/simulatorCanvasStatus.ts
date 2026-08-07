import type { SimulatorCapabilityStatus } from '../../../shared/simulatorCanvas'

function isCapabilityStatus(value: unknown): value is SimulatorCapabilityStatus {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.installed === 'boolean' && typeof record.docsUrl === 'string'
}

/**
 * `simulator-canvas:status` returns `{ ok: true, status }`. Accept a bare
 * status only as a defensive fallback so the dock never invents capability.
 */
export function unwrapSimulatorCapabilityStatus(value: unknown): SimulatorCapabilityStatus | null {
  if (isCapabilityStatus(value)) return value
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.ok !== true) return null
  return isCapabilityStatus(record.status) ? record.status : null
}
