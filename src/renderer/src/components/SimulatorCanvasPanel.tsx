/**
 * Simulator Canvas dock surface — chat-owned live preview of Apple's iOS
 * Simulator. Human bezel gestures stay disabled until the host reports
 * actuationReady (idb); View & Control alone never invents device drive.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SIMULATOR_DEVICE_PRESETS,
  SIMULATOR_INSTALL_DOCS_URL,
  nextSimulatorRotateDirection,
  type SimulatorCapabilityStatus,
  type SimulatorDeviceInfo,
  type SimulatorFormFactor,
  type SimulatorGestureResult,
  type SimulatorHardwareButton,
  type SimulatorHostActionResult,
  type SimulatorInspectResult,
  type SimulatorInteractionStatus,
  type SimulatorRotateDirection,
  type SimulatorScreenshotFrame,
  type SimulatorScrollGesture,
  type SimulatorTapGesture,
  type SimulatorTypeGesture
} from '../../../shared/simulatorCanvas'
import {
  SIMULATOR_TOOL_DOCS_URL,
  simulatorTool,
  simulatorToolInstallCommands
} from '../../../shared/simulatorToolCatalog'
import {
  buildScrollGesture,
  buildTapGesture,
  buildTypeGesture,
  canSendSimulatorGestures,
  mapPointerToBezelNorm,
  previewOnlyBannerText,
  simulatorControllerBadgeText
} from '../lib/simulatorCanvasGestures'
import {
  actuateAfterSoftClaim,
  claimControlFailureMessage,
  isSimulatorFrameStale,
  shouldAcceptSimulatorScreenshotFrame
} from '../lib/simulatorCanvasPanelHelpers'
import { unwrapSimulatorCapabilityStatus } from '../lib/simulatorCanvasStatus'
import { PillButton } from './PillButton'

export interface SimulatorCanvasPanelProps {
  chatId: string
}

type SimulatorCanvasBridge = {
  status: () => Promise<SimulatorCapabilityStatus | { ok: true; status: SimulatorCapabilityStatus }>
  claimControl?: (chatId: string) => Promise<unknown>
  releaseControl?: (chatId: string) => Promise<unknown>
  session?: (chatId: string) => Promise<unknown>
  openApp: (chatId: string) => Promise<SimulatorHostActionResult>
  boot: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
  pickApp?: (
    chatId: string
  ) => Promise<{ ok: boolean; canceled: boolean; appPath?: string; error?: string }>
  install?: (
    chatId: string,
    udid: string,
    appPath: string
  ) => Promise<SimulatorHostActionResult>
  launch?: (
    chatId: string,
    udid: string,
    bundleId: string
  ) => Promise<SimulatorHostActionResult>
  terminate?: (
    chatId: string,
    udid: string,
    bundleId?: string
  ) => Promise<SimulatorHostActionResult>
  screenshot: (
    chatId: string,
    udid: string
  ) => Promise<SimulatorHostActionResult | SimulatorScreenshotFrame>
  listDevices?: () => Promise<SimulatorDeviceInfo[] | SimulatorCapabilityStatus>
  interactionStatus?: (chatId: string) => Promise<SimulatorInteractionStatus>
  tap?: (payload: SimulatorTapGesture) => Promise<SimulatorGestureResult>
  type?: (payload: SimulatorTypeGesture) => Promise<SimulatorGestureResult>
  scroll?: (payload: SimulatorScrollGesture) => Promise<SimulatorGestureResult>
  inspect?: (chatId: string, udid: string) => Promise<SimulatorInspectResult>
  button?: (
    chatId: string,
    udid: string,
    button: SimulatorHardwareButton
  ) => Promise<{ ok: boolean; error?: string }>
  rotate?: (
    chatId: string,
    udid: string,
    direction: SimulatorRotateDirection
  ) => Promise<{ ok: boolean; error?: string }>
}

const SCREENSHOT_POLL_MS = 1500
const INTERACTION_POLL_MS = 2000
const BRIDGE_MISSING_HINT = 'Restart TaskWraith to load the Simulator Canvas bridge.'

type BusyKind =
  | 'refresh'
  | 'open'
  | 'boot'
  | 'install'
  | 'launch'
  | 'terminate'
  | 'hardware'
  | null

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

function IdbInstallHint({ platform }: { platform: string }) {
  const entry = simulatorTool('idb')
  const companion = simulatorToolInstallCommands('idb', platform)[0]
  if (!entry) return null
  return (
    <div className="simulator-canvas-empty" role="status">
      <p>
        Xcode Simulator is available for preview. Install idb to drive tap, type, and swipe from
        this dock.
      </p>
      {companion ? (
        <p>
          <code>{companion.command}</code>
        </p>
      ) : null}
      <p>
        <code>pip3 install fb-idb</code>
      </p>
      <a
        className="simulator-canvas-docs-link"
        href={entry.docsUrl || SIMULATOR_TOOL_DOCS_URL}
        target="_blank"
        rel="noreferrer"
      >
        idb install docs
      </a>
    </div>
  )
}

export function SimulatorCanvasPanel({ chatId }: SimulatorCanvasPanelProps) {
  const bridge = getSimulatorCanvasBridge()
  const [status, setStatus] = useState<SimulatorCapabilityStatus | null>(null)
  const [selectedUdid, setSelectedUdid] = useState<string>('')
  const [frame, setFrame] = useState<SimulatorScreenshotFrame | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [interaction, setInteraction] = useState<SimulatorInteractionStatus | null>(null)
  const [typeBuffer, setTypeBuffer] = useState('')
  const [appPath, setAppPath] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [orientation, setOrientation] = useState<SimulatorRotateDirection>('PORTRAIT')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const screenRef = useRef<HTMLDivElement | null>(null)
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  const nextOrientation = nextSimulatorRotateDirection(orientation)

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
    const api = getSimulatorCanvasBridge()
    // Human dock is authoritative for this surface — claim controller on open so
    // idb actuationReady can arm without waiting for the first mutate. Await the
    // claim (and surface ok:false) before the first interaction refresh.
    // Release the human token on unmount / chat switch / hide (CanvasDock
    // unmounts this panel when showSimulator becomes false).
    let cancelled = false
    const claimThenRefresh = async (): Promise<void> => {
      if (api?.claimControl) {
        try {
          const result = await api.claimControl(chatId)
          if (cancelled || chatIdRef.current !== chatId) return
          const failure = claimControlFailureMessage(result)
          if (failure) setIssue(failure)
        } catch (error) {
          if (!cancelled && chatIdRef.current === chatId) {
            setIssue(error instanceof Error ? error.message : String(error))
          }
        }
      }
      if (!cancelled && chatIdRef.current === chatId) {
        await refreshInteraction()
      }
    }
    void claimThenRefresh()
    return () => {
      cancelled = true
      if (api?.releaseControl) {
        void api.releaseControl(chatId)
      }
    }
  }, [chatId, refreshInteraction])

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
  const hardwareControlsEnabled =
    selectedBooted && Boolean(interaction?.actuationReady) && gesturesEnabled
  const banner = previewOnlyBannerText(interaction)
  const controllerBadge = simulatorControllerBadgeText(interaction)
  const canMutateHost = Boolean(selectedUdid) && busy === null
  const frameStale = isSimulatorFrameStale(frame, nowMs)

  useEffect(() => {
    if (!frame) return
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, 500)
    return () => window.clearInterval(timer)
  }, [frame])

  useEffect(() => {
    // Clear immediately on device change so the prior udid's frame cannot linger.
    setFrame(null)
    const api = getSimulatorCanvasBridge()
    if (!api?.screenshot || !selectedUdid || !selectedBooted) {
      return
    }
    const pollUdid = selectedUdid
    let cancelled = false
    let timer: number | null = null

    const poll = async (): Promise<void> => {
      try {
        const result = await api.screenshot(chatId, pollUdid)
        if (cancelled || chatIdRef.current !== chatId) return
        const nextFrame = frameFromResult(result)
        if (nextFrame && shouldAcceptSimulatorScreenshotFrame(nextFrame, pollUdid)) {
          setFrame(nextFrame)
          setNowMs(Date.now())
        }
      } catch {
        // Preview is best-effort; keep the last good frame for this udid only.
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
      const result = await api.openApp(chatId)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not open Simulator.app.')
      }
      await refreshStatus()
      await refreshInteraction()
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
      const result = await api.boot(chatId, selectedUdid)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not boot the selected simulator.')
      }
      await refreshStatus()
      await refreshInteraction()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const pickAndInstallApp = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.install) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    if (!selectedUdid) {
      setIssue('Choose a simulator device before installing.')
      return
    }

    let path = appPath.trim()
    if (api.pickApp) {
      try {
        const picked = await api.pickApp(chatId)
        if (chatIdRef.current !== chatId) return
        if (picked?.canceled) return
        if (picked?.ok === false) {
          setIssue(picked.error || 'Could not open the .app picker.')
          return
        }
        if (picked?.appPath) {
          path = picked.appPath.trim()
          setAppPath(path)
        }
      } catch (error) {
        if (chatIdRef.current === chatId) {
          setIssue(error instanceof Error ? error.message : String(error))
        }
        return
      }
    }

    if (!path) {
      setIssue('Choose or enter an absolute .app path to install.')
      return
    }

    setBusy('install')
    setIssue(null)
    try {
      const result = await api.install(chatId, selectedUdid, path)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not install the selected .app.')
      }
      await refreshInteraction()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const installFromPathField = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.install) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    if (!selectedUdid) {
      setIssue('Choose a simulator device before installing.')
      return
    }
    const path = appPath.trim()
    if (!path) {
      setIssue('Enter an absolute .app path to install.')
      return
    }
    setBusy('install')
    setIssue(null)
    try {
      const result = await api.install(chatId, selectedUdid, path)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not install the selected .app.')
      }
      await refreshInteraction()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const launchBundle = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.launch) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    if (!selectedUdid) {
      setIssue('Choose a simulator device before launching.')
      return
    }
    const id = bundleId.trim()
    if (!id) {
      setIssue('Enter a bundle id to launch.')
      return
    }
    setBusy('launch')
    setIssue(null)
    try {
      const result = await api.launch(chatId, selectedUdid, id)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not launch the app.')
      }
      await refreshInteraction()
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const terminateBundle = async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.terminate) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    if (!selectedUdid) {
      setIssue('Choose a simulator device before terminating.')
      return
    }
    const id = bundleId.trim()
    if (!id) {
      setIssue('Enter a bundle id to terminate.')
      return
    }
    setBusy('terminate')
    setIssue(null)
    try {
      const result = await api.terminate(chatId, selectedUdid, id)
      if (chatIdRef.current !== chatId) return
      if (result && result.ok === false) {
        setIssue(result.error || 'Could not terminate the app.')
      }
      await refreshInteraction()
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

  /** Soft-claim human control when the mount claim/lease is missing (e.g. after release race). */
  const ensureHumanLease = async (): Promise<boolean> => {
    if (interaction?.controllerLeaseHeld) return true
    const api = getSimulatorCanvasBridge()
    if (!api?.claimControl) return false
    try {
      const result = await api.claimControl(chatId)
      if (chatIdRef.current !== chatId) return false
      const failure = claimControlFailureMessage(result)
      if (failure) {
        setIssue(failure)
        return false
      }
      await refreshInteraction()
      return true
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  const handleBezelPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.tap) return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    void (async () => {
      const gated = await actuateAfterSoftClaim(ensureHumanLease, () =>
        api.tap!(buildTapGesture(chatId, point))
      )
      if (chatIdRef.current !== chatId || !gated.ok) return
      const result = gated.value
      // Never treat recorded-but-deferred as success — surface the host error.
      if (result && result.ok === false) {
        setIssue(result.error || 'Tap was refused.')
      }
    })().catch((error: unknown) => {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
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
    const deltaX = event.deltaX
    const deltaY = event.deltaY
    void (async () => {
      const gated = await actuateAfterSoftClaim(ensureHumanLease, () =>
        api.scroll!(buildScrollGesture(chatId, point, deltaX, deltaY))
      )
      if (chatIdRef.current !== chatId || !gated.ok) return
      const result = gated.value
      if (result && result.ok === false) {
        setIssue(result.error || 'Scroll was refused.')
      }
    })().catch((error: unknown) => {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    })
  }

  const submitTypeBuffer = (): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.type) return
    const text = typeBuffer
    if (!text) return
    void (async () => {
      const gated = await actuateAfterSoftClaim(ensureHumanLease, () =>
        api.type!(buildTypeGesture(chatId, text))
      )
      if (chatIdRef.current !== chatId || !gated.ok) return
      const result = gated.value
      if (result && result.ok === false) {
        setIssue(result.error || 'Type was refused.')
        return
      }
      // Clear the buffer only when the host actually actuated the type.
      if (result?.ok === true) {
        setTypeBuffer('')
      }
    })().catch((error: unknown) => {
      if (chatIdRef.current === chatId) {
        setIssue(error instanceof Error ? error.message : String(error))
      }
    })
  }

  const pressHardwareButton = (button: SimulatorHardwareButton): void => {
    if (!hardwareControlsEnabled || !selectedUdid) return
    const api = getSimulatorCanvasBridge()
    if (!api?.button) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    setBusy('hardware')
    setIssue(null)
    void api
      .button(chatId, selectedUdid, button)
      .then((result) => {
        if (chatIdRef.current !== chatId) return
        if (result && result.ok === false) {
          setIssue(result.error || `${button} was refused.`)
        }
      })
      .catch((error: unknown) => {
        if (chatIdRef.current === chatId) {
          setIssue(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (chatIdRef.current === chatId) setBusy(null)
      })
  }

  const rotateDevice = (): void => {
    if (!hardwareControlsEnabled || !selectedUdid) return
    const api = getSimulatorCanvasBridge()
    if (!api?.rotate) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    const direction = nextOrientation
    setBusy('hardware')
    setIssue(null)
    void api
      .rotate(chatId, selectedUdid, direction)
      .then((result) => {
        if (chatIdRef.current !== chatId) return
        if (result && result.ok === false) {
          setIssue(result.error || 'Rotate was refused.')
          return
        }
        setOrientation(direction)
      })
      .catch((error: unknown) => {
        if (chatIdRef.current === chatId) {
          setIssue(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (chatIdRef.current === chatId) setBusy(null)
      })
  }

  if (!bridge?.status) {
    return (
      <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
        <div className="simulator-canvas-toolbar">
          <div>
            <div className="simulator-canvas-title">Simulator Canvas</div>
            <div className="simulator-canvas-subtitle">
              Preview an iOS Simulator in this chat.
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
              Preview an iOS Simulator in this chat.
            </div>
          </div>
          <PillButton
            size="compact"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
            loading={busy === 'refresh'}
          >
            Refresh
          </PillButton>
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
  const showIdbInstallHint = Boolean(status?.installed && status.idbAvailable === false)
  const frameSrc = frame ? `data:image/png;base64,${frame.pngBase64}` : null
  const hasPickApp = Boolean(bridge.pickApp)
  const hasInstall = Boolean(bridge.install)
  const hasLaunch = Boolean(bridge.launch)
  const hasTerminate = Boolean(bridge.terminate)

  return (
    <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
      <div className="simulator-canvas-toolbar">
        <div>
          <div className="simulator-canvas-title">Simulator Canvas</div>
          <div className="simulator-canvas-subtitle">
            Preview an iOS Simulator in this chat.
          </div>
        </div>
        <div className="simulator-canvas-actions">
          <PillButton
            size="compact"
            onClick={() => void openSimulatorApp()}
            disabled={busy !== null}
            loading={busy === 'open'}
          >
            {busy === 'open' ? 'Opening…' : 'Open Simulator App'}
          </PillButton>
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
          <PillButton
            size="compact"
            onClick={() => void bootSelected()}
            disabled={busy !== null || !selectedUdid || selectedBooted}
            loading={busy === 'boot'}
          >
            {busy === 'boot' ? 'Booting…' : 'Boot'}
          </PillButton>
          <PillButton
            size="compact"
            onClick={() => void refreshStatus()}
            disabled={busy !== null}
            loading={busy === 'refresh'}
          >
            Refresh
          </PillButton>
        </div>
      </div>

      {controllerBadge ? (
        <div
          className={`simulator-canvas-controller-chip${
            interaction?.controllerKind === 'run' ? ' is-agent' : ' is-human'
          }`}
          role="status"
        >
          {controllerBadge}
        </div>
      ) : null}

      {banner ? (
        <div className="simulator-canvas-banner" role="status">
          {banner}
        </div>
      ) : null}

      {showIdbInstallHint ? <IdbInstallHint platform={status?.platform || 'darwin'} /> : null}

      {(hasInstall || hasLaunch || hasTerminate) && (
        <div className="simulator-canvas-qa" aria-label="Simulator app controls">
          {hasInstall ? (
            <div className="simulator-canvas-qa-row">
              {hasPickApp ? (
                <PillButton
                  size="compact"
                  onClick={() => void pickAndInstallApp()}
                  disabled={!canMutateHost}
                  loading={busy === 'install'}
                >
                  {busy === 'install' ? 'Installing…' : 'Install .app'}
                </PillButton>
              ) : null}
              <input
                className="simulator-canvas-qa-input"
                type="text"
                value={appPath}
                onChange={(event) => setAppPath(event.target.value)}
                placeholder="/absolute/path/App.app"
                aria-label="Absolute .app path"
                disabled={busy !== null}
              />
              {!hasPickApp ? (
                <PillButton
                  size="compact"
                  onClick={() => void installFromPathField()}
                  disabled={!canMutateHost || !appPath.trim()}
                  loading={busy === 'install'}
                >
                  {busy === 'install' ? 'Installing…' : 'Install'}
                </PillButton>
              ) : (
                <PillButton
                  size="compact"
                  variant="ghost"
                  onClick={() => void installFromPathField()}
                  disabled={!canMutateHost || !appPath.trim()}
                  loading={busy === 'install'}
                >
                  Install path
                </PillButton>
              )}
            </div>
          ) : null}

          {(hasLaunch || hasTerminate) && (
            <div className="simulator-canvas-qa-row">
              <input
                className="simulator-canvas-qa-input"
                type="text"
                value={bundleId}
                onChange={(event) => setBundleId(event.target.value)}
                placeholder="com.example.App"
                aria-label="Bundle identifier"
                disabled={busy !== null}
              />
              {hasLaunch ? (
                <PillButton
                  size="compact"
                  onClick={() => void launchBundle()}
                  disabled={!canMutateHost || !bundleId.trim()}
                  loading={busy === 'launch'}
                >
                  {busy === 'launch' ? 'Launching…' : 'Launch'}
                </PillButton>
              ) : null}
              {hasTerminate ? (
                <PillButton
                  size="compact"
                  variant="danger"
                  onClick={() => void terminateBundle()}
                  disabled={!canMutateHost || !bundleId.trim()}
                  loading={busy === 'terminate'}
                >
                  {busy === 'terminate' ? 'Stopping…' : 'Terminate'}
                </PillButton>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="simulator-canvas-stage">
        <div
          className={`simulator-canvas-bezel is-${formFactor}${gesturesEnabled ? ' is-interactive' : ''}${frameStale ? ' is-stale' : ''}`}
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
            {frameStale ? (
              <div className="simulator-canvas-stale" role="status">
                Stale
              </div>
            ) : null}
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
          <PillButton size="compact" onClick={submitTypeBuffer} disabled={!typeBuffer}>
            Send
          </PillButton>
        </div>
      ) : null}

      <div className="simulator-canvas-hardware" aria-label="Simulator hardware controls">
        <PillButton
          size="compact"
          onClick={() => pressHardwareButton('HOME')}
          disabled={!hardwareControlsEnabled || busy !== null || !selectedUdid}
          loading={busy === 'hardware'}
        >
          Home
        </PillButton>
        <PillButton
          size="compact"
          onClick={() => pressHardwareButton('LOCK')}
          disabled={!hardwareControlsEnabled || busy !== null || !selectedUdid}
          loading={busy === 'hardware'}
        >
          Lock
        </PillButton>
        <PillButton
          size="compact"
          onClick={() => rotateDevice()}
          disabled={!hardwareControlsEnabled || busy !== null || !selectedUdid}
          loading={busy === 'hardware'}
          title={`Current ${orientation} → next ${nextOrientation}`}
        >
          Rotate → {nextOrientation}
        </PillButton>
      </div>

      <div className="simulator-canvas-footer" role="note">
        Home / Lock use <code>idb ui button</code>. Rotate cycles absolute orientations via{' '}
        <code>idb ui rotate {nextOrientation}</code> (now {orientation}). Agents can call{' '}
        <code>simulator_inspect</code> for a truncated AX tree.
      </div>

      {issue && (
        <div className="simulator-canvas-issue" role="alert">
          {issue}
        </div>
      )}
    </section>
  )
}
