/**
 * Simulator Canvas dock surface — chat-owned live preview of Apple's iOS
 * Simulator. The bridge (window.api.simulatorCanvas) may be absent until a
 * restart loads the preload; the UI stays defensive and never invents grants.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SIMULATOR_DEVICE_PRESETS,
  SIMULATOR_INSTALL_DOCS_URL,
  type SimulatorCapabilityStatus,
  type SimulatorDeviceInfo,
  type SimulatorFormFactor,
  type SimulatorHostActionResult,
  type SimulatorScreenshotFrame
} from '../../../shared/simulatorCanvas'
import { unwrapSimulatorCapabilityStatus } from '../lib/simulatorCanvasStatus'

export interface SimulatorCanvasPanelProps {
  chatId: string
}

type SimulatorCanvasBridge = {
  status: () => Promise<unknown>
  openApp: () => Promise<SimulatorHostActionResult>
  boot: (udid: string) => Promise<SimulatorHostActionResult>
  screenshot: (udid: string) => Promise<SimulatorHostActionResult | SimulatorScreenshotFrame>
  listDevices?: () => Promise<unknown>
}

const SCREENSHOT_POLL_MS = 1500
const BRIDGE_MISSING_HINT = 'Restart TaskWraith to load the Simulator Canvas bridge.'

function getSimulatorCanvasBridge(): SimulatorCanvasBridge | undefined {
  const api = (window as unknown as { api?: { simulatorCanvas?: SimulatorCanvasBridge } }).api
  return api?.simulatorCanvas
}

function isScreenshotFrame(value: unknown): value is SimulatorScreenshotFrame {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.pngBase64 === 'string' && record.pngBase64.length > 0
}

function frameFromResult(value: unknown): SimulatorScreenshotFrame | null {
  if (isScreenshotFrame(value)) return value
  if (
    value &&
    typeof value === 'object' &&
    isScreenshotFrame((value as SimulatorHostActionResult).frame)
  ) {
    return (value as SimulatorHostActionResult).frame ?? null
  }
  return null
}

export function resolveSimulatorFormFactor(deviceName: string | undefined): SimulatorFormFactor {
  const name = (deviceName || '').trim()
  if (!name) return 'phone'
  const lower = name.toLowerCase()
  for (const preset of SIMULATOR_DEVICE_PRESETS) {
    if (lower.includes(preset.id) || lower.includes(preset.label.toLowerCase())) {
      return preset.formFactor
    }
  }
  if (/ipad|tablet/.test(lower)) return 'tablet'
  return 'phone'
}

function deviceOptions(status: SimulatorCapabilityStatus | null): SimulatorDeviceInfo[] {
  if (!status) return []
  const byUdid = new Map<string, SimulatorDeviceInfo>()
  for (const device of status.bootedDevices) byUdid.set(device.udid, device)
  for (const device of status.availableDevices) {
    if (!byUdid.has(device.udid)) byUdid.set(device.udid, device)
  }
  return Array.from(byUdid.values())
}

export function SimulatorCanvasPanel({ chatId }: SimulatorCanvasPanelProps) {
  const bridge = getSimulatorCanvasBridge()
  const [status, setStatus] = useState<SimulatorCapabilityStatus | null>(null)
  const [selectedUdid, setSelectedUdid] = useState<string>('')
  const [frame, setFrame] = useState<SimulatorScreenshotFrame | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'open' | 'boot' | null>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const refreshStatus = useCallback(async (): Promise<SimulatorCapabilityStatus | null> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.status) {
      setStatus(null)
      return null
    }
    setBusy((current) => current ?? 'refresh')
    try {
      const next = unwrapSimulatorCapabilityStatus(await api.status())
      if (chatIdRef.current !== chatId) return null
      if (!next) {
        setIssue('Simulator Canvas status was unavailable.')
        return null
      }
      setStatus(next)
      setIssue(null)
      setSelectedUdid((current) => {
        if (
          current &&
          [...next.bootedDevices, ...next.availableDevices].some((d) => d.udid === current)
        ) {
          return current
        }
        return next.bootedDevices[0]?.udid || next.availableDevices[0]?.udid || ''
      })
      return next
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
      return null
    } finally {
      if (chatIdRef.current === chatId) {
        setBusy((current) => (current === 'refresh' ? null : current))
      }
    }
  }, [chatId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const selectedDevice = useMemo(() => {
    return deviceOptions(status).find((device) => device.udid === selectedUdid) ?? null
  }, [selectedUdid, status])

  const selectedBooted = Boolean(
    selectedDevice &&
    (selectedDevice.state === 'Booted' ||
      status?.bootedDevices.some((device) => device.udid === selectedDevice.udid))
  )

  const formFactor = resolveSimulatorFormFactor(selectedDevice?.name)

  useEffect(() => {
    const api = getSimulatorCanvasBridge()
    if (!api?.screenshot || !selectedUdid || !selectedBooted) {
      setFrame(null)
      return
    }
    let cancelled = false
    let timer: number | null = null

    const poll = async (): Promise<void> => {
      try {
        const result = await api.screenshot(selectedUdid)
        if (cancelled || chatIdRef.current !== chatId) return
        const nextFrame = frameFromResult(result)
        if (nextFrame) setFrame(nextFrame)
      } catch {
        // Preview is best-effort; keep the last good frame.
      } finally {
        if (!cancelled && chatIdRef.current === chatId) {
          timer = window.setTimeout(() => {
            void poll()
          }, SCREENSHOT_POLL_MS)
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [chatId, selectedBooted, selectedUdid])

  const openSimulatorApp = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.openApp) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    setBusy('open')
    setIssue(null)
    try {
      const result = await api.openApp()
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not open Simulator.app.')
      }
      await refreshStatus()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const bootSelected = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.boot) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    if (!selectedUdid) {
      setIssue('Choose a simulator device to boot.')
      return
    }
    setBusy('boot')
    setIssue(null)
    try {
      const result = await api.boot(selectedUdid)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not boot the selected simulator.')
      }
      await refreshStatus()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  if (!bridge?.status) {
    return (
      <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
        <div className="simulator-canvas-toolbar">
          <div>
            <div className="simulator-canvas-title">Simulator Canvas</div>
            <div className="simulator-canvas-subtitle">
              Preview and drive an iOS Simulator in this chat.
            </div>
          </div>
        </div>
        <div className="simulator-canvas-empty" role="status">
          {BRIDGE_MISSING_HINT}
        </div>
      </section>
    )
  }

  if (!status) {
    return (
      <section
        className="simulator-canvas-panel"
        aria-label="Simulator Canvas"
        aria-busy={busy !== null}
      >
        <div className="simulator-canvas-toolbar">
          <div>
            <div className="simulator-canvas-title">Simulator Canvas</div>
            <div className="simulator-canvas-subtitle">
              Preview and drive an iOS Simulator in this chat.
            </div>
          </div>
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
          >
            {busy === 'refresh' ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <div
          className={`simulator-canvas-empty${busy === 'refresh' ? ' is-busy' : ''}`}
          role="status"
        >
          {busy === 'refresh' || !issue
            ? 'Checking Simulator availability…'
            : 'Simulator status unavailable. Try Refresh.'}
        </div>
        {issue && (
          <div className="simulator-canvas-issue" role="alert">
            {issue}
          </div>
        )}
      </section>
    )
  }

  if (!status.installed) {
    const docsUrl = status.docsUrl || SIMULATOR_INSTALL_DOCS_URL
    return (
      <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
        <div className="simulator-canvas-toolbar">
          <div>
            <div className="simulator-canvas-title">Simulator Canvas</div>
            <div className="simulator-canvas-subtitle">
              Preview and drive an iOS Simulator in this chat.
            </div>
          </div>
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
          >
            Refresh
          </button>
        </div>
        <div className="simulator-canvas-empty" role="status">
          <p>{status.installHint}</p>
          <a className="simulator-canvas-docs-link" href={docsUrl} target="_blank" rel="noreferrer">
            Install Xcode / Simulator
          </a>
        </div>
        {issue && (
          <div className="simulator-canvas-issue" role="alert">
            {issue}
          </div>
        )}
      </section>
    )
  }

  const options = deviceOptions(status)
  const frameSrc = frame ? `data:image/png;base64,${frame.pngBase64}` : null

  return (
    <section
      className="simulator-canvas-panel"
      aria-label="Simulator Canvas"
      aria-busy={busy !== null}
    >
      <div className="simulator-canvas-toolbar">
        <div>
          <div className="simulator-canvas-title">Simulator Canvas</div>
          <div className="simulator-canvas-subtitle">
            Preview and drive an iOS Simulator in this chat.
          </div>
        </div>
        <div className="simulator-canvas-actions">
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={() => void openSimulatorApp()}
            disabled={busy !== null}
          >
            {busy === 'open' ? 'Opening…' : 'Open Simulator App'}
          </button>
          <label className="simulator-canvas-device">
            <span className="simulator-canvas-device-label">Device</span>
            <select
              value={selectedUdid}
              onChange={(event) => setSelectedUdid(event.target.value)}
              disabled={busy !== null || options.length === 0}
              aria-label="Simulator device"
            >
              {options.length === 0 ? (
                <option value="">No devices</option>
              ) : (
                options.map((device) => (
                  <option key={device.udid} value={device.udid}>
                    {device.name}
                    {device.state === 'Booted' ? ' (Booted)' : ''}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={() => void bootSelected()}
            disabled={busy !== null || !selectedUdid || selectedBooted}
          >
            {busy === 'boot' ? 'Booting…' : 'Boot'}
          </button>
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="simulator-canvas-stage">
        <div
          className={`simulator-canvas-bezel is-${formFactor}`}
          data-form-factor={formFactor}
          aria-label={`${formFactor === 'tablet' ? 'iPad' : 'iPhone'} simulator preview`}
        >
          <div className="simulator-canvas-bezel-notch" aria-hidden="true" />
          <div className="simulator-canvas-bezel-screen">
            {frameSrc ? (
              <img
                className="simulator-canvas-frame"
                src={frameSrc}
                alt="Simulator screenshot"
                draggable={false}
              />
            ) : (
              <div
                className={`simulator-canvas-frame-placeholder${busy === 'boot' ? ' is-busy' : ''}`}
              >
                {busy === 'boot'
                  ? 'Booting simulator…'
                  : selectedBooted
                    ? 'Waiting for the next simulator frame…'
                    : 'Boot a device to start the live preview.'}
              </div>
            )}
          </div>
          <div className="simulator-canvas-bezel-home" aria-hidden="true" />
        </div>
      </div>

      {issue && (
        <div className="simulator-canvas-issue" role="alert">
          {issue}
        </div>
      )}
    </section>
  )
}
