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
import type {
  SimulatorControlSetupResult,
  SimulatorControlSetupStatus
} from '../../../shared/simulatorControlSetup'
import {
  buildScrollGesture,
  buildTapGesture,
  buildTypeGesture,
  canSendSimulatorGestures,
  mapPointerToBezelNorm,
  previewOnlyBannerText
} from '../lib/simulatorCanvasGestures'
import {
  actuateAfterSoftClaim,
  claimControlFailureMessage,
  isSimulatorFrameStale,
  orientationFromSessionPayload,
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
  clipboardPush?: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
  clipboardPull?: (chatId: string, udid: string) => Promise<SimulatorHostActionResult>
}

type SimulatorControlBridge = {
  status: () => Promise<SimulatorControlSetupStatus>
  setup: () => Promise<SimulatorControlSetupResult>
}

const SCREENSHOT_POLL_MS = 1500
const INTERACTION_POLL_MS = 2000
const CONTROL_STATUS_POLL_MS = 5000
const BRIDGE_MISSING_HINT = 'Restart TaskWraith to load the Simulator Canvas bridge.'

type BusyKind =
  | 'refresh'
  | 'open'
  | 'boot'
  | 'install'
  | 'launch'
  | 'terminate'
  | 'hardware'
  | 'clipboard'
  | 'setup'
  | null

function getSimulatorCanvasBridge(): SimulatorCanvasBridge | undefined {
  const api = (window as unknown as { api?: { simulatorCanvas?: SimulatorCanvasBridge } }).api
  return api?.simulatorCanvas
}

function getSimulatorControlBridge(): SimulatorControlBridge | undefined {
  const api = (window as unknown as { api?: { simulatorControl?: SimulatorControlBridge } }).api
  return api?.simulatorControl
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
  const [controlStatus, setControlStatus] = useState<SimulatorControlSetupStatus | null>(null)
  const [controlIssue, setControlIssue] = useState<string | null>(null)
  const [selectedUdid, setSelectedUdid] = useState<string>('')
  const [frame, setFrame] = useState<SimulatorScreenshotFrame | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyKind>(null)
  const [interaction, setInteraction] = useState<SimulatorInteractionStatus | null>(null)
  const [appPath, setAppPath] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [orientation, setOrientation] = useState<SimulatorRotateDirection>('PORTRAIT')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const screenRef = useRef<HTMLDivElement | null>(null)
  const pendingTextRef = useRef('')
  const textFlushInFlightRef = useRef(false)
  const dragRef = useRef<{
    pointerId: number
    point: { x: number; y: number }
    clientX: number
    clientY: number
  } | null>(null)
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

  const refreshControlStatus = useCallback(
    async (): Promise<SimulatorControlSetupStatus | null> => {
      const api = getSimulatorControlBridge()
      if (!api?.status) {
        setControlStatus(null)
        return null
      }
      try {
        const next = await api.status()
        if (chatIdRef.current !== chatId) return null
        setControlStatus(next)
        return next
      } catch {
        if (chatIdRef.current === chatId) setControlStatus(null)
        return null
      }
    },
    [chatId]
  )

  const adoptServerOrientation = useCallback((payload: unknown): void => {
    const next = orientationFromSessionPayload(payload)
    if (next) setOrientation(next)
  }, [])

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
      adoptServerOrientation(next)
    } catch {
      if (chatIdRef.current === chatId) setInteraction(null)
    }
  }, [adoptServerOrientation, chatId])

  const refreshSessionOrientation = useCallback(async (): Promise<void> => {
    const api = getSimulatorCanvasBridge()
    if (!api?.session) return
    try {
      const payload = await api.session(chatId)
      if (chatIdRef.current !== chatId) return
      adoptServerOrientation(payload)
    } catch {
      // Session restore is best-effort; local cycle stays until a poll succeeds.
    }
  }, [adoptServerOrientation, chatId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    void refreshControlStatus()
    const timer = window.setInterval(() => {
      void refreshControlStatus()
    }, CONTROL_STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshControlStatus])

  useEffect(() => {
    const api = getSimulatorCanvasBridge()
    const hasControlBridge = Boolean(getSimulatorControlBridge())
    const canClaim =
      !hasControlBridge || Boolean(controlStatus?.enabled && controlStatus.ready)
    // Do not claim a human controller until the user has enabled and prepared
    // Simulator control. Screen preview remains available without it.
    if (!canClaim) {
      return
    }

    // Human dock is authoritative for this surface — claim controller on open
    // so direct interaction is ready without a preliminary action. Release the
    // human token on unmount / chat switch / hide (CanvasDock unmounts this
    // panel when showSimulator becomes false).
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
        // Session first so Rotate label matches any prior agent/host rotate.
        await refreshSessionOrientation()
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
  }, [
    chatId,
    controlStatus?.enabled,
    controlStatus?.ready,
    refreshInteraction,
    refreshSessionOrientation
  ])

  useEffect(() => {
    const hasControlBridge = Boolean(getSimulatorControlBridge())
    if (hasControlBridge && !(controlStatus?.enabled && controlStatus.ready)) {
      return
    }
    void refreshInteraction()
    const timer = window.setInterval(() => {
      void refreshInteraction()
    }, INTERACTION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [controlStatus?.enabled, controlStatus?.ready, refreshInteraction])

  const selectedDevice = useMemo(() => {
    return deviceOptions(status).find((device) => device.udid === selectedUdid) ?? null
  }, [selectedUdid, status])

  const selectedBooted = Boolean(
    selectedDevice &&
    (selectedDevice.state === 'Booted' ||
      status?.bootedDevices.some((device) => device.udid === selectedDevice.udid))
  )

  const formFactor = resolveSimulatorFormFactor(selectedDevice?.name)
  const hasControlBridge = Boolean(getSimulatorControlBridge())
  const controlReady =
    !hasControlBridge || Boolean(controlStatus?.enabled && controlStatus.ready)
  const showControlSetup = hasControlBridge && controlStatus !== null && !controlReady
  const gesturesEnabled = controlReady && canSendSimulatorGestures(interaction)
  const hardwareControlsEnabled =
    selectedBooted && Boolean(interaction?.actuationReady) && gesturesEnabled
  const banner = controlReady ? previewOnlyBannerText(interaction) : ''
  const agentControllerNotice =
    !showControlSetup && interaction?.controllerKind === 'run'
      ? 'An agent is using this simulator.'
      : null
  const canMutateHost = Boolean(selectedUdid) && busy === null && controlReady
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

  const setupSimulatorControl = async (): Promise<void> => {
    const api = getSimulatorControlBridge()
    if (!api?.setup) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    setBusy('setup')
    setIssue(null)
    setControlIssue(null)
    try {
      const result = await api.setup()
      if (chatIdRef.current !== chatId) return
      setControlStatus(result)
      if (!result.ok) {
        setControlIssue(result.error || 'Simulator control could not finish setup.')
        return
      }
      await Promise.all([refreshStatus(), refreshControlStatus()])
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setControlIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

  const enableSimulatorControl = async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api?.updateSettings) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    setBusy('setup')
    setIssue(null)
    setControlIssue(null)
    try {
      await api.updateSettings({ simulatorControlEnabled: true })
      if (chatIdRef.current !== chatId) return
      await Promise.all([refreshStatus(), refreshControlStatus()])
    } catch (error) {
      if (chatIdRef.current === chatId) {
        setControlIssue(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (chatIdRef.current === chatId) setBusy(null)
    }
  }

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
    if (!gesturesEnabled || event.button !== 0) return
    const point = pointFromEvent(event)
    if (!point) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      point,
      clientX: event.clientX,
      clientY: event.clientY
    }
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleBezelPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) event.preventDefault()
  }

  const handleBezelPointerCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  const handleBezelPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!gesturesEnabled || !drag || drag.pointerId !== event.pointerId) return
    const api = getSimulatorCanvasBridge()
    if (!api?.tap || !api.scroll) return
    const endPoint = pointFromEvent(event)
    if (!endPoint) return
    event.preventDefault()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const movementX = event.clientX - drag.clientX
    const movementY = event.clientY - drag.clientY
    const isSwipe = Math.hypot(movementX, movementY) >= 8
    const tapGesture = buildTapGesture(chatId, endPoint)
    const scrollGesture = buildScrollGesture(
      chatId,
      drag.point,
      drag.clientX - event.clientX,
      drag.clientY - event.clientY
    )
    void (async () => {
      const gated = await actuateAfterSoftClaim(ensureHumanLease, () =>
        isSwipe ? api.scroll!(scrollGesture) : api.tap!(tapGesture)
      )
      if (chatIdRef.current !== chatId || !gated.ok) return
      const result = gated.value
      if (result && result.ok === false) {
        setIssue(result.error || (isSwipe ? 'Swipe was refused.' : 'Tap was refused.'))
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

  // Text events arrive one character at a time, but every companion call pays
  // a full idb CLI spawn (~1s). Buffer whatever arrives while a call is in
  // flight and flush it as ONE follow-up `type` gesture — order is preserved
  // by the single pending buffer, and a fast typist pays at most two spawns.
  const flushPendingText = (): void => {
    if (textFlushInFlightRef.current) return
    const batch = pendingTextRef.current
    if (!batch) return
    const api = getSimulatorCanvasBridge()
    if (!api?.type) return
    pendingTextRef.current = ''
    textFlushInFlightRef.current = true
    void (async () => {
      try {
        const gated = await actuateAfterSoftClaim(ensureHumanLease, () =>
          api.type!(buildTypeGesture(chatId, batch))
        )
        if (chatIdRef.current !== chatId || !gated.ok) return
        const result = gated.value
        if (result && result.ok === false) {
          setIssue(result.error || 'Type was refused.')
        }
      } catch (error) {
        if (chatIdRef.current === chatId) {
          setIssue(error instanceof Error ? error.message : String(error))
        }
      } finally {
        textFlushInFlightRef.current = false
        flushPendingText()
      }
    })()
  }

  const sendText = (text: string): void => {
    if (!gesturesEnabled) return
    const api = getSimulatorCanvasBridge()
    if (!api?.type) return
    if (!text) return
    pendingTextRef.current += text
    flushPendingText()
  }

  const handleBezelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!gesturesEnabled || event.metaKey || event.ctrlKey || event.altKey) return
    const text =
      event.key === 'Enter'
        ? '\n'
        : Array.from(event.key).length === 1 && event.key !== 'Dead'
          ? event.key
          : ''
    if (!text) return
    event.preventDefault()
    sendText(text)
  }

  const handleBezelPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (!controlReady) return
    event.preventDefault()
    // Bridge the real pasteboard too (simctl pbsync): rich content and in-app
    // Paste menus work even when idb typing is unavailable. The preload
    // consumed this same trusted paste gesture to mint the one-shot proof.
    pushClipboardToDevice()
    if (!gesturesEnabled) return
    const text = event.clipboardData.getData('text')
    if (text) sendText(text)
  }

  const pushClipboardToDevice = (): void => {
    if (!selectedUdid) return
    const api = getSimulatorCanvasBridge()
    if (!api?.clipboardPush) return
    void api
      .clipboardPush(chatId, selectedUdid)
      .then((result) => {
        if (chatIdRef.current !== chatId) return
        if (result && result.ok === false) {
          setIssue(result.error || 'Clipboard sync to the simulator was refused.')
        }
      })
      .catch((error: unknown) => {
        if (chatIdRef.current === chatId) {
          setIssue(error instanceof Error ? error.message : String(error))
        }
      })
  }

  const copyClipboardFromDevice = (): void => {
    if (!selectedUdid) return
    const api = getSimulatorCanvasBridge()
    if (!api?.clipboardPull) {
      setIssue(BRIDGE_MISSING_HINT)
      return
    }
    setBusy('clipboard')
    setIssue(null)
    void api
      .clipboardPull(chatId, selectedUdid)
      .then((result) => {
        if (chatIdRef.current !== chatId) return
        if (result && result.ok === false) {
          setIssue(result.error || 'Copying the simulator clipboard was refused.')
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
  const frameSrc = frame ? `data:image/png;base64,${frame.pngBase64}` : null
  const hasPickApp = Boolean(bridge.pickApp)
  const hasInstall = Boolean(bridge.install)
  const hasLaunch = Boolean(bridge.launch)
  const hasTerminate = Boolean(bridge.terminate)

  return (
    <section className="simulator-canvas-panel" aria-label="Simulator Canvas">
      <div className="simulator-canvas-toolbar">
        <div>
          <div className="simulator-canvas-title">iOS Simulator</div>
        </div>
        <div className="simulator-canvas-actions">
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
            disabled={!canMutateHost || selectedBooted}
            loading={busy === 'boot'}
          >
            {busy === 'boot' ? 'Booting…' : 'Boot'}
          </PillButton>
        </div>
      </div>

      {agentControllerNotice ? (
        <div className="simulator-canvas-banner is-agent" role="status">
          {agentControllerNotice}
        </div>
      ) : null}

      {banner ? (
        <div className="simulator-canvas-banner" role="status">
          {banner}
        </div>
      ) : null}

      {controlReady && (hasInstall || hasLaunch || hasTerminate) && (
        <details className="simulator-canvas-advanced">
          <summary>App testing</summary>
          <div className="simulator-canvas-qa" aria-label="Simulator app controls">
            <div className="simulator-canvas-qa-row">
              <PillButton
                size="compact"
                onClick={() => void openSimulatorApp()}
                disabled={busy !== null}
                loading={busy === 'open'}
              >
                {busy === 'open' ? 'Opening…' : 'Open Simulator App'}
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
        </details>
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
            tabIndex={gesturesEnabled ? 0 : -1}
            onPointerDown={handleBezelPointerDown}
            onPointerMove={handleBezelPointerMove}
            onPointerUp={handleBezelPointerUp}
            onPointerCancel={handleBezelPointerCancel}
            onWheel={handleBezelWheel}
            onKeyDown={handleBezelKeyDown}
            onPaste={handleBezelPaste}
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
            {showControlSetup && controlStatus ? (
              <div className="simulator-canvas-setup-overlay" role="status" aria-live="polite">
                <div className="simulator-canvas-setup-card">
                  <strong>
                    {controlStatus.state === 'disabled'
                      ? 'Simulator control is off'
                      : controlStatus.state === 'unsupported'
                        ? 'Simulator control is unavailable'
                        : 'Use this Simulator?'}
                  </strong>
                  <p>{controlStatus.message}</p>
                  {controlIssue ? (
                    <p className="simulator-canvas-setup-error" role="alert">
                      {controlIssue}
                    </p>
                  ) : null}
                  {controlStatus.state === 'setup_required' ? (
                    <PillButton
                      size="compact"
                      variant="primary"
                      disabled={busy !== null}
                      loading={busy === 'setup'}
                      onClick={() => void setupSimulatorControl()}
                    >
                      {busy === 'setup' ? 'Setting up…' : 'Set up'}
                    </PillButton>
                  ) : null}
                  {controlStatus.state === 'disabled' ? (
                    <PillButton
                      size="compact"
                      variant="primary"
                      disabled={busy !== null}
                      loading={busy === 'setup'}
                      onClick={() => void enableSimulatorControl()}
                    >
                      {busy === 'setup' ? 'Turning on…' : 'Enable'}
                    </PillButton>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
          <div className="simulator-canvas-bezel-home" aria-hidden="true" />
        </div>
      </div>

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
        <PillButton
          size="compact"
          onClick={() => copyClipboardFromDevice()}
          disabled={!canMutateHost || !selectedBooted}
          loading={busy === 'clipboard'}
          title="Copy the simulator clipboard to this Mac (simctl pbsync)"
        >
          Copy clipboard
        </PillButton>
      </div>

      {issue && (
        <div className="simulator-canvas-issue" role="alert">
          {issue}
        </div>
      )}
    </section>
  )
}
