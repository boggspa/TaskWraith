/**
 * Simulator Canvas dock surface — chat-owned live preview of Apple's iOS
 * Simulator. Human bezel gestures are gated on View & Control; without a lease
 * this stays preview-only and never invents desktop control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SIMULATOR_DEVICE_PRESETS,
  SIMULATOR_INSTALL_DOCS_URL,
  type SimulatorCapabilityStatus,
  type SimulatorDeviceInfo,
  type SimulatorFormFactor,
  type SimulatorGestureResult,
  type SimulatorHostActionResult,
  type SimulatorInteractionStatus,
  type SimulatorScreenshotFrame,
  type SimulatorScrollGesture,
  type SimulatorTapGesture,
  type SimulatorTypeGesture
} from '../../../shared/simulatorCanvas'
import {
  buildScrollGesture,
  buildTapGesture,
  buildTypeGesture,
  canSendSimulatorGestures,
  mapPointerToBezelNorm,
  previewOnlyBannerText
} from '../lib/simulatorCanvasGestures'

export interface SimulatorCanvasPanelProps {
  chatId: string
}

type SimulatorCanvasBridge = {
  status: () => Promise<SimulatorCapabilityStatus | { ok: true; status: SimulatorCapabilityStatus }>
  openApp: () => Promise<SimulatorHostActionResult>
  boot: (udid: string) => Promise<SimulatorHostActionResult>
  screenshot: (udid: string) => Promise<SimulatorHostActionResult | SimulatorScreenshotFrame>
  listDevices?: () => Promise<SimulatorDeviceInfo[] | SimulatorCapabilityStatus>
  interactionStatus?: (chatId: string) => Promise<SimulatorInteractionStatus>
  tap?: (payload: SimulatorTapGesture) => Promise<SimulatorGestureResult>
  type?: (payload: SimulatorTypeGesture) => Promise<SimulatorGestureResult>
  scroll?: (payload: SimulatorScrollGesture) => Promise<SimulatorGestureResult>
}

const SCREENSHOT_POLL_MS = 1500
const INTERACTION_POLL_MS = 2000
const BRIDGE_MISSING_HINT = 'Restart TaskWraith to load the Simulator Canvas bridge.'

function getSimulatorCanvasBridge(): SimulatorCanvasBridge | undefined {
  const api = (window as unknown as { api?: { simulatorCanvas?: SimulatorCanvasBridge } }).api
  return api?.simulatorCanvas
}

function isCapabilityStatus(value: unknown): value is SimulatorCapabilityStatus {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.installed === 'boolean' && typeof record.docsUrl === 'string'
}

function unwrapCapabilityStatus(value: unknown): SimulatorCapabilityStatus | null {
  if (isCapabilityStatus(value)) return value
  if (
    value &&
    typeof value === 'object' &&
    isCapabilityStatus((value as { status?: unknown }).status)
  ) {
    return (value as { status: SimulatorCapabilityStatus }).status
  }
  return null
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
  const [interaction, setInteraction] = useState<SimulatorInteractionStatus | null>(null)
  const [typeBuffer, setTypeBuffer] = useState('')
  const screenRef = useRef<HTMLDivElement | null>(null)
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
      const next = unwrapCapabilityStatus(await api.status())
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

  const refreshInteraction = useCallback(async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.interactionStatus) {
      setInteraction(null)
      return
    }
    try {
      const next = await api.interactionStatus(chatId)
      if (chatIdRef.current !== chatId) return
      setInteraction(next)
    } catch {
      if (chatIdRef.current === chatId) setInteraction(null)
    }
  }, [chatId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    void refreshInteraction()
    const timer = window.setInterval(() => {
      void refreshInteraction()
    }, INTERACTION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshInteraction])

  const selectedDevice = useMemo(() => {
    return deviceOptions(status).find((device) => device.udid === selectedUdid) ?? null
  }, [selectedUdid, status])

  const selectedBooted = Boolean(
    selectedDevice &&
    (selectedDevice.state === 'Booted' ||
      status?.bootedDevices.some((device) => device.udid === selectedDevice.udid))
  )

  const formFactor = resolveSimulatorFormFactor(selectedDevice?.name)
  const gesturesEnabled = canSendSimulatorGestures(interaction)
  const banner = previewOnlyBannerText(interaction)

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

  const pointFromEvent = (event: {
    clientX: number
    clientY: number
  }): {
    x: number
    y: number
  } | null => {
    const el = screenRef.current
    if (!el) return null
    return mapPointerToBezelNorm(event.clientX, event.clientY, el.getBoundingClientRect())
  }

  const handleBezelPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.tap) return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    void api.tap(buildTapGesture(chatId, point)).then((result) => {
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false && !result.recorded) {
        setIssue(result.error || 'Tap was refused.')
      }
    })
  }

  const handleBezelWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.scroll) return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    void api
      .scroll(buildScrollGesture(chatId, point, event.deltaX, event.deltaY))
      .then((result) => {
        if (chatIdRef.current !== chatId) return
        if (result && result.ok === false && !result.recorded) {
          setIssue(result.error || 'Scroll was refused.')
        }
      })
  }

  const submitTypeBuffer = (): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.type) return
    const text = typeBuffer
    if (!text) return
    void api.type(buildTypeGesture(chatId, text)).then((result) => {
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false && !result.recorded) {
        setIssue(result.error || 'Type was refused.')
        return
      }
      setTypeBuffer('')
    })
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

  if (status && !status.installed) {
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
    <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
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

      {banner ? (
        <div className="simulator-canvas-banner" role="status">
          {banner}
        </div>
      ) : null}

      <div className="simulator-canvas-stage">
        <div
          className={`simulator-canvas-bezel is-${formFactor}${gesturesEnabled ? ' is-interactive' : ''}`}
          data-form-factor={formFactor}
          aria-label={`${formFactor === 'tablet' ? 'iPad' : 'iPhone'} simulator preview`}
        >
          <div className="simulator-canvas-bezel-notch" aria-hidden="true" />
          <div
            ref={screenRef}
            className="simulator-canvas-bezel-screen"
            onPointerDown={handleBezelPointerDown}
            onWheel={handleBezelWheel}
          >
            {frameSrc ? (
              <img
                className="simulator-canvas-frame"
                src={frameSrc}
                alt="Simulator screenshot"
                draggable={false}
              />
            ) : (
              <div className="simulator-canvas-frame-placeholder">
                {selectedBooted
                  ? 'Waiting for the next simulator frame…'
                  : 'Boot a device to start the live preview.'}
              </div>
            )}
          </div>
          <div className="simulator-canvas-bezel-home" aria-hidden="true" />
        </div>
      </div>

      {gesturesEnabled ? (
        <div className="simulator-canvas-typebar">
          <input
            className="simulator-canvas-type-input"
            type="text"
            value={typeBuffer}
            onChange={(event) => setTypeBuffer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitTypeBuffer()
              }
            }}
            placeholder="Type into Simulator…"
            aria-label="Type into Simulator"
          />
          <button
            type="button"
            className="simulator-canvas-action"
            onClick={submitTypeBuffer}
            disabled={!typeBuffer}
          >
            Send
          </button>
        </div>
      ) : null}

      {issue && (
        <div className="simulator-canvas-issue" role="alert">
          {issue}
        </div>
      )}
    </section>
  )
}
