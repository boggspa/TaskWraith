import { useCallback, useEffect, useState } from 'react'
import type {
  SimulatorControlSetupResult,
  SimulatorControlSetupStatus
} from '../../../shared/simulatorControlSetup'
import { PillButton } from './PillButton'

const NOTE_STYLE = { font: '11px/1.4 system-ui, sans-serif', opacity: 0.7 } as const
const ALERT_STYLE = {
  font: '11px/1.35 system-ui, sans-serif',
  color: 'var(--status-failed, #e5484d)'
} as const

/**
 * A deliberately small, product-language control for the optional local
 * companion behind Simulator Canvas interaction. This is not AppDrive: it
 * controls only iOS Simulator input from the Canvas, for both people and
 * agents, while preview remains read-only when disabled.
 */
export function SimulatorControlSettingsCard() {
  const [status, setStatus] = useState<SimulatorControlSetupStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const api = typeof window !== 'undefined' ? window.api : undefined

  const refresh = useCallback(async (): Promise<SimulatorControlSetupStatus | null> => {
    if (!api?.simulatorControl) return null
    try {
      const next = await api.simulatorControl.status()
      setStatus(next)
      return next
    } catch {
      return null
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!api || !api.simulatorControl || !status) return null

  const updateEnabled = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.updateSettings({ simulatorControlEnabled: enabled })
      const next = await refresh()
      if (!next) throw new Error('Could not refresh Simulator control.')
      setNotice(enabled ? 'Simulator control is on.' : 'Simulator control is off.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update Simulator control.')
    } finally {
      setBusy(false)
    }
  }

  const setup = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result: SimulatorControlSetupResult = await api.simulatorControl.setup()
      setStatus(result)
      if (!result.ok) {
        setError(result.error || 'Simulator control could not finish setup.')
        return
      }
      const next = await refresh()
      setNotice(next?.enabled ? 'Simulator control is ready.' : 'Simulator control is set up.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulator control could not finish setup.')
    } finally {
      setBusy(false)
    }
  }

  const canSetUp = status.supported && !status.ready

  return (
    <div className="settings-mcp-bridge-card">
      <div className="settings-mcp-bridge-actions" style={{ alignItems: 'center' }}>
        <label className="settings-effects-check-row" style={{ flex: '1 1 260px' }}>
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy || !status.supported}
            onChange={(event) => void updateEnabled(event.target.checked)}
          />
          <span>
            Simulator control
            <small>
              Lets you and agents use apps directly from Canvas. Turning it off keeps the screen
              preview available but stops device input.
            </small>
          </span>
        </label>
        {canSetUp ? (
          <PillButton size="compact" variant="primary" disabled={busy} onClick={() => void setup()}>
            {busy ? 'Setting up…' : 'Set up'}
          </PillButton>
        ) : null}
      </div>

      {error ? (
        <div role="alert" style={ALERT_STYLE}>
          {error}
        </div>
      ) : notice ? (
        <div style={NOTE_STYLE}>{notice}</div>
      ) : (
        <div style={NOTE_STYLE}>{status.message}</div>
      )}
    </div>
  )
}
