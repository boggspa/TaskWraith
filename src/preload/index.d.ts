import {
  AppSettings,
  WorkspaceRecord,
  ChatRecord,
  ChatListItem,
  PinnedMessageGroup,
  UsageRecord,
  TrustStatusResult,
  TrustWriteResult,
  WorkspaceFileEntry,
  WorkspaceFileReadResult,
  GeminiSessionListResult,
  GeminiWorktreeLaunchOption,
  ProviderId,
  ChatScope,
  ExternalPathGrant,
  ScheduledTask,
  WorkflowDefinition,
  GeminiMcpBridgeStatus,
  ProviderApiKeyStatus,
  GeminiAuthStatus,
  GeminiAuthProfileSummary,
  GeminiOAuthLoginStatus,
  ProviderCapabilityContract,
  ProviderAdapterDescriptor,
  RunQueueJob,
  RunQueueJobFilter,
  RunEventFilter,
  RunEventRecord,
  RunEventReplay,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  RunRecoveryFilter,
  RunRecoveryRecord,
  WorkspaceChangeFilter,
  WorkspaceChangeSet,
  WorkspaceActivitySnapshot,
  ProductCrashFilter,
  ProductCrashInput,
  ProductCrashRecord,
  ProductDiagnosticsExportResult,
  ProductOperationsStatus,
  ProductChangelogSnapshot,
  RuntimeProfile,
  HandoffCard,
  HandoffCardFilter,
  RunAnalystRequest,
  RunAnalystSnapshot,
  AgenticServiceId,
  EffectiveRunPermissions,
  AuditRunRecord,
  ProviderRunReroute
} from '../main/store/types'
import type {
  RemoteWorkspaceCapability,
  RemoteWorkspaceEntry
} from '../main/RemoteWorkspaceAllowlist'
import type { UpdateStateSnapshot } from '../main/UpdateService'
import type { LocalServersSnapshot } from '../main/localServers/types'
import type { NativeCapabilitySnapshot } from '../main/NativeCapabilities'
import type { GrokUsageSnapshot } from '../main/grok/GrokUsage'
import type { AppShellStatsSnapshot } from '../main/services/AppShellStatsService'
import type { SessionCheckpointRecord } from '../main/checkpoints/SessionCheckpoint'
import type {
  MessageChannelBinding,
  MessageChannelBindingInput
} from '../main/channels/MessageChannelTypes'
import type {
  LocalWebChannelOutboundMessage,
  LocalWebChannelSubmitInput
} from '../main/channels/LocalWebChannelAdapter'
import type { MessageChannelAdapterRuntimeStatus } from '../main/channels/MessageChannelAdapter'
import type { MessageChannelCursor } from '../main/channels/MessageChannelCursorStore'
import type { MessageChannelAuditRecord } from '../main/channels/MessageChannelAuditStore'
import type {
  MessageChannelPollSummary,
  MessagesBridgeConversationListResult,
  MessagesBridgeConversationsParams,
  MessagesBridgePollResult,
  MessagesBridgePollParams
} from '../main/channels/MessageChannelGatewayService'
import type {
  DiscordContextSelection,
  DiscordContextTargets,
  DiscordContextSnapshot,
  DiscordContextReadMetadata
} from '../main/channels/DiscordContextService'
import type {
  GitPrReadiness,
  GitPrSummary,
  GitRepositorySnapshot,
  GitResult
} from '../main/services/GitService'

type GeminiCapabilityKind = 'mcp' | 'extensions' | 'skills' | 'agents'
type GeminiCapabilityFormat = 'json' | 'raw' | 'error'

interface GeminiCapabilityItem {
  id: string
  name: string
  status?: string
  detail?: string
  raw: string
}

interface GeminiCapabilitySection {
  kind: GeminiCapabilityKind
  command: string[]
  format: GeminiCapabilityFormat
  items: GeminiCapabilityItem[]
  stdout: string
  stderr: string
  status: number | null
  timedOut: boolean
  error?: string
  parsingError?: string
  truncated?: boolean
}

interface GeminiCapabilitiesState {
  refreshedAt: string
  workspace?: string
  sections: Record<GeminiCapabilityKind, GeminiCapabilitySection>
}

type HostWeatherKind =
  | 'clear'
  | 'partly_cloudy'
  | 'cloudy'
  | 'overcast'
  | 'rain'
  | 'heavy_rain'
  | 'snow'
  | 'mist'
  | 'fog'
  | 'storm'
  | 'unknown'

interface HostWeatherState {
  kind: HostWeatherKind
  description: string
  temperatureC?: number
  location?: string
  isDay: boolean
  updatedAt: string
  source: 'wttr' | 'fallback'
  error?: string
}

type AgentApprovalAction =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'
  | 'useProviderNative'
  | 'useTaskWraithSubthread'
  | 'grantExternalPathRead'
  | 'grantExternalPathEdit'
  | 'declineExternalPath'

interface AgentRunPayload {
  provider: ProviderId
  providerReroute?: ProviderRunReroute
  scope?: 'workspace' | 'global'
  workspace?: string
  prompt: string
  appRunId?: string
  appChatId?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  approvalMode?: string
  imagePaths?: string[]
  providerSessionId?: string | null
  externalPathGrants?: ExternalPathGrant[]
  sessionTrust?: boolean
  geminiWorktree?: GeminiWorktreeLaunchOption
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  effectivePermissions?: EffectiveRunPermissions
  effectivePermissionsSignature?: string
}

interface ComposerImageAttachment {
  id?: string
  path?: string
  name?: string
}

interface ComposerRunInput {
  chatId: string
  appRunId?: string
  provider?: ProviderId
  providerReroute?: ProviderRunReroute
  scope?: ChatScope
  workspace?: string
  userInput?: string
  prompt?: string
  selectedModelType?: string
  customModel?: string
  overrideModel?: string
  approvalMode?: string
  sessionTrust?: boolean
  attachments?: ComposerImageAttachment[]
  imageAttachments?: ComposerImageAttachment[]
  externalPathGrants?: ExternalPathGrant[]
  geminiWorktree?: GeminiWorktreeLaunchOption
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  discordContextSnapshots?: DiscordContextSnapshot[]
  chatSnapshot?: ChatRecord
}

interface ComposerRunMetadata {
  finalPrompt: string
  contextTurnsApplied: number
  applicationLog: string
  providerLabel: string
  requestedModel?: string
  approvalMode: string
  providerSessionId?: string | null
  geminiResumeSkippedReason?: string
  clearLinkedGeminiSession?: boolean
  providerMetadataPatch?: Record<string, unknown>
  codexHandoffApplied?: {
    handoffKey: string
    previousModel: string
    nextModel: string
    appliedAt: string
  }
  uiNoticeMessage?: string
  imagePaths: string[]
  discordContextReads?: DiscordContextReadMetadata[]
  planModeParsed?: boolean
}

type ComposerRunPayload = AgentRunPayload & {
  composer: ComposerRunMetadata
}

interface AgentRunRoute {
  appRunId?: string
  appChatId?: string
}

type GeminiStreamPayload =
  | string
  | {
      provider?: ProviderId
      appRunId?: string
      appChatId?: string
      data?: string
      error?: string
      code?: number | null
    }

interface AgentApprovalRequest {
  id: string
  provider: ProviderId
  appRunId?: string
  appChatId?: string
  method: string
  title: string
  body: string
  preview?: any
  params?: any
  actions: AgentApprovalAction[]
}

type CopyChatMarkdownTranscriptResult =
  | {
      ok: true
      messageCount: number
      charCount: number
      omissions: string[]
    }
  | {
      ok: false
      reason: 'not-found' | 'archived' | 'empty' | 'too-large' | 'unauthorized'
      messageCount?: number
      charCount?: number
      omissions?: string[]
    }

interface SpellcheckContextResult {
  x: number
  y: number
  misspelledWord: string
  dictionarySuggestions: string[]
  createdAt: number
}

declare global {
  interface Window {
    api: {
      hostPlatform: NodeJS.Platform
      getRuntimeVersions: () => NodeJS.ProcessVersions
      selectWorkspace: () => Promise<WorkspaceRecord | null>
      selectImageFiles: () => Promise<string[]>
      saveClipboardImageAttachment: () => Promise<string[]>
      getLastSpellcheckContext: (point: {
        x: number
        y: number
      }) => Promise<SpellcheckContextResult | null>
      replaceMisspelling: (payload: {
        suggestion: string
        point: { x: number; y: number }
      }) => Promise<{ ok: boolean; reason?: string }>
      addWordToSpellCheckerDictionary: (payload: {
        point: { x: number; y: number }
      }) => Promise<{ ok: boolean; reason?: string }>
      copyChatMarkdownTranscript: (chatId: string) => Promise<CopyChatMarkdownTranscriptResult>
      selectExternalPathGrant: (
        access?: 'read' | 'write',
        provider?: string
      ) => Promise<ExternalPathGrant | null>
      /**
       * 1.0.5-EW42a — Proactive external-path grant from composer
       * workspace switcher. Opens an OS folder picker, issues one
       * grant per unique participant-provider on the chat, and
       * persists to the chat's metadata. Broadcasts chat-updated
       * so the ExternalPathAboveRow banner appears immediately.
       */
      pickAndPersistExternalPathGrant: (payload: {
        chatId: string
        access?: 'read' | 'write'
        // 1.0.6-EW69 — optional explicit path skips the OS dialog
        // (attach a known workspace as a secondary).
        path?: string
        // Defer metadata persistence until the user confirms grants in
        // the composer preflight modal.
        deferPersist?: boolean
      }) => Promise<
        | { ok: true; grants: ExternalPathGrant[]; path: string }
        | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }
      >
      probeExternalPath: (
        absolutePath: string
      ) => Promise<{ isRepo: boolean; repoRoot: string; branch?: string } | null>
      runGemini: (
        workspace: string,
        prompt: string,
        model: string,
        approvalMode: string,
        sessionTrust?: boolean,
        imagePaths?: string[],
        resumeSessionId?: string | null,
        worktree?: GeminiWorktreeLaunchOption,
        route?: AgentRunRoute | null
      ) => Promise<void>
      cancelGemini: (runId?: string) => Promise<void>
      composeRun: (input: ComposerRunInput) => Promise<ComposerRunPayload>
      runAgent: (payload: AgentRunPayload) => Promise<void>
      cancelAgentRun: (provider?: ProviderId, runId?: string) => Promise<void>
      getAgentStatus: (provider: ProviderId) => Promise<any>
      getProviderCapabilities: (
        provider: ProviderId,
        workspace?: string,
        approvalMode?: string
      ) => Promise<ProviderCapabilityContract>
      getProviderAdapters: () => Promise<ProviderAdapterDescriptor[]>
      // 1.0.5-EW35 — Currency sub-slice (c): live FX rate snapshot.
      getFxRates: () => Promise<{
        rates: { USD: 1; GBP: number; EUR: number }
        fetchedAt: string
        source: 'live' | 'cached' | 'fallback'
        errorMessage?: string
      }>
      refreshFxRates: (force?: boolean) => Promise<{
        rates: { USD: 1; GBP: number; EUR: number }
        fetchedAt: string
        source: 'live' | 'cached' | 'fallback'
        errorMessage?: string
      }>
      // 1.0.5-EW38 — Per-provider rate snapshot (baseline + probe).
      // Loose typing for the renderer; concrete shapes live in
      // src/main/services/ProviderRateService.ts.
      getProviderRates: () => Promise<unknown>
      probeProviderRates: () => Promise<unknown>
      getAgentModels: (provider: ProviderId) => Promise<
        Array<{
          id: string
          label?: string
          description?: string
          isDefault?: boolean
          supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
          defaultReasoningEffort?: string | null
          additionalSpeedTiers?: string[]
        }>
      >
      getAgentRateLimits: (provider: ProviderId) => Promise<any>
      importCodexUsageCredential: (filePath?: string) => Promise<any>
      clearCodexUsageCredential: () => Promise<boolean>
      getCodexUsageSnapshot: () => Promise<any>
      getExternalUsage: (options?: { force?: boolean }) => Promise<UsageRecord[]>
      probeGrokUsage: () => Promise<GrokUsageSnapshot>
      gitSnapshot: (payload: {
        workspacePath?: string
        repoPath?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitStage: (payload: {
        workspacePath?: string
        repoPath?: string
        paths?: string[]
        all?: boolean
        update?: boolean
        patch?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitCommit: (payload: {
        workspacePath?: string
        repoPath?: string
        message: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      gitPush: (payload: {
        workspacePath?: string
        repoPath?: string
        setUpstream?: boolean
        remote?: string
      }) => Promise<GitResult<GitRepositorySnapshot>>
      githubPrStatus: (payload: {
        workspacePath?: string
        repoPath?: string
      }) => Promise<GitResult<GitPrSummary>>
      githubPrReadiness: (payload: {
        workspacePath?: string
        repoPath?: string
      }) => Promise<GitResult<GitPrReadiness>>
      createGithubPr: (payload: {
        workspacePath?: string
        repoPath?: string
        title?: string
        body?: string
        draft?: boolean
        openInBrowser?: boolean
      }) => Promise<{ ok: boolean; url?: string; error?: string; stderr?: string }>
      getClaudeAuthStatus: () => Promise<ProviderApiKeyStatus>
      storeClaudeApiKey: (key: string) => Promise<void>
      clearClaudeApiKey: () => Promise<void>
      triggerClaudeLogin: () => Promise<{ ok: boolean; code?: number | null; error?: string }>
      getKimiAuthStatus: () => Promise<ProviderApiKeyStatus>
      storeKimiApiKey: (key: string) => Promise<void>
      clearKimiApiKey: () => Promise<void>
      upgradeKimiCli: () => Promise<{ ok: boolean; error?: string }>
      getGeminiAuthStatus: () => Promise<GeminiAuthStatus>
      listGeminiAuthProfiles: () => Promise<GeminiAuthProfileSummary[]>
      saveGeminiAuthProfile: (profile: {
        id?: string
        label?: string
        kind: 'api-key' | 'vertex-ai' | 'google-oauth'
        apiKey?: string
        vertexProject?: string
        vertexLocation?: string
        makeDefault?: boolean
      }) => Promise<GeminiAuthProfileSummary>
      deleteGeminiAuthProfile: (profileId: string) => Promise<boolean>
      setDefaultGeminiAuthProfile: (
        profileId: string | null
      ) => Promise<GeminiAuthProfileSummary | null>
      startGeminiOAuthLogin: (input?: {
        id?: string
        profileId?: string
        label?: string
        makeDefault?: boolean
      }) => Promise<GeminiOAuthLoginStatus>
      getGeminiOAuthLoginStatus: (
        profileId?: string | null
      ) => Promise<GeminiOAuthLoginStatus | null>
      cancelGeminiOAuthLogin: (profileId?: string | null) => Promise<GeminiOAuthLoginStatus | null>
      getAgentMcpStatus: (provider: ProviderId) => Promise<any>
      listAgentThreads: (provider: ProviderId, params?: any) => Promise<any>
      forkAgentThread: (provider: ProviderId, threadId: string, params?: any) => Promise<any>
      rollbackAgentThread: (
        provider: ProviderId,
        threadId: string,
        numTurns?: number
      ) => Promise<any>
      startAgentReview: (provider: ProviderId, threadId: string, params?: any) => Promise<any>
      respondAgentApproval: (
        requestId: string,
        action: AgentApprovalAction,
        intentNote?: string
      ) => Promise<boolean>
      writeGeminiInput: (data: string) => Promise<boolean>
      getDiff: (workspace: string) => Promise<{
        type: 'not_repo' | 'no_changes' | 'changes' | 'error'
        text?: string
        statusText?: string
        diffText?: string
        summaries?: any[]
      }>
      openWorkspacePopout: (input: {
        kind: 'file-editor' | 'diff-studio'
        workspacePath: string
      } | {
        kind: 'chat'
        chatId: string
        workspacePath?: string
      }) => Promise<{ ok: true }>
      dockSideChatPopout: (input: {
        chatId: string
        presentation?: 'split' | 'drawer'
        draft?: string
        scrollState?: {
          scrollTop: number
          scrollHeight: number
          clientHeight: number
          scrollRatio: number
          atBottom: boolean
        }
      }) => Promise<{ ok: true }>
      quitApp: () => Promise<boolean>
      listWorkspaceFiles: (workspace: string) => Promise<WorkspaceFileEntry[]>
      readWorkspaceFile: (workspace: string, path: string) => Promise<WorkspaceFileReadResult>
      writeWorkspaceFile: (
        workspace: string,
        path: string,
        content: string,
        baseEtag?: string | null
      ) => Promise<WorkspaceFileReadResult>
      captureSnapshot: (workspace: string) => Promise<any>
      computeRunDiff: (
        runId: string,
        preSnapshot: any,
        postSnapshot: any,
        changeContext?: any
      ) => Promise<any>
      getWorkspaceChangeSets: (filter?: WorkspaceChangeFilter) => Promise<WorkspaceChangeSet[]>
      getGeminiVersion: () => Promise<string>
      getGeminiCapabilities: (workspace?: string) => Promise<GeminiCapabilitiesState>
      getGeminiMcpBridgeStatus: () => Promise<GeminiMcpBridgeStatus>
      installGeminiMcpBridge: () => Promise<GeminiMcpBridgeStatus>
      setGeminiMcpBridgeEnabled: (enabled: boolean) => Promise<GeminiMcpBridgeStatus>
      runApprovedHostCommand: (requestId: string) => Promise<boolean>
      listGeminiSessions: () => Promise<GeminiSessionListResult>
      getHostWeather: () => Promise<HostWeatherState>
      setAppearanceMode: (
        payload: { mode?: string; reduceTransparency?: boolean } | string
      ) => Promise<boolean>
      getNativeCapabilities: () => Promise<NativeCapabilitySnapshot>

      checkTrust: (workspacePath: string) => Promise<TrustStatusResult>

      trustWorkspace: (workspacePath: string) => Promise<TrustWriteResult>

      agenticYoloGet: () => Promise<{ enabled: boolean; enabledAt: string | null }>
      agenticYoloSet: (enabled: boolean) => Promise<{ enabled: boolean; enabledAt: string | null }>
      onAgenticYoloState: (
        handler: (state: { enabled: boolean; enabledAt: string | null }) => void
      ) => () => void
      onAgentQuestionRequested: (
        handler: (request: {
          questionId: string
          appRunId: string
          appChatId: string
          provider?: string | null
          question: string
          options?: string[]
          context?: string
        }) => void
      ) => () => void
      onAgentQuestionCancelled: (
        handler: (info: { questionId: string; appChatId: string; reason: string }) => void
      ) => () => void
	      answerAgentQuestion: (payload: {
	        questionId: string
	        answer: string
	        isCustom?: boolean
	        appChatId?: string
	        appRunId?: string
	        workspaceId?: string | null
	      }) => Promise<{ ok: boolean; error?: string }>
	      cancelAgentQuestion: (payload: {
	        questionId: string
	        reason?: string
	        appChatId?: string
	        appRunId?: string
	        workspaceId?: string | null
	      }) => Promise<{ ok: boolean; error?: string }>
      openExternalOrPath: (href: string) => Promise<{ ok: boolean; error?: string }>
      revealPathInFinder: (path: string) => Promise<{ ok: boolean; error?: string }>
      getFaviconForUrl: (url: string) => Promise<
        | {
            ok: true
            origin: string
            host: string
            iconUrl: string
            dataUrl: string
            contentType: string
            source: 'cache' | 'network'
            title?: string
          }
        | { ok: false; origin?: string; host?: string; blocked?: boolean; error: string }
      >
      openProviderLoginTerminal: (provider: ProviderId) => Promise<{ ok: boolean; error?: string }>
      openProviderLogoutTerminal: (provider: ProviderId) => Promise<{ ok: boolean; error?: string }>
      openProviderUpgradeTerminal: (provider: ProviderId) => Promise<{ ok: boolean; error?: string }>
      startPty: (workspacePath: string, sessionId?: string) => Promise<void>
      stopPty: (sessionId?: string) => Promise<void>
      ptyWrite: (data: string, sessionId?: string) => Promise<void>
      ptyResize: (cols: number, rows: number, sessionId?: string) => Promise<void>
      startGeminiSession: (
        workspace: string,
        model?: string,
        approvalMode?: string,
        sessionTrust?: boolean,
        cols?: number,
        rows?: number,
        resumeSessionId?: string | null,
        worktree?: GeminiWorktreeLaunchOption
      ) => Promise<void>
      stopGeminiSession: () => Promise<void>
      writeGeminiSession: (data: string) => Promise<void>
      resizeGeminiSession: (cols: number, rows: number) => Promise<void>
      discoverGeminiCommands: (workspace: string) => Promise<any>
      discoverGeminiMemory: (workspace: string) => Promise<any>
      getFileIconDataUrl: (path: string) => Promise<string | null>
      onPtyData: (callback: (data: string, sessionId?: string) => void) => void
      onPtyExit: (callback: (code: number | null, sessionId?: string) => void) => void
      removePtyListeners: () => void
      onGeminiSessionData: (callback: (data: string) => void) => void
      onGeminiSessionExit: (callback: (code: number | null) => void) => void
      removeGeminiSessionListeners: () => void

      // Bridge / iOS remote allowlist (Phase C4 admin surface)
      bridgeAllowlistList: () => Promise<RemoteWorkspaceEntry[]>
      bridgeAllowlistUpsert: (entry: {
        workspaceId: string
        path: string
        mode: 'read-only' | 'read-write'
        capabilities?: RemoteWorkspaceCapability[]
        allowedProviders: string[]
        allowedApprovalModes: string[]
        expiresAt?: number
      }) => Promise<RemoteWorkspaceEntry>
      bridgeAllowlistRemove: (workspaceId: string) => Promise<boolean>
      bridgeAllowlistClear: () => Promise<boolean>
      updateSnapshot: () => Promise<UpdateStateSnapshot>
      checkForUpdates: () => Promise<UpdateStateSnapshot>
      downloadUpdate: () => Promise<UpdateStateSnapshot>
      installUpdateOnQuit: () => Promise<UpdateStateSnapshot>
      installUpdateNow: () => Promise<UpdateStateSnapshot>
      changelogSnapshot: () => Promise<ProductChangelogSnapshot>
      markChangelogSeen: (version: string) => Promise<ProductChangelogSnapshot>
      onUpdateStatusChanged: (callback: (snapshot: UpdateStateSnapshot) => void) => () => void
      localServersSnapshot: () => Promise<LocalServersSnapshot>
      localServersRefresh: () => Promise<LocalServersSnapshot>
      localServersStop: (pid: number) => Promise<{ ok: boolean }>
      localServersStopAll: () => Promise<{ stopped: number }>
      onLocalServersChanged: (callback: (snapshot: LocalServersSnapshot) => void) => () => void
      bridgeNetworkingStatus: () => Promise<{
        lan: {
          enabled: boolean
          running: boolean
          settingEnabled: boolean
          effectiveEnabled: boolean
          envOverride: 'force-on' | 'force-off' | null
          status: 'running' | 'stopped'
          pid?: number | null
          startedAt?: string | null
          lastError?: string | null
          bonjourServiceType: string | null
          hostname: string
          localOnly?: boolean
          nativeCapabilities?: NativeCapabilitySnapshot
        }
        tailscale: {
          available: boolean
          cliPath?: string
          version?: string
          tailnetIPv4?: string
          tailnetIPv6?: string
          hostname?: string
          tailnetName?: string
          magicDNSEnabled?: boolean
          reason?: string
        }
      }>
      getIosRemoteConfig: () => Promise<{
        enabled: boolean
        relayUrl: string
        effectiveEnabled: boolean
        envOverride: 'force-on' | 'force-off' | null
        runtimeActive: boolean
        openAtLogin?: boolean
      }>
      setIosRemoteConfig: (config: {
        enabled?: boolean
        relayUrl?: string
        openAtLogin?: boolean
      }) => Promise<{
        enabled: boolean
        relayUrl: string
        effectiveEnabled: boolean
        envOverride: 'force-on' | 'force-off' | null
        runtimeActive: boolean
        openAtLogin?: boolean
      }>
      iosRemoteTailscaleStatus: () => Promise<{
        tailscaleAvailable: boolean
        tailscaleReason: string | null
        dnsName: string | null
        suggestedUrl: string | null
        relayPort: number
        serveConfigured: boolean
        serveHttpsPort: number | null
        serveError: string | null
        relayUrlMatches: boolean
        active: boolean
        runtimeActive: boolean
      }>
      iosRemoteTailscaleEnable: () => Promise<{
        ok: boolean
        message?: string | null
        status?: Record<string, unknown>
      }>
      iosRemoteTailscaleDisable: () => Promise<{
        ok: boolean
        message?: string | null
        status?: Record<string, unknown>
      }>
      setBridgeDaemonEnabled: (enabled: boolean) => Promise<{
        lan: {
          enabled: boolean
          running: boolean
          settingEnabled: boolean
          effectiveEnabled: boolean
          envOverride: 'force-on' | 'force-off' | null
          status: 'running' | 'stopped'
          pid?: number | null
          startedAt?: string | null
          lastError?: string | null
          bonjourServiceType: string | null
          hostname: string
          localOnly?: boolean
          nativeCapabilities?: NativeCapabilitySnapshot
        }
        tailscale: {
          available: boolean
          cliPath?: string
          version?: string
          tailnetIPv4?: string
          tailnetIPv6?: string
          hostname?: string
          tailnetName?: string
          magicDNSEnabled?: boolean
          reason?: string
        }
      }>
      bridgeFinalizePairing: (sessionID: string, userConfirmed: boolean) => Promise<unknown>
      onBridgePairingResponseReceived: (callback: (params: unknown) => void) => () => void

      // Attached-window picker. The renderer triggers `attachWindowPick`
      // (button or hotkey), main forwards to the bridge daemon which
      // presents the macOS system picker. Status events fire on
      // pick/detach and on daemon exit so the renderer can keep its
      // status pill in sync.
      //
      // Phase M1 — the snapshot can now carry an optional `streaming`
      // block when Appwatch is running for the handle, so the pill can
      // switch between its `attached` and `streaming` visual states
      // without an extra IPC round-trip.
      attachWindowPick: () => Promise<{
        ok: boolean
        cancelled?: boolean
        error?: string
        snapshot?: {
          handleID: string
          windowMeta: {
            windowID: number
            title: string
            bundleID: string
            applicationName: string
            pid: number
          }
          attachedAt: string
          streaming?: {
            fps: number
            bufferSeconds: number
            frameCount: number
            startedAt: string
          }
        }
      }>
      attachWindowDetach: () => Promise<{ ok: boolean }>
      attachWindowStatus: () => Promise<{
        snapshot: {
          handleID: string
          windowMeta: {
            windowID: number
            title: string
            bundleID: string
            applicationName: string
            pid: number
          }
          attachedAt: string
          streaming?: {
            fps: number
            bufferSeconds: number
            frameCount: number
            startedAt: string
          }
        } | null
      }>
      // M11 (1.0.7) — sticky AppWatch per-chat attachment snapshots.
      stickyAppWatchGet: (chatId: string) => Promise<{
        snapshot: {
          chatId: string
          windowMeta: {
            windowID: number
            title: string
            bundleID: string
            applicationName: string
            pid: number
          }
          attachedAt: string
          stashedAt: string
          wasStreaming: boolean
        } | null
      }>
      stickyAppWatchStash: (input: {
        chatId: string
        windowMeta: {
          windowID: number
          title: string
          bundleID: string
          applicationName: string
          pid: number
        }
        attachedAt: string
        wasStreaming: boolean
      }) => Promise<{ ok: boolean }>
      stickyAppWatchClear: (chatId: string) => Promise<{ ok: boolean }>
      onAttachedWindowChanged: (
        callback: (
          snapshot: {
            handleID: string
            windowMeta: {
              windowID: number
              title: string
              bundleID: string
              applicationName: string
              pid: number
            }
            attachedAt: string
            streaming?: {
              fps: number
              bufferSeconds: number
              frameCount: number
              startedAt: string
            }
          } | null
        ) => void
      ) => () => void
      // Begins a daemon-side pairing session. Returns the bootstrap
      // payload (PairingBootstrapPayload from the Swift daemon) so the
      // renderer can encode it as a QR for the iOS app, or surface it
      // as raw JSON for the "Paste JSON instead" fallback on iOS.
      bridgeBeginPairing: (
        displayName?: string,
        options?: { force?: boolean }
      ) => Promise<{
        ok: boolean
        bootstrap?: unknown // PairingBootstrapPayload shape; consumer passes through to QR/JSON
        error?: string
      }>
      bridgeListPairedDevices: () => Promise<
        Array<{
          iphoneIdentityPubKey: string
          pairId: string
          controllerDisplayName: string
          pairedAt: string
          connected: boolean
        }>
      >
      bridgeUnpairDevice: (iphoneIdentityPubKey: string) => Promise<{ ok: boolean; error?: string }>

      // Phase E1: APNs config surface for the Settings panel. The
      // `getApnsConfig` response NEVER includes decrypted key material
      // — main holds the cleartext via safeStorage and only sends
      // redacted status (configured flag, keyId, teamId, bundleId,
      // configuredAt, last test result, encryption availability,
      // paired-device count) to the renderer.
      getApnsConfig: () => Promise<{
        configured: boolean
        keyId?: string
        teamId?: string
        bundleId?: string
        defaultBundleId: string
        configuredAt?: string
        lastTestResult?: {
          at: string
          delivered: number
          failed: number
          error?: string
        }
        encryptionAvailable: boolean
        registeredDeviceCount: number
        pusherIsNoop: boolean
      }>
      selectApnsKeyFile: () => Promise<string | null>
      setApnsConfig: (input: {
        authKeyPath?: string
        keyId?: string
        teamId?: string
        bundleId?: string
      }) => Promise<{ ok: boolean; error?: string }>
      clearApnsConfig: () => Promise<{ ok: boolean }>
      testApnsPush: () => Promise<{
        ok: boolean
        at?: string
        delivered?: number
        failed?: number
        error?: string
      }>

      getSettings: () => Promise<AppSettings>
      updateSettings: (partial: Partial<AppSettings>) => Promise<void>
      upsertAgenticWorkspaceGrant: (
        provider: ProviderId,
        workspacePath: string,
        service: AgenticServiceId
      ) => Promise<AppSettings>
      removeAgenticWorkspaceGrant: (
        provider: ProviderId,
        workspacePath: string,
        service: AgenticServiceId
      ) => Promise<AppSettings>
      getRuntimeProfiles: (provider?: ProviderId) => Promise<RuntimeProfile[]>
      saveRuntimeProfile: (
        profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
      ) => Promise<RuntimeProfile>
      deleteRuntimeProfile: (id: string) => Promise<void>
      getHandoffCards: (filter?: HandoffCardFilter) => Promise<HandoffCard[]>
      saveHandoffCard: (
        card: Partial<HandoffCard> &
          Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
      ) => Promise<HandoffCard>
      updateHandoffCard: (id: string, partial: Partial<HandoffCard>) => Promise<HandoffCard | null>
      deleteHandoffCard: (id: string) => Promise<void>
      getWorkspaces: () => Promise<WorkspaceRecord[]>
      addOrUpdateWorkspace: (
        path: string,
        partial?: Partial<WorkspaceRecord>
      ) => Promise<WorkspaceRecord>
      removeWorkspace: (id: string) => Promise<void>
      clearWorkspaces: () => Promise<void>
      getChats: (workspaceId?: string) => Promise<ChatRecord[]>
      getChatList: (workspaceId?: string) => Promise<ChatListItem[]>
      getPinnedMessages: (workspaceId?: string) => Promise<PinnedMessageGroup[]>
      getChat: (chatId: string) => Promise<ChatRecord | null>
      createChat: (workspaceId: string, workspacePath: string) => Promise<ChatRecord>
      createGlobalChat: () => Promise<ChatRecord>
      createEnsembleChat: (args?: {
        workspaceId?: string
        workspacePath?: string
      }) => Promise<ChatRecord>
      runEnsembleRound: (payload: {
        chatId: string
        prompt: string
        mode?: 'normal' | 'queue' | 'steer'
        concurrentMode?: boolean
        imageAttachments?: ComposerImageAttachment[]
        discordContextSnapshots?: DiscordContextSnapshot[]
        externalPathGrants?: ExternalPathGrant[]
        /** A2 (1.0.3) — DM routing: scope the round to a single chip. */
        dmTargetParticipantId?: string
      }) => Promise<{ status: string; roundId?: string }>
      cancelEnsembleRound: (chatId: string) => Promise<boolean>
      skipEnsembleParticipant: (chatId: string) => Promise<boolean>
      getLatestSessionCheckpoint: (chatId: string) => Promise<SessionCheckpointRecord | null>
      acceptSessionCheckpoint: (
        checkpointId: string
      ) => Promise<
        | { ok: true; checkpoint: SessionCheckpointRecord; resumePrompt: string }
        | { ok: false; error: string }
      >
      dismissSessionCheckpoint: (
        checkpointId: string
      ) => Promise<
        | { ok: true; checkpoint: SessionCheckpointRecord }
        | { ok: false; error: string }
      >
      wakeEnsembleParticipantNow: (wakeupId: string) => Promise<boolean>
      cancelEnsembleParticipantWakeup: (
        wakeupId: string
      ) => Promise<{ ok: boolean; error?: string }>
      createSubThread: (args: {
        parentChatId: string
        provider: ProviderId
        delegationPrompt: string
        returnResultToParent: boolean
        workspaceId?: string
        workspacePath?: string
      }) => Promise<ChatRecord>
      getSubThreads: (parentChatId: string) => Promise<ChatRecord[]>
      createSideChat: (args: {
        parentChatId: string
        chatKind?: 'single' | 'ensemble'
        provider?: ProviderId
        title?: string
        originMessageId?: string
        originRunId?: string
        sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut' | 'guestParticipant'
      }) => Promise<ChatRecord>
      getSideChats: (parentChatId: string) => Promise<ChatRecord[]>
      setGuestParticipant: (args: {
        parentChatId: string
        provider: ProviderId
        selectedModelType?: string
        customModel?: string
        codexReasoningEffort?: string | null
        codexServiceTier?: string | null
        claudeReasoningEffort?: string | null
        claudeFastMode?: boolean | null
        kimiThinkingEnabled?: boolean
      }) => Promise<{ parent: ChatRecord; guest: ChatRecord }>
      removeGuestParticipant: (
        parentChatId: string
      ) => Promise<{ parent: ChatRecord; guest?: ChatRecord }>
      listMessageChannelAdapters: () => Promise<MessageChannelAdapterRuntimeStatus[]>
      listMessageChannelBindings: () => Promise<MessageChannelBinding[]>
      upsertMessageChannelBinding: (
        input: MessageChannelBindingInput
      ) => Promise<MessageChannelBinding>
      archiveMessageChannelBinding: (bindingId: string) => Promise<MessageChannelBinding | null>
      sendMessageChannelTest: (bindingId: string) => Promise<{
        ok: true
        bindingId: string
        recipientHandle: string
        result?: unknown
      }>
      pollMessageChannelBinding: (
        bindingId: string
      ) => Promise<MessageChannelPollSummary & { bindingId: string }>
      peekMessageChannelBinding: (
        bindingId: string
      ) => Promise<MessagesBridgePollResult & { bindingId: string }>
      getMessagesBridgeStatus: () => Promise<{
        ok: boolean
        platform: string
        pollSupported: boolean
        sendTextSupported: boolean
        sendAttachmentSupported?: boolean
        reason?: string
        [key: string]: unknown
      }>
      openMessagesPermissionHelper: () => Promise<{
        ok: true
        appName: string
        dragTarget: string
      }>
      startMessagesPermissionHelperDrag: () => void
      revealMessagesPermissionHelperApp: () => Promise<{ ok: boolean; error?: string }>
      listMessagesBridgeConversations: (
        params?: MessagesBridgeConversationsParams
      ) => Promise<MessagesBridgeConversationListResult>
      pollMessageChannelsOnce: (
        params?: MessagesBridgePollParams
      ) => Promise<MessageChannelPollSummary>
      submitLocalWebChannelMessage: (input: LocalWebChannelSubmitInput) => Promise<{
        ok: true
        message: MessagesBridgePollResult['messages'][number]
        summary: MessageChannelPollSummary
      }>
      drainLocalWebChannelOutbox: (params?: {
        accountId?: string
        chatGuid?: string
      }) => Promise<{
        ok: true
        messages: LocalWebChannelOutboundMessage[]
      }>
      listMessageChannelCursors: () => Promise<MessageChannelCursor[]>
      clearMessageChannelCursors: () => Promise<{ ok: boolean }>
      clearMessageChannelBindingCursor: (
        bindingId: string
      ) => Promise<{ ok: boolean; bindingId: string }>
      listMessageChannelAudit: (limit?: number) => Promise<MessageChannelAuditRecord[]>
      listDiscordContextTargets: () => Promise<DiscordContextTargets>
      readDiscordContext: (selection: DiscordContextSelection) => Promise<DiscordContextSnapshot>
      saveChat: (chat: ChatRecord) => Promise<void>
      deleteChat: (chatId: string) => Promise<void>
      truncateChat: (chatId: string) => Promise<ChatRecord | null>
      clearChats: (workspaceId?: string) => Promise<void>
      recordUsage: (usage: Omit<UsageRecord, 'id' | 'timestamp'>) => Promise<void>
      getUsage: (workspaceId?: string, chatId?: string) => Promise<UsageRecord[]>
      getWorkspaceActivity: (
        workspacePath: string,
        dayCount?: number
      ) => Promise<WorkspaceActivitySnapshot>
      getScheduledTasks: (workspaceId?: string) => Promise<ScheduledTask[]>
      saveScheduledTask: (
        task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
          Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>>
      ) => Promise<ScheduledTask>
      updateScheduledTask: (
        id: string,
        partial: Partial<ScheduledTask>
      ) => Promise<ScheduledTask | null>
      deleteScheduledTask: (id: string) => Promise<void>
      getWorkflowDefinitions: (workspaceId?: string) => Promise<WorkflowDefinition[]>
      saveWorkflowDefinition: (
        workflow: Omit<
          WorkflowDefinition,
          'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'
        > &
          Partial<
            Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>
          >
      ) => Promise<WorkflowDefinition>
      updateWorkflowDefinition: (
        id: string,
        partial: Partial<WorkflowDefinition>
      ) => Promise<WorkflowDefinition | null>
      deleteWorkflowDefinition: (id: string) => Promise<void>
      runWorkflowNow: (id: string) => Promise<ScheduledTask | null>
      startAuditRun: (input: {
        mode?: AuditRunRecord['mode']
        chatId: string
        preferredProvider?: ProviderId
        workspacePath: string
        workspaceId?: string
      }) => Promise<AuditRunRecord>
      cancelAuditRun: (auditRunId: string) => Promise<{ ok: boolean }>
      getAuditRun: (auditRunId: string) => Promise<AuditRunRecord | null>
      getAuditRuns: (workspaceId?: string) => Promise<AuditRunRecord[]>
      getRunQueueJobs: (filter?: RunQueueJobFilter) => Promise<RunQueueJob[]>
      requestRunQueueJob: (
        job: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'>
      ) => Promise<RunQueueJob>
      leaseRunQueueJob: (request?: {
        runId?: string
        provider?: ProviderId
        statusReason?: string
      }) => Promise<RunQueueJob | null>
      transitionRunQueueJob: (
        runIdOrId: string,
        status: RunQueueJob['status'],
        partial?: Pick<Partial<RunQueueJob>, 'statusReason' | 'lastError'>
      ) => Promise<RunQueueJob | null>
      getRunRecoveryRecords: (filter?: RunRecoveryFilter) => Promise<RunRecoveryRecord[]>
      getRunEvents: (filter?: RunEventFilter) => Promise<RunEventRecord[]>
      getRunEventReplay: (runId: string) => Promise<RunEventReplay>
      analyzeRun: (request: RunAnalystRequest) => Promise<RunAnalystSnapshot>
      getApprovalLedger: (filter?: ApprovalLedgerFilter) => Promise<ApprovalLedgerRecord[]>
      recordApprovalElevationAck: (input: {
        provider: string
        workspacePath: string | null
        toMode: string
        tier: number
      }) => Promise<void>
      getProductOperationsStatus: () => Promise<ProductOperationsStatus>
      getProductCrashes: (filter?: ProductCrashFilter) => Promise<ProductCrashRecord[]>
      recordProductCrash: (input: ProductCrashInput) => Promise<ProductCrashRecord>
      exportProductDiagnostics: (path?: string) => Promise<ProductDiagnosticsExportResult>
      repairProductInstall: () => Promise<ProductOperationsStatus>
      getAppShellStats: () => Promise<AppShellStatsSnapshot>
      getAppVersion: () => Promise<string>
      submitBugReport: (payload: {
        title: string
        description: string
        expected: string
        severity: 'info' | 'minor' | 'major' | 'blocking'
        context: {
          timestamp: string
          version: string
          provider: string
          workspace: string
          shell: string
          surface?: string
          chatKind?: string
          settingsTab?: string
          inspectorTab?: string
          theme?: string
          promptBubble?: string
          ensemble?: string
        }
      }) => Promise<{ ok: boolean; path?: string; error?: string }>

      onGeminiOutput: (callback: (data: GeminiStreamPayload) => void) => void
      onGeminiError: (callback: (error: GeminiStreamPayload) => void) => void
      onGeminiExit: (callback: (code: GeminiStreamPayload | number | null) => void) => void
      onAgentOutput: (
        callback: (payload: {
          provider: ProviderId
          data: string
          appRunId?: string
          appChatId?: string
        }) => void
      ) => () => void
      onAgentError: (
        callback: (payload: {
          provider: ProviderId
          error: string
          appRunId?: string
          appChatId?: string
        }) => void
      ) => () => void
      onAgentExit: (
        callback: (payload: {
          provider: ProviderId
          code: number | null
          appRunId?: string
          appChatId?: string
        }) => void
      ) => void
      onRunQueueChanged: (callback: (jobs: RunQueueJob[]) => void) => void
      onRunEventsChanged: (
        callback: (payload: {
          runId: string
          chatId?: string
          workspaceId?: string
          sequence: number
        }) => void
      ) => void
      onAgentApprovalRequest: (callback: (payload: AgentApprovalRequest) => void) => void
      onAgentApprovalTimeout: (
        callback: (payload: {
          approvalId: string
          appliedMs: number
          source: 'perKind' | 'mainAuthority' | 'providerDefault'
        }) => void
      ) => void
      onAgentApprovalResolved: (
        callback: (payload: {
          approvalId: string
          action?: string
          decisionSource?: string
          provider?: string
          threadId?: string
        }) => void
      ) => void
      onScheduledTaskDue: (callback: (payload: ScheduledTask) => void) => void
      onScheduledTasksChanged: (callback: (payload: ScheduledTask[]) => void) => void
      onWorkflowDefinitionsChanged: (callback: (payload: WorkflowDefinition[]) => void) => void
      onAuditRunChanged: (callback: (run: AuditRunRecord) => void) => () => void
      onUsageChanged: (callback: () => void) => void
      onChatUpdated: (callback: (chat: ChatRecord) => void) => () => void
      onAppShellStatsChanged: (callback: (snapshot: AppShellStatsSnapshot) => void) => () => void
      onWorkspacePopoutRefresh: (
        callback: (payload: { workspacePath: string; reason: string }) => void
      ) => () => void
      onSideChatDockRequest: (
        callback: (payload: {
          chatId: string
          parentChatId: string
          presentation: 'split' | 'drawer'
          draft?: string
          scrollState?: {
            scrollTop: number
            scrollHeight: number
            clientHeight: number
            scrollRatio: number
            atBottom: boolean
          }
        }) => void
      ) => () => void
      onCreativeActionRequest: (
        callback: (payload: {
          requestId: string
          className: string
          details: {
            title: string
            description: string
            filePath?: string
            targetBundleId?: string
            payloadPreview?: string
          }
        }) => void
      ) => () => void
      decideCreativeAction: (
        requestId: string,
        approved: boolean,
        rememberForSession: boolean
      ) => void
      removeListeners: () => void
    }
  }
}
