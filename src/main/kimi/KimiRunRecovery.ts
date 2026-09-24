import type { AcpSessionPromptContext, AcpSessionPromptPreparation } from '../acp/AcpTurnClient'
import type { AcpPermissionDecision, AcpPermissionRequest, AcpRunEvent } from '../acp/AcpProtocol'
import type { KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import {
  kimiGatewayCatalogueReady,
  missingKimiToolGroups,
  type KimiRequiredToolGroups
} from './KimiGatewayReadiness'
import {
  createKimiRunCapabilityReceipt,
  formatKimiRunCapabilityReceipt,
  type KimiRunCapabilityContext,
  type KimiRunCapabilityReceipt
} from './KimiRunCapabilities'
import { isKimiDeniedNativeTool, unqualifyKimiMcpToolName } from './KimiToolPolicy'
import type { KimiProviderToolSnapshot } from './KimiProviderToolSnapshot'

export interface KimiRunRecoveryOptions {
  context: KimiRunCapabilityContext
  gateway: KimiHttpMcpBridgeHandle
  onReceipt: (receipt: KimiRunCapabilityReceipt) => void
  timeoutMs?: number
  requiredToolGroups?: KimiRequiredToolGroups
  readToolSnapshot?: (sessionId: string) => Promise<KimiProviderToolSnapshot | null>
}

export function createKimiRunRecovery(options: KimiRunRecoveryOptions) {
  const { context, gateway } = options
  const receipt = createKimiRunCapabilityReceipt(context, gateway.readiness.snapshot())
  let consecutiveNativeRefusals = 0
  let correctionSent = false
  let lastCorrectionGeneration = -1
  let observedBrokerCalls = 0
  let closing = false
  let promptGeneration = 0
  let observationGeneration = 0
  let latestSnapshotAt = -1
  let promptStartedAt = 0
  const invalidateObservation = (): void => {
    promptGeneration += 1
    observationGeneration += 1
    promptStartedAt = Date.now()
    receipt.modelToolVisibility = 'not-observed'
    receipt.nativeTools.catalogueIsCurrent = false
    receipt.brokerToolNameSource = 'served-catalogue'
    receipt.brokerToolNames = receipt.gateway.toolNames.map((name) => `mcp__taskwraith__${name}`)
  }
  const seenRefusals = new Set<string>()
  const inferredRequired: string[][] = [['read_file']]
  if (context.assignedScope.intent !== 'read' && !context.permissions?.readOnly) {
    if (['allow', 'workspace'].includes(context.permissions?.agenticServices.fileChanges ?? '')) {
      inferredRequired.push(['replace', 'apply_patch', 'write_file'])
    }
    if (['allow', 'workspace'].includes(context.permissions?.agenticServices.shellCommands ?? '')) {
      inferredRequired.push(['run_shell_command'])
    }
  }
  const required = options.requiredToolGroups ?? inferredRequired
  const publish = (): void => {
    receipt.timestamp = new Date().toISOString()
    try {
      options.onReceipt(structuredClone(receipt))
    } catch {
      // Evidence persistence failure is not permission or provider admission.
    }
  }
  const unsubscribe = gateway.readiness.subscribe((state) => {
    const previous = receipt.gateway
    const changed =
      state.generation !== previous.generation ||
      state.initializeResponses !== previous.initializeResponses ||
      state.toolsListResponses !== previous.toolsListResponses ||
      state.closed !== previous.closed ||
      (state.toolCalls > 0 && previous.toolCalls === 0)
    if (state.generation !== receipt.gateway.generation) observedBrokerCalls = 0
    receipt.gateway = state
    if (receipt.brokerToolNameSource !== 'provider-tools-snapshot') {
      receipt.brokerToolNames = state.toolNames.map((name) => `mcp__taskwraith__${name}`)
    }
    if (state.toolCalls > observedBrokerCalls && receipt.outcome === 'running') {
      receipt.modelToolVisibility = 'broker-call-observed'
      receipt.phase = 'broker-used'
      consecutiveNativeRefusals = 0
    }
    observedBrokerCalls = state.toolCalls
    if (changed) publish()
  })
  publish()

  return {
    snapshot: (): KimiRunCapabilityReceipt => structuredClone(receipt),
    onRawFrame(direction: 'in' | 'out', message: unknown): void {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const frame = message as { method?: string; params?: { sessionId?: string } }
      if (direction === 'out' && ['session/new', 'session/resume'].includes(frame.method ?? '')) {
        invalidateObservation()
        latestSnapshotAt = -1
        receipt.providerSessionId = frame.params?.sessionId ?? null
        receipt.modelToolVisibility = 'not-observed'
        receipt.brokerToolNameSource = 'served-catalogue'
        receipt.nativeTools.catalogueIsCurrent = false
        gateway.readiness.beginSession()
      }
    },
    async prepareSessionPrompt(
      session: AcpSessionPromptContext
    ): Promise<AcpSessionPromptPreparation> {
      receipt.providerSessionId = session.sessionId
      let ready = false
      try {
        ready = await gateway.readiness.waitForTools(options.timeoutMs ?? 2_000, required)
      } catch {
        ready = false
      }
      receipt.gateway = gateway.readiness.snapshot()
      if (closing)
        return { status: 'blocked', message: 'The Kimi run closed during tool discovery.' }
      if (!ready) {
        const missing = missingKimiToolGroups(receipt.gateway, required).map((group) =>
          group.join(' or ')
        )
        const message =
          `Kimi gateway unavailable for run ${context.runId}: ` +
          `initialize responses=${receipt.gateway.initializeResponses}, tools/list responses=${receipt.gateway.toolsListResponses}, ` +
          `missing routes=${missing.join(', ') || 'nonempty served catalogue'}.`
        const recover = session.resumed && !session.fallbackFromResume
        receipt.phase = recover ? 'recovering' : 'blocked'
        receipt.outcome = recover ? 'running' : 'blocked'
        receipt.blocker = message
        publish()
        return { status: recover ? 'recover' : 'blocked', message }
      }
      receipt.phase = 'catalogue-served'
      receipt.outcome = 'running'
      receipt.blocker = null
      publish()
      return {
        status: 'ready',
        prompt: `${formatKimiRunCapabilityReceipt(receipt)}\n\n${session.prompt}`
      }
    },
    async observeProviderTools(): Promise<void> {
      if (!options.readToolSnapshot || !receipt.providerSessionId || closing) return
      const sessionId = receipt.providerSessionId
      const prompt = promptGeneration
      const observation = ++observationGeneration
      const snapshot = await options.readToolSnapshot(sessionId).catch(() => null)
      if (
        !snapshot ||
        receipt.providerSessionId !== sessionId ||
        promptGeneration !== prompt ||
        observationGeneration !== observation ||
        closing ||
        snapshot.sessionId !== sessionId ||
        snapshot.observedAt < latestSnapshotAt
      )
        return
      latestSnapshotAt = snapshot.observedAt
      const currentPrompt = snapshot.currentRun && snapshot.observedAt >= promptStartedAt
      const broker = snapshot.toolNames.filter((name) =>
        /^(?:mcp__taskwraith__|TaskWraith__)/i.test(name)
      )
      receipt.nativeTools.catalogue = snapshot.toolNames.filter(
        (name) => !/^(?:mcp__|TaskWraith__)/i.test(name)
      )
      receipt.nativeTools.catalogueObservedAt = new Date(snapshot.observedAt).toISOString()
      receipt.nativeTools.catalogueIsCurrent = currentPrompt
      if (currentPrompt) {
        receipt.brokerToolNames = broker
        receipt.brokerToolNameSource = 'provider-tools-snapshot'
        receipt.modelToolVisibility = 'provider-tools-snapshot'
        const names = broker.map((name) => unqualifyKimiMcpToolName(name) ?? name)
        const missing = required.filter((group) => !group.some((name) => names.includes(name)))
        if (missing.length > 0) {
          receipt.phase = 'blocked'
          receipt.outcome = 'blocked'
          receipt.blocker = `Kimi's current model tool snapshot for run ${context.runId} lacks ${missing.map((group) => group.join(' or ')).join(', ')}. The HTTP catalogue alone did not establish model availability. Preserve prior work and hand the lane back after settlement.`
        }
      }
      publish()
    },
    permissionResult(request: AcpPermissionRequest, decision: AcpPermissionDecision): void {
      if (decision !== 'deny' || !isKimiDeniedNativeTool(request)) return
      const raw = request.rawToolCall as {
        toolCallId?: unknown
        rawInput?: { tool_name?: unknown; name?: unknown }
      } | null
      const toolCallId =
        typeof raw?.toolCallId === 'string' && /^[\w:.-]{1,160}$/.test(raw.toolCallId)
          ? raw.toolCallId
          : null
      const toolName =
        receipt.nativeTools.intendedDenied.find((name) =>
          [request.toolName, raw?.rawInput?.tool_name, raw?.rawInput?.name].some(
            (candidate) =>
              typeof candidate === 'string' && candidate.toLowerCase() === name.toLowerCase()
          )
        ) || 'native tool'
      const key = toolCallId || `rpc:${request.rpcId}`
      if (seenRefusals.has(key)) return
      seenRefusals.add(key)
      consecutiveNativeRefusals += 1
      receipt.refusals = [
        ...receipt.refusals,
        {
          toolCallId,
          toolName,
          source: 'host-containment' as const,
          decisionSource: 'system' as const,
          userAsked: false as const,
          timestamp: new Date().toISOString()
        }
      ].slice(-20)
      publish()
    },
    onEvent(event: AcpRunEvent): void {
      if (event.type === 'tool_use' && event.toolId && event.toolName) {
        const name = event.toolName
        if (
          /^[\w.:-]{1,128}$/.test(name) &&
          unqualifyKimiMcpToolName(name) === name &&
          !name.startsWith('mcp__')
        ) {
          if (!receipt.nativeTools.observedCalls.includes(name)) {
            receipt.nativeTools.observedCalls.push(name)
            publish()
          }
        }
      }
    },
    boundaryAction(): { kind: 'correct' | 'blocked'; message: string } | null {
      if (receipt.outcome === 'blocked' && receipt.blocker) {
        return { kind: 'blocked', message: receipt.blocker }
      }
      if (receipt.outcome !== 'running' || consecutiveNativeRefusals === 0) return null
      if (consecutiveNativeRefusals >= 2 || !kimiGatewayCatalogueReady(receipt.gateway, required)) {
        receipt.phase = 'blocked'
        receipt.outcome = 'blocked'
        receipt.blocker = `Repeated native tool containment refusals in run ${context.runId}; no broker progress confirmed. Preserve the completed design and evidence. The coordinator may recover or reassign only after this run's process and cleanup settle.`
        publish()
        return { kind: 'blocked', message: receipt.blocker }
      }
      if (correctionSent && lastCorrectionGeneration === receipt.gateway.generation) return null
      correctionSent = true
      lastCorrectionGeneration = receipt.gateway.generation
      return {
        kind: 'correct',
        message: `${formatKimiRunCapabilityReceipt(receipt)}\nThe previous native refusal was TaskWraith host containment; no human was asked. Continue the original scoped task using an actually listed TaskWraith broker tool. If it is absent, report that exact blocker and finish; do not repeat the native call.`
      }
    },
    externalSteer(): void {
      invalidateObservation()
      consecutiveNativeRefusals = 0
      correctionSent = false
      receipt.outcome = 'running'
      receipt.phase = receipt.gateway.toolCalls > 0 ? 'broker-used' : 'catalogue-served'
      receipt.blocker = null
      publish()
    },
    beginClose(hostBlocked: boolean): void {
      promptGeneration += 1
      observationGeneration += 1
      closing = true
      unsubscribe()
      if (hostBlocked) {
        receipt.phase = 'blocked'
        receipt.outcome = 'blocked'
      }
      publish()
    },
    beginPrompt(): void {
      invalidateObservation()
      publish()
    },
    close(): void {
      closing = true
      unsubscribe()
      receipt.lifecycleSettled = true
      receipt.gateway = gateway.readiness.snapshot()
      if (receipt.outcome !== 'blocked') {
        receipt.phase = 'settled'
        receipt.outcome = 'settled'
      }
      publish()
    }
  }
}
