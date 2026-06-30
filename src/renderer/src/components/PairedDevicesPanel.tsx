import { useCallback, useEffect, useState, type JSX } from 'react'

interface PairedDeviceRow {
  iphoneIdentityPubKey: string
  pairId: string
  controllerDisplayName: string
  pairedAt: string
  connected: boolean
}

function formatPairedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

export function PairedDevicesPanel(): JSX.Element {
  const [devices, setDevices] = useState<PairedDeviceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const result = (await window.api.bridgeListPairedDevices()) as PairedDeviceRow[]
      setDevices(result ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh()
    }, 0)
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [refresh])

  const onRemove = useCallback(
    async (device: PairedDeviceRow) => {
      const label = device.controllerDisplayName || 'this device'
      if (!window.confirm(`Remove ${label} from paired devices? It will need to scan the QR again.`)) {
        return
      }
      setBusyKey(device.iphoneIdentityPubKey)
      try {
        const result = (await window.api.bridgeUnpairDevice(device.iphoneIdentityPubKey)) as {
          ok?: boolean
          error?: string
        }
        if (!result?.ok) {
          setError(result?.error || 'Failed to remove paired device.')
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyKey(null)
      }
    },
    [refresh]
  )

  return (
    <section className="settings-group paired-devices-panel">
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {loading && devices.length === 0 ? (
        <div className="settings-muted" role="status">
          Loading paired devices…
        </div>
      ) : devices.length === 0 ? (
        <div className="settings-muted">
          No paired iPhone or iPad yet. Scan the QR above to add your first device.
        </div>
      ) : (
        <ul className="paired-devices-panel__list">
          {devices.map((device) => (
            <li key={device.iphoneIdentityPubKey} className="paired-devices-panel__row">
              <div className="paired-devices-panel__meta">
                <div className="paired-devices-panel__name">
                  {device.controllerDisplayName || 'iOS device'}
                </div>
                <div className="paired-devices-panel__details">
                  <span
                    className={
                      device.connected
                        ? 'paired-devices-panel__status paired-devices-panel__status--connected'
                        : 'paired-devices-panel__status'
                    }
                  >
                    {device.connected ? 'Connected' : 'Not connected'}
                  </span>
                  <span className="paired-devices-panel__paired-at">
                    Paired {formatPairedAt(device.pairedAt)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyKey === device.iphoneIdentityPubKey}
                onClick={() => void onRemove(device)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
