import { contextBridge, ipcRenderer } from 'electron'
import type {
  GeminiWorktreeLaunchOption,
  ProviderId,
  RunAnalystRequest,
  RunAnalystSnapshot,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  WorkspaceActivitySnapshot
} from '../main/store/types'
import type { AppShellStatsSnapshot } from '../main/services/AppShellStatsService'
import type { SessionCheckpointRecord } from '../main/checkpoints/SessionCheckpoint'
import type { MessageChannelBindingInput } from '../main/channels/MessageChannelTypes'
import type {
  LocalWebChannelOutboundMessage,
  LocalWebChannelSubmitInput
} from '../main/channels/LocalWebChannelAdapter'
import type {
  MessagesBridgeConversationsParams,
  MessagesBridgePollResult,
  MessagesBridgePollParams
} from '../main/channels/MessageChannelGatewayService'
import type {
  DiscordContextSelection,
  DiscordContextSnapshot
} from '../main/channels/DiscordContextService'
import type {
  GitPrReadiness,
  GitPrSummary,
  GitRepositorySnapshot,
  GitResult
} from '../main/services/GitService'
import type {
  FallbackPromotedSteerInput,
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerInput,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerInput,
  PromoteQueuedJobForSteerResult
} from '../main/services/RunLifecycleCoordinator'
import type {
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginContributionSnapshot,
  TaskWraithPluginMcpPresetMaterializationResult,
  TaskWraithPluginSecretMutationResult,
  TaskWraithPluginSecretStatusSnapshot
} from '../shared/plugins/PluginTypes'

type ComposerImageAttachment = {
  id?: string
  path?: string
  name?: string
}

// Custom APIs for renderer
const api = {
  hostPlatform: process.platform,
  getRuntimeVersions: () => ({ ...(process?.versions || {}) }),
  selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
  selectImageFiles: () => ipcRenderer.invoke('select-image-files'),
  saveClipboardImageAttachment: () => ipcRenderer.invoke('save-clipboard-image-attachment'),
  authorizeImagePreview: (paths: string[]) => ipcRenderer.invoke('authorize-image-preview', paths),
  readImagePreview: (path: string) => ipcRenderer.invoke('read-image-preview', path),
  imageGenerationGetStatus: () => ipcRenderer.invoke('image-generation:get-status'),
  imageGenerationSetEnabled: (input: { enabled: boolean; provider?: 'openai' | 'xai' }) =>
    ipcRenderer.invoke('image-generation:set-enabled', input),
  imageGenerationSetKey: (input: { provider: 'openai' | 'xai'; key: string }) =>
    ipcRenderer.invoke('image-generation:set-key', input),
  imageGenerationClearKey: (input: { provider: 'openai' | 'xai' }) =>
    ipcRenderer.invoke('image-generation:clear-key', input),
  getLastSpellcheckContext: (point: { x: number; y: number }) =>
    ipcRenderer.invoke('spellcheck:get-last-context', point),
  replaceMisspelling: (payload: { suggestion: string; point: { x: number; y: number } }) =>
    ipcRenderer.invoke('spellcheck:replace-misspelling', payload),
  addWordToSpellCheckerDictionary: (payload: { point: { x: number; y: number } }) =>
    ipcRenderer.invoke('spellcheck:add-word-to-dictionary', payload),
  onSpellcheckContextMenu: (
    callback: (payload: {
      point: { x: number; y: number }
      spellcheckContext: {
        x: number
        y: number
        misspelledWord: string
        dictionarySuggestions: string[]
        createdAt: number
      } | null
    }) => void
  ) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('spellcheck:context-menu', wrapped)
    return () => ipcRenderer.removeListener('spellcheck:context-menu', wrapped)
  },
  sidebarShowWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke('sidebar:show-workspace-in-finder', workspaceId),
  sidebarCopyWorkspaceDirectory: (workspaceId: string) =>
    ipcRenderer.invoke('sidebar:copy-workspace-directory', workspaceId),
  sidebarShowChatWorkspaceInFinder: (chatId: string) =>
    ipcRenderer.invoke('sidebar:show-chat-workspace-in-finder', chatId),
  sidebarCopyChatWorkingDirectory: (chatId: string) =>
    ipcRenderer.invoke('sidebar:copy-chat-working-directory', chatId),
  sidebarCopyChatTranscriptPath: (chatId: string) =>
    ipcRenderer.invoke('sidebar:copy-chat-transcript-path', chatId),
  copyChatMarkdownTranscript: (chatId: string) =>
    ipcRenderer.invoke('copy-chat-markdown-transcript', chatId),
  // Phase J1 (composer unification): the picker is now cross-provider —
  // optional `provider` argument so the main process can stamp the
  // grant with the requesting provider (defaults to 'codex' for
  // back-compat with prior renderers that only sent `access`).
  selectExternalPathGrant: (access: 'read' | 'write' = 'read', provider?: string) =>
    ipcRenderer.invoke('select-external-path-grant', access, provider),
  /**
   * 1.0.5-EW42a — Proactive external-path grant from the composer's
   * workspace switcher. Opens an OS folder picker, then for each
   * unique participant-provider on the chat (or the chat's primary
   * provider for single-provider chats) issues an
   * `ExternalPathGrant` and persists it to the chat's metadata.
   * Broadcasts the updated chat so the renderer's
   * `ExternalPathAboveRow` banner appears immediately.
   *
   * Returns `{ ok: true, grants, path }` on success;
   * `{ ok: false, reason }` for the empty / cancelled / no-chat /
   * no-window cases. The renderer doesn't need the grants payload
   * (the chat-updated event re-renders everything) but it's
   * returned in case a caller wants to surface a toast like
   * "Granted read access to <basename>".
   */
  pickAndPersistExternalPathGrant: (payload: {
    chatId: string
    access?: 'read' | 'write'
    // 1.0.6-EW69 — optional explicit path: when supplied, main skips the
    // OS folder dialog and grants this exact path (composer picker's
    // "attach a known workspace as a secondary" action).
    path?: string
    deferPersist?: boolean
  }): Promise<
    | { ok: true; grants: unknown[]; path: string }
    | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }
  > => ipcRenderer.invoke('external-path:pick-and-persist', payload),
  /**
   * Slice 1 of the external-path-redesign arc. Renderer asks main to
   * look at an absolute path and report whether it's a git repo (and
   * what branch is checked out). Used by the new stacked above-rows
   * to label each external-path grant. Returns
   *   { isRepo: true, repoRoot, branch? }
   * for repos, or null when the path doesn't exist / isn't a repo.
   */
  probeExternalPath: (absolutePath: string) =>
    ipcRenderer.invoke('probe-external-path', absolutePath) as Promise<{
      isRepo: boolean
      repoRoot: string
      branch?: string
    } | null>,
  runGemini: (
    workspace: string,
    prompt: string,
    model: string,
    approvalMode: string,
    sessionTrust: boolean = false,
    imagePaths: string[] = [],
    resumeSessionId: string | null = null,
    worktree: GeminiWorktreeLaunchOption = null,
    route: any = null
  ) =>
    ipcRenderer.invoke(
      'run-gemini',
      workspace,
      prompt,
      model,
      approvalMode,
      sessionTrust,
      imagePaths,
      resumeSessionId,
      worktree,
      route
    ),
  cancelGemini: (runId?: string) => ipcRenderer.invoke('cancel-gemini', runId),
  composeRun: (input: any) => ipcRenderer.invoke('compose-run', input),
  runAgent: (payload: any) => ipcRenderer.invoke('run-agent', payload),
  cancelAgentRun: (provider: ProviderId = 'gemini', runId?: string) =>
    ipcRenderer.invoke('cancel-agent-run', provider, runId),
  getAgentStatus: (provider: ProviderId) => ipcRenderer.invoke('get-agent-status', provider),
  getProviderCapabilities: (provider: ProviderId, workspace?: string, approvalMode?: string) =>
    ipcRenderer.invoke('get-provider-capabilities', provider, workspace, approvalMode),
  getProviderAdapters: () => ipcRenderer.invoke('get-provider-adapters'),
  // 1.0.5-EW35 — Currency sub-slice (c): live FX rate snapshot.
  // Renderer hydrates `formatCost`'s in-memory rate table from this
  // on app boot. `refreshFxRates` is reserved for a future explicit
  // "refresh now" button; not wired into any UI yet.
  getFxRates: () =>
    ipcRenderer.invoke('fx-rates:get') as Promise<{
      rates: { USD: 1; GBP: number; EUR: number }
      fetchedAt: string
      source: 'live' | 'cached' | 'fallback'
      errorMessage?: string
    }>,
  refreshFxRates: (force?: boolean) =>
    ipcRenderer.invoke('fx-rates:refresh', force) as Promise<{
      rates: { USD: 1; GBP: number; EUR: number }
      fetchedAt: string
      source: 'live' | 'cached' | 'fallback'
      errorMessage?: string
    }>,
  // 1.0.5-EW38 — Currency sub-slice (d): per-provider rate
  // snapshot. The renderer can read this for future cost-estimation
  // features (pre-flight estimate, per-model price comparison) —
  // not surfaced in any UI yet in 1.0.5. The `probe` field surfaces
  // last best-effort scrape results so a settings UI can warn
  // about possible drift.
  getProviderRates: () => ipcRenderer.invoke('providerRates:get'),
  probeProviderRates: () => ipcRenderer.invoke('providerRates:probe'),
  getAgentModels: (provider: ProviderId) => ipcRenderer.invoke('get-agent-models', provider),
  getAgentRateLimits: (provider: ProviderId) =>
    ipcRenderer.invoke('get-agent-rate-limits', provider),
  importCodexUsageCredential: (filePath?: string) =>
    ipcRenderer.invoke('import-codex-usage-credential', filePath),
  clearCodexUsageCredential: () => ipcRenderer.invoke('clear-codex-usage-credential'),
  getCodexUsageSnapshot: () => ipcRenderer.invoke('get-codex-usage-snapshot'),
  getExternalUsage: (options?: { force?: boolean }) =>
    ipcRenderer.invoke('get-external-usage', options),
  probeGrokUsage: () => ipcRenderer.invoke('grok-usage:probe'),
  gitSnapshot: (payload: { workspacePath?: string; repoPath?: string }) =>
    ipcRenderer.invoke('git:snapshot', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitStage: (payload: {
    workspacePath?: string
    repoPath?: string
    paths?: string[]
    all?: boolean
    update?: boolean
    patch?: string
  }) => ipcRenderer.invoke('git:stage', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitUnstage: (payload: { workspacePath?: string; repoPath?: string; paths?: string[] }) =>
    ipcRenderer.invoke('git:unstage', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitCommit: (payload: { workspacePath?: string; repoPath?: string; message: string }) =>
    ipcRenderer.invoke('git:commit', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitPush: (payload: {
    workspacePath?: string
    repoPath?: string
    setUpstream?: boolean
    remote?: string
  }) => ipcRenderer.invoke('git:push', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  githubPrStatus: (payload: { workspacePath?: string; repoPath?: string }) =>
    ipcRenderer.invoke('github:pr-status', payload) as Promise<GitResult<GitPrSummary>>,
  githubPrReadiness: (payload: { workspacePath?: string; repoPath?: string }) =>
    ipcRenderer.invoke('github:pr-readiness', payload) as Promise<GitResult<GitPrReadiness>>,
  createGithubPr: (payload: {
    workspacePath?: string
    repoPath?: string
    title?: string
    body?: string
    draft?: boolean
    openInBrowser?: boolean
  }) => ipcRenderer.invoke('create-github-pr', payload),
  getClaudeAuthStatus: () => ipcRenderer.invoke('get-claude-auth-status'),
  storeClaudeApiKey: (key: string) => ipcRenderer.invoke('store-claude-api-key', key),
  clearClaudeApiKey: () => ipcRenderer.invoke('clear-claude-api-key'),
  triggerClaudeLogin: () => ipcRenderer.invoke('trigger-claude-login'),
  getKimiAuthStatus: () => ipcRenderer.invoke('get-kimi-auth-status'),
  storeKimiApiKey: (key: string) => ipcRenderer.invoke('store-kimi-api-key', key),
  clearKimiApiKey: () => ipcRenderer.invoke('clear-kimi-api-key'),
  upgradeKimiCli: () => ipcRenderer.invoke('provider:open-upgrade-terminal', 'kimi'),
  getGeminiAuthStatus: () => ipcRenderer.invoke('get-gemini-auth-status'),
  listGeminiAuthProfiles: () => ipcRenderer.invoke('list-gemini-auth-profiles'),
  saveGeminiAuthProfile: (profile: any) => ipcRenderer.invoke('save-gemini-auth-profile', profile),
  deleteGeminiAuthProfile: (profileId: string) =>
    ipcRenderer.invoke('delete-gemini-auth-profile', profileId),
  setDefaultGeminiAuthProfile: (profileId: string | null) =>
    ipcRenderer.invoke('set-default-gemini-auth-profile', profileId),
  startGeminiOAuthLogin: (input?: any) => ipcRenderer.invoke('start-gemini-oauth-login', input),
  getGeminiOAuthLoginStatus: (profileId?: string | null) =>
    ipcRenderer.invoke('get-gemini-oauth-login-status', profileId),
  cancelGeminiOAuthLogin: (profileId?: string | null) =>
    ipcRenderer.invoke('cancel-gemini-oauth-login', profileId),
  getAgentMcpStatus: (provider: ProviderId) => ipcRenderer.invoke('get-agent-mcp-status', provider),
  listAgentThreads: (provider: ProviderId, params: any = {}) =>
    ipcRenderer.invoke('list-agent-threads', provider, params),
  forkAgentThread: (provider: ProviderId, threadId: string, params: any = {}) =>
    ipcRenderer.invoke('fork-agent-thread', provider, threadId, params),
  rollbackAgentThread: (provider: ProviderId, threadId: string, numTurns: number = 1) =>
    ipcRenderer.invoke('rollback-agent-thread', provider, threadId, numTurns),
  startAgentReview: (provider: ProviderId, threadId: string, params: any = {}) =>
    ipcRenderer.invoke('start-agent-review', provider, threadId, params),
  respondAgentApproval: (
    requestId: string,
    action:
      | 'accept'
      | 'acceptForSession'
      | 'acceptForWorkspace'
      | 'decline'
      | 'cancel'
      | 'grantExternalPathRead'
      | 'grantExternalPathEdit'
      | 'declineExternalPath',
    // Order-4 — optional one-line "why" note. Persisted onto the
    // approval-ledger row's metadata; never required.
    intentNote?: string
  ) => ipcRenderer.invoke('respond-agent-approval', requestId, action, intentNote),
  writeGeminiInput: (data: string) => ipcRenderer.invoke('write-gemini-input', data),
  getDiff: (workspace: string) => ipcRenderer.invoke('get-diff', workspace),
  openWorkspacePopout: (
    input:
      | { kind: 'file-editor' | 'diff-studio' | 'workbench'; workspacePath: string }
      | { kind: 'chat'; chatId: string; workspacePath?: string }
  ) => ipcRenderer.invoke('open-workspace-popout', input) as Promise<{ ok: true }>,
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
  }) => ipcRenderer.invoke('dock-side-chat-popout', input) as Promise<{ ok: true }>,
  quitApp: () => ipcRenderer.invoke('app:quit') as Promise<boolean>,
  listWorkspaceFiles: (workspace: string) => ipcRenderer.invoke('list-workspace-files', workspace),
  listWorkspaceFilesForEditor: (
    workspace: string,
    options?: { path?: string; query?: string; limit?: number }
  ) => ipcRenderer.invoke('list-workspace-files-for-editor', workspace, options),
  readWorkspaceFile: (workspace: string, path: string) =>
    ipcRenderer.invoke('read-workspace-file', workspace, path),
  writeWorkspaceFile: (
    workspace: string,
    path: string,
    content: string,
    baseEtag?: string | null
  ) => ipcRenderer.invoke('write-workspace-file', workspace, path, content, baseEtag),
  deleteWorkspaceFile: (workspace: string, path: string) =>
    ipcRenderer.invoke('delete-workspace-file', workspace, path),
  captureSnapshot: (workspace: string) => ipcRenderer.invoke('capture-snapshot', workspace),
  computeRunDiff: (runId: string, preSnapshot: any, postSnapshot: any, changeContext: any = null) =>
    ipcRenderer.invoke('compute-run-diff', runId, preSnapshot, postSnapshot, changeContext),
  getWorkspaceChangeSets: (filter: any = {}) =>
    ipcRenderer.invoke('get-workspace-change-sets', filter),
  getGeminiVersion: () => ipcRenderer.invoke('get-gemini-version'),
  getGeminiCapabilities: (workspace?: string) =>
    ipcRenderer.invoke('get-gemini-capabilities', workspace),
  getGeminiMcpBridgeStatus: () => ipcRenderer.invoke('get-gemini-mcp-bridge-status'),
  installGeminiMcpBridge: () => ipcRenderer.invoke('install-gemini-mcp-bridge'),
  setGeminiMcpBridgeEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-gemini-mcp-bridge-enabled', enabled),
  runApprovedHostCommand: (requestId: string) =>
    ipcRenderer.invoke('run-approved-host-command', requestId),
  listGeminiSessions: () => ipcRenderer.invoke('list-gemini-sessions'),
  getHostWeather: () => ipcRenderer.invoke('get-host-weather'),
  setAppearanceMode: (payload: { mode?: string; reduceTransparency?: boolean } | string) =>
    ipcRenderer.invoke('set-appearance-mode', payload),
  getNativeCapabilities: () =>
    ipcRenderer.invoke('native-capabilities:snapshot') as Promise<{
      platform: string
      arch: string
      osRelease: string
      macosVersion?: string
      bridge: { available: boolean; reason?: string }
      screenWatch: { available: boolean; reason?: string }
      appwatch: { available: boolean; reason?: string }
      ocr: { available: boolean; reason?: string }
      appleEvents: { available: boolean; reason?: string }
    }>,

  // Trust and PTY
  checkTrust: (workspacePath: string) => ipcRenderer.invoke('check-trust', workspacePath),
  // One-click persistent workspace trust — writes ~/.gemini/trustedFolders.json (#272).
  trustWorkspace: (workspacePath: string) => ipcRenderer.invoke('trust-workspace', workspacePath),

  // Phase J3: session-scoped YOLO mode (auto-allow every approval).
  // Never persisted — every process start defaults to disabled.
  agenticYoloGet: () =>
    ipcRenderer.invoke('agentic-yolo-get') as Promise<{
      enabled: boolean
      enabledAt: string | null
    }>,
  agenticYoloSet: (enabled: boolean) =>
    ipcRenderer.invoke('agentic-yolo-set', enabled) as Promise<{
      enabled: boolean
      enabledAt: string | null
    }>,
  onAgenticYoloState: (
    handler: (state: { enabled: boolean; enabledAt: string | null }) => void
  ) => {
    const wrapped = (_event: unknown, state: { enabled: boolean; enabledAt: string | null }) =>
      handler(state)
    ipcRenderer.on('agentic-yolo-state', wrapped)
    return () => ipcRenderer.removeListener('agentic-yolo-state', wrapped)
  },

  // TaskWraith Canvas renderer-pane (live-embed). The renderer opens an embedded
  // web canvas (a WebContentsView floated over its pane), streams the pane rect
  // via setBounds, and toggles visibility on occlusion. canvas-event is the same
  // audit-event broadcast the main process emits for every canvas action.
  canvas: {
    openWindow: (args: {
      url: string
      originAllowlist?: string[]
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-window', args),
    openEmbedded: (args: {
      url: string
      originAllowlist?: string[]
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-embedded', args),
    setBounds: (
      canvasId: string,
      rect: { x: number; y: number; width: number; height: number }
    ): Promise<void> => ipcRenderer.invoke('canvas:set-bounds', canvasId, rect),
    setVisible: (canvasId: string, visible: boolean): Promise<void> =>
      ipcRenderer.invoke('canvas:set-visible', canvasId, visible),
    close: (canvasId: string): Promise<void> => ipcRenderer.invoke('canvas:close', canvasId),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('canvas:list'),
    onEvent: (handler: (event: unknown) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => handler(payload)
      ipcRenderer.on('canvas-event', wrapped)
      return () => ipcRenderer.removeListener('canvas-event', wrapped)
    }
  },

  // QMOD (1.0.3) — `ask_user_question` MCP tool bridge. Main fires
  // `agent-question-requested` when an agent calls the tool; renderer
  // responds via `answer-agent-question` (with the user's pick) or
  // `cancel-agent-question` (user dismissed). Main also emits
  // `agent-question-cancelled` if the question times out or the run
  // gets cancelled — renderer uses that to dismiss the modal on its
  // side so we don't leave stale cards in the transcript.
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
  ) => {
    const wrapped = (_event: unknown, request: Parameters<typeof handler>[0]) => handler(request)
    ipcRenderer.on('agent-question-requested', wrapped)
    return () => ipcRenderer.removeListener('agent-question-requested', wrapped)
  },
  onAgentQuestionCancelled: (
    handler: (info: { questionId: string; appChatId: string; reason: string }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      info: { questionId: string; appChatId: string; reason: string }
    ) => handler(info)
    ipcRenderer.on('agent-question-cancelled', wrapped)
    return () => ipcRenderer.removeListener('agent-question-cancelled', wrapped)
  },
  answerAgentQuestion: (payload: {
    questionId: string
    answer: string
    isCustom?: boolean
    appChatId?: string
    appRunId?: string
    workspaceId?: string | null
  }) =>
    ipcRenderer.invoke('answer-agent-question', payload) as Promise<{
      ok: boolean
      error?: string
    }>,
  cancelAgentQuestion: (payload: {
    questionId: string
    reason?: string
    appChatId?: string
    appRunId?: string
    workspaceId?: string | null
  }) =>
    ipcRenderer.invoke('cancel-agent-question', payload) as Promise<{
      ok: boolean
      error?: string
    }>,

  // Phase K1: open external URLs / file paths from transcript markdown
  // clicks. Replaces the bare `<a href>` flow that would otherwise let
  // Electron navigate the BrowserWindow itself, unloading the bundled
  // renderer and blanking the app. Main validates the scheme and
  // routes to shell.openExternal (http/https/mailto) or shell.openPath
  // (filesystem paths); unknown / unsafe schemes are no-ops.
  openExternalOrPath: (href: string) =>
    ipcRenderer.invoke('shell:open-link', href) as Promise<{ ok: boolean; error?: string }>,
  revealPathInFinder: (path: string) =>
    ipcRenderer.invoke('shell:reveal-in-finder', path) as Promise<{ ok: boolean; error?: string }>,
  // Sha-addressed media-asset actions for generated (path-less) AV/image refs.
  // Main resolves the asset by content hash + mime into a real on-disk file,
  // then reveals / returns / save-as-copies it. Channels are LOCKED — a
  // parallel agent owns the main-side handlers.
  revealMediaAsset: (sha256: string, mimeType: string) =>
    ipcRenderer.invoke('media-asset:reveal', { sha256, mimeType }) as Promise<{ ok: boolean }>,
  getMediaAssetPath: (sha256: string, mimeType: string) =>
    ipcRenderer.invoke('media-asset:get-path', { sha256, mimeType }) as Promise<string | null>,
  saveMediaAssetAs: (sha256: string, mimeType: string, suggestedName: string) =>
    ipcRenderer.invoke('media-asset:save-as', { sha256, mimeType, suggestedName }) as Promise<{
      ok: boolean
      canceled: boolean
    }>,
  getFaviconForUrl: (url: string) =>
    ipcRenderer.invoke('favicon:getForUrl', url) as Promise<
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
    >,
  // 1.0.6-CRUX42 — open a Terminal already running the provider's interactive CLI
  // sign-in (Cursor / Grok). Main writes + opens a one-shot .command.
  openProviderLoginTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-login-terminal', provider) as Promise<{
      ok: boolean
      error?: string
    }>,
  openProviderLogoutTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-logout-terminal', provider) as Promise<{
      ok: boolean
      error?: string
    }>,
  openProviderUpgradeTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-upgrade-terminal', provider) as Promise<{
      ok: boolean
      error?: string
    }>,
  startPty: (workspacePath: string, sessionId: string = 'default') =>
    ipcRenderer.invoke('start-pty', workspacePath, sessionId),
  stopPty: (sessionId: string = 'default') => ipcRenderer.invoke('stop-pty', sessionId),
  ptyWrite: (data: string, sessionId: string = 'default') =>
    ipcRenderer.invoke('pty-write', data, sessionId),
  ptyResize: (cols: number, rows: number, sessionId: string = 'default') =>
    ipcRenderer.invoke('pty-resize', cols, rows, sessionId),
  startGeminiSession: (
    workspace: string,
    model: string = 'cli-default',
    approvalMode: string = 'default',
    sessionTrust: boolean = false,
    cols: number = 80,
    rows: number = 24,
    resumeSessionId: string | null = null,
    worktree: GeminiWorktreeLaunchOption = null
  ) =>
    ipcRenderer.invoke(
      'start-gemini-session',
      workspace,
      model,
      approvalMode,
      sessionTrust,
      cols,
      rows,
      resumeSessionId,
      worktree
    ),
  stopGeminiSession: () => ipcRenderer.invoke('stop-gemini-session'),
  writeGeminiSession: (data: string) => ipcRenderer.invoke('write-gemini-session', data),
  resizeGeminiSession: (cols: number, rows: number) =>
    ipcRenderer.invoke('resize-gemini-session', cols, rows),
  discoverGeminiCommands: (workspace: string) =>
    ipcRenderer.invoke('discover-gemini-commands', workspace),
  discoverGeminiMemory: (workspace: string) =>
    ipcRenderer.invoke('discover-gemini-memory', workspace),
  getFileIconDataUrl: (path: string) => ipcRenderer.invoke('get-file-icon', path),
  onPtyData: (callback: (data: string, sessionId?: string) => void) => {
    ipcRenderer.on('pty-data', (_event, data, sessionId) => callback(data, sessionId))
  },
  onPtyExit: (callback: (code: number | null, sessionId?: string) => void) => {
    ipcRenderer.on('pty-exit', (_event, code, sessionId) => callback(code, sessionId))
  },
  removePtyListeners: () => {
    ipcRenderer.removeAllListeners('pty-data')
    ipcRenderer.removeAllListeners('pty-exit')
  },
  onGeminiSessionData: (callback: (data: string) => void) => {
    ipcRenderer.on('gemini-session-data', (_event, data) => callback(data))
  },
  onGeminiSessionExit: (callback: (code: number | null) => void) => {
    ipcRenderer.on('gemini-session-exit', (_event, code) => callback(code))
  },
  removeGeminiSessionListeners: () => {
    ipcRenderer.removeAllListeners('gemini-session-data')
    ipcRenderer.removeAllListeners('gemini-session-exit')
  },

  // Bridge / iOS remote allowlist (Phase C4 admin surface)
  bridgeAllowlistList: () => ipcRenderer.invoke('bridge-allowlist-list'),
  bridgeAllowlistUpsert: (entry: {
    workspaceId: string
    path: string
    mode: 'read-only' | 'read-write'
    capabilities?: string[]
    allowedProviders: string[]
    allowedApprovalModes: string[]
    expiresAt?: number
  }) => ipcRenderer.invoke('bridge-allowlist-upsert', entry),
  bridgeAllowlistRemove: (workspaceId: string) =>
    ipcRenderer.invoke('bridge-allowlist-remove', workspaceId),
  bridgeAllowlistClear: () => ipcRenderer.invoke('bridge-allowlist-clear'),
  bridgeNetworkingStatus: () => ipcRenderer.invoke('bridge-networking-status'),
  setBridgeDaemonEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-bridge-daemon-enabled', enabled),
  getIosRemoteConfig: () => ipcRenderer.invoke('get-ios-remote-config'),
  setIosRemoteConfig: (config: {
    enabled?: boolean
    relayUrl?: string
    manualRelayUrl?: string
    openAtLogin?: boolean
  }) => ipcRenderer.invoke('set-ios-remote-config', config),
  iosRemoteTailscaleStatus: () => ipcRenderer.invoke('ios-remote-tailscale-status'),
  iosRemoteTailscaleEnable: () => ipcRenderer.invoke('ios-remote-tailscale-enable'),
  iosRemoteTailscaleTest: () => ipcRenderer.invoke('ios-remote-tailscale-test'),
  iosRemoteTailscaleDisable: () => ipcRenderer.invoke('ios-remote-tailscale-disable'),
  iosRemoteTailscaleLink: (authKey: string) =>
    ipcRenderer.invoke('ios-remote-tailscale-link', authKey),
  iosRemoteTailscaleOAuthSet: (input: { clientId: string; clientSecret: string }) =>
    ipcRenderer.invoke('ios-remote-tailscale-oauth-set', input),
  iosRemoteTailscaleOAuthClear: () => ipcRenderer.invoke('ios-remote-tailscale-oauth-clear'),
  iosRemoteTailscaleOAuthStatus: () => ipcRenderer.invoke('ios-remote-tailscale-oauth-status'),

  // Phase G2: auto-update controls.
  updateSnapshot: () => ipcRenderer.invoke('update-snapshot'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdateOnQuit: () => ipcRenderer.invoke('install-update-on-quit'),
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
  changelogSnapshot: () => ipcRenderer.invoke('changelog-snapshot'),
  markChangelogSeen: (version: string) => ipcRenderer.invoke('mark-changelog-seen', version),
  onUpdateStatusChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('update-status-changed', listener)
    return () => ipcRenderer.removeListener('update-status-changed', listener)
  },

  // Local Servers — dev servers/watchers running under the user's workspaces.
  localServersSnapshot: () => ipcRenderer.invoke('local-servers-snapshot'),
  localServersRefresh: () => ipcRenderer.invoke('local-servers-refresh'),
  localServersStop: (pid: number) => ipcRenderer.invoke('local-servers-stop', pid),
  localServersStopAll: () => ipcRenderer.invoke('local-servers-stop-all'),
  onLocalServersChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('local-servers-changed', listener)
    return () => ipcRenderer.removeListener('local-servers-changed', listener)
  },
  launchTargetsSnapshot: (workspacePath: string) =>
    ipcRenderer.invoke('launch-targets-snapshot', workspacePath),
  launchAttemptsSnapshot: () => ipcRenderer.invoke('launch-attempts-snapshot'),
  launchStart: (input: unknown) => ipcRenderer.invoke('launch-start', input),
  launchStop: (input: unknown) => ipcRenderer.invoke('launch-stop', input),
  onLaunchAttemptsChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('launch-attempts-changed', listener)
    return () => ipcRenderer.removeListener('launch-attempts-changed', listener)
  },
  bridgeFinalizePairing: (sessionID: string, userConfirmed: boolean) =>
    ipcRenderer.invoke('bridge-finalize-pairing', sessionID, userConfirmed),
  bridgeBeginPairing: (displayName?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('bridge-begin-pairing', displayName, options),
  bridgeListPairedDevices: () => ipcRenderer.invoke('bridge-list-paired-devices'),
  bridgeUnpairDevice: (iphoneIdentityPubKey: string) =>
    ipcRenderer.invoke('bridge-unpair-device', iphoneIdentityPubKey),

  // Attached-window picker. `pick` opens the macOS system picker via the
  // Swift bridge daemon and stores the resulting handle on the main side.
  // The AI never sees window enumeration — it can only act on a window
  // the user has explicitly picked.
  attachWindowPick: () =>
    ipcRenderer.invoke('attach-window:pick') as Promise<{
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
    }>,
  attachWindowDetach: () => ipcRenderer.invoke('attach-window:detach') as Promise<{ ok: boolean }>,
  attachWindowStatus: () =>
    ipcRenderer.invoke('attach-window:status') as Promise<{
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
    }>,
  // M11 (1.0.7) — sticky AppWatch per-chat attachment snapshots.
  stickyAppWatchGet: (chatId: string) =>
    ipcRenderer.invoke('sticky-appwatch:get', chatId) as Promise<{
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
    }>,
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
  }) => ipcRenderer.invoke('sticky-appwatch:stash', input) as Promise<{ ok: boolean }>,
  stickyAppWatchClear: (chatId: string) =>
    ipcRenderer.invoke('sticky-appwatch:clear', chatId) as Promise<{ ok: boolean }>,
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
  ) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) =>
      callback(snapshot as never)
    ipcRenderer.on('attached-window-changed', listener)
    return () => ipcRenderer.removeListener('attached-window-changed', listener)
  },

  // Phase E1: APNs production wiring. The renderer Settings panel uses
  // these to configure the iOS bridge push gateway. The decrypted .p8
  // PEM never crosses this boundary; only the encrypted blob lives in
  // settings, and the IPC handlers in main decrypt via safeStorage.
  getApnsConfig: () => ipcRenderer.invoke('get-apns-config'),
  selectApnsKeyFile: () => ipcRenderer.invoke('select-apns-key-file'),
  setApnsConfig: (input: {
    authKeyPath?: string
    keyId?: string
    teamId?: string
    bundleId?: string
  }) => ipcRenderer.invoke('set-apns-config', input),
  clearApnsConfig: () => ipcRenderer.invoke('clear-apns-config'),
  testApnsPush: () => ipcRenderer.invoke('test-apns-push'),
  onBridgePairingResponseReceived: (callback: (params: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, params: unknown) => callback(params)
    ipcRenderer.on('bridge-pairing-response-received', listener)
    return () => ipcRenderer.removeListener('bridge-pairing-response-received', listener)
  },

  // Store APIs
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (partial: any) => ipcRenderer.invoke('update-settings', partial),
  upsertAgenticWorkspaceGrant: (provider: ProviderId, workspacePath: string, service: string) =>
    ipcRenderer.invoke('upsert-agentic-workspace-grant', provider, workspacePath, service),
  removeAgenticWorkspaceGrant: (provider: ProviderId, workspacePath: string, service: string) =>
    ipcRenderer.invoke('remove-agentic-workspace-grant', provider, workspacePath, service),
  getRuntimeProfiles: (provider?: ProviderId) =>
    ipcRenderer.invoke('get-runtime-profiles', provider),
  saveRuntimeProfile: (profile: any) => ipcRenderer.invoke('save-runtime-profile', profile),
  deleteRuntimeProfile: (id: string) => ipcRenderer.invoke('delete-runtime-profile', id),
  getHandoffCards: (filter: any = {}) => ipcRenderer.invoke('get-handoff-cards', filter),
  saveHandoffCard: (card: any) => ipcRenderer.invoke('save-handoff-card', card),
  updateHandoffCard: (id: string, partial: any) =>
    ipcRenderer.invoke('update-handoff-card', id, partial),
  deleteHandoffCard: (id: string) => ipcRenderer.invoke('delete-handoff-card', id),
  getPluginCatalog: () =>
    ipcRenderer.invoke('plugins:get-catalog') as Promise<TaskWraithPluginCatalogSnapshot>,
  getPluginContributions: () =>
    ipcRenderer.invoke(
      'plugins:get-contributions'
    ) as Promise<TaskWraithPluginContributionSnapshot>,
  getPluginSecretStatus: () =>
    ipcRenderer.invoke('plugins:get-secret-status') as Promise<TaskWraithPluginSecretStatusSnapshot>,
  setPluginSecret: (pluginId: string, secretId: string, value: string) =>
    ipcRenderer.invoke(
      'plugins:set-secret',
      pluginId,
      secretId,
      value
    ) as Promise<TaskWraithPluginSecretMutationResult>,
  clearPluginSecret: (pluginId: string, secretId: string) =>
    ipcRenderer.invoke(
      'plugins:clear-secret',
      pluginId,
      secretId
    ) as Promise<TaskWraithPluginSecretMutationResult>,
  materializePluginMcpPreset: (pluginId: string, presetId: string) =>
    ipcRenderer.invoke(
      'plugins:materialize-mcp-preset',
      pluginId,
      presetId
    ) as Promise<TaskWraithPluginMcpPresetMaterializationResult>,
  installPlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:install', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke(
      'plugins:set-enabled',
      pluginId,
      enabled
    ) as Promise<TaskWraithPluginCatalogSnapshot>,
  updatePlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:update', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  uninstallPlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:uninstall', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addOrUpdateWorkspace: (path: string, partial: any = {}) =>
    ipcRenderer.invoke('add-or-update-workspace', path, partial),
  removeWorkspace: (id: string) => ipcRenderer.invoke('remove-workspace', id),
  clearWorkspaces: () => ipcRenderer.invoke('clear-workspaces'),
  getChats: (workspaceId?: string) => ipcRenderer.invoke('get-chats', workspaceId),
  getChatList: (workspaceId?: string) => ipcRenderer.invoke('get-chat-list', workspaceId),
  getPinnedMessages: (workspaceId?: string) =>
    ipcRenderer.invoke('get-pinned-messages', workspaceId),
  getChat: (chatId: string) => ipcRenderer.invoke('get-chat', chatId),
  createChat: (workspaceId: string, workspacePath: string) =>
    ipcRenderer.invoke('create-chat', workspaceId, workspacePath),
  createGlobalChat: () => ipcRenderer.invoke('create-global-chat'),
  createEnsembleChat: (args?: { workspaceId?: string; workspacePath?: string }) =>
    ipcRenderer.invoke('create-ensemble-chat', args),
  runEnsembleRound: (payload: {
    chatId: string
    prompt: string
    /** When dispatched by a SCHEDULED workflow occurrence, the task id rides
     * through so the main-side round-settle hook can mark the task terminal
     * (scheduled ensemble runs have no per-participant scheduledTaskId, so
     * without this they stay stuck 'running'). */
    scheduledTaskId?: string
    mode?: string
    concurrentMode?: boolean
    imageAttachments?: ComposerImageAttachment[]
    discordContextSnapshots?: DiscordContextSnapshot[]
    /** A2 (1.0.3) — DM routing: scope this "round" to a single
     * participant chip. The orchestrator's machinery still drives
     * the run (so status pills + per-participant tally still update)
     * but iterates a one-element participant list. */
    dmTargetParticipantId?: string
    /** 1.0.4-AT4 — composer-level external path grants applied to
     * every participant's effective permissions for the round.
     * Pre-AT4 these were dropped on the IPC boundary, so file-
     * mention grants the user added in the composer never reached
     * the participants. The orchestrator's
     * `resolveParticipantPermissions` provider-filters so each
     * participant only sees grants tagged for its own provider. */
    externalPathGrants?: Array<{
      provider: string
      path: string
      kind?: string
      grantedAt?: string
    }>
  }) => ipcRenderer.invoke('run-ensemble-round', payload),
  steerQueuedEnsemblePrompt: (payload: {
    chatId: string
    index: number
    textPrefix?: string
    concurrentMode?: boolean
  }) => ipcRenderer.invoke('steer-queued-ensemble-prompt', payload),
  removeQueuedEnsemblePrompt: (payload: { chatId: string; index: number; textPrefix?: string }) =>
    ipcRenderer.invoke('remove-queued-ensemble-prompt', payload),
  cancelEnsembleRound: (chatId: string) => ipcRenderer.invoke('cancel-ensemble-round', chatId),
  skipEnsembleParticipant: (chatId: string) =>
    ipcRenderer.invoke('skip-ensemble-participant', chatId),
  getLatestSessionCheckpoint: (chatId: string) =>
    ipcRenderer.invoke(
      'session-checkpoints:latest',
      chatId
    ) as Promise<SessionCheckpointRecord | null>,
  acceptSessionCheckpoint: (checkpointId: string) =>
    ipcRenderer.invoke('session-checkpoints:accept', checkpointId) as Promise<
      | { ok: true; checkpoint: SessionCheckpointRecord; resumePrompt: string }
      | { ok: false; error: string }
    >,
  dismissSessionCheckpoint: (checkpointId: string) =>
    ipcRenderer.invoke('session-checkpoints:dismiss', checkpointId) as Promise<
      { ok: true; checkpoint: SessionCheckpointRecord } | { ok: false; error: string }
    >,
  wakeEnsembleParticipantNow: (wakeupId: string) =>
    ipcRenderer.invoke('wake-ensemble-participant-now', wakeupId) as Promise<boolean>,
  cancelEnsembleParticipantWakeup: (wakeupId: string) =>
    ipcRenderer.invoke('cancel-ensemble-participant-wakeup', wakeupId) as Promise<{
      ok: boolean
      error?: string
    }>,
  createSubThread: (args: {
    parentChatId: string
    provider: string
    delegationPrompt: string
    returnResultToParent: boolean
    workspaceId?: string
    workspacePath?: string
  }) => ipcRenderer.invoke('create-sub-thread', args),
  getSubThreads: (parentChatId: string) => ipcRenderer.invoke('get-sub-threads', parentChatId),
  createSideChat: (args: {
    parentChatId: string
    chatKind?: 'single' | 'ensemble'
    provider?: string
    title?: string
    originMessageId?: string
    originRunId?: string
    sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut' | 'guestParticipant'
  }) => ipcRenderer.invoke('create-side-chat', args),
  getSideChats: (parentChatId: string) => ipcRenderer.invoke('get-side-chats', parentChatId),
  setGuestParticipant: (args: {
    parentChatId: string
    provider: string
    selectedModelType?: string
    customModel?: string
    codexReasoningEffort?: string | null
    codexServiceTier?: string | null
    claudeReasoningEffort?: string | null
    claudeFastMode?: boolean | null
    kimiThinkingEnabled?: boolean
  }) => ipcRenderer.invoke('set-guest-participant', args),
  removeGuestParticipant: (parentChatId: string) =>
    ipcRenderer.invoke('remove-guest-participant', parentChatId),
  listMessageChannelAdapters: () => ipcRenderer.invoke('message-channels:list-adapters'),
  listMessageChannelBindings: () => ipcRenderer.invoke('message-channels:list-bindings'),
  upsertMessageChannelBinding: (input: MessageChannelBindingInput) =>
    ipcRenderer.invoke('message-channels:upsert-binding', input),
  archiveMessageChannelBinding: (bindingId: string) =>
    ipcRenderer.invoke('message-channels:archive-binding', bindingId),
  sendMessageChannelTest: (bindingId: string) =>
    ipcRenderer.invoke('message-channels:send-test', bindingId),
  pollMessageChannelBinding: (bindingId: string) =>
    ipcRenderer.invoke('message-channels:poll-binding', bindingId),
  peekMessageChannelBinding: (bindingId: string) =>
    ipcRenderer.invoke('message-channels:peek-binding', bindingId) as Promise<
      MessagesBridgePollResult & { bindingId: string }
    >,
  getMessagesBridgeStatus: () => ipcRenderer.invoke('messages-bridge:status'),
  openMessagesPermissionHelper: () =>
    ipcRenderer.invoke('messages-bridge:open-permission-helper') as Promise<{
      ok: true
      appName: string
      dragTarget: string
    }>,
  startMessagesPermissionHelperDrag: () => {
    ipcRenderer.send('messages-bridge:start-permission-helper-drag')
  },
  revealMessagesPermissionHelperApp: () =>
    ipcRenderer.invoke('messages-bridge:reveal-permission-helper-app') as Promise<{
      ok: boolean
      error?: string
    }>,
  listMessagesBridgeConversations: (params: MessagesBridgeConversationsParams = {}) =>
    ipcRenderer.invoke('messages-bridge:list-conversations', params),
  pollMessageChannelsOnce: (params: MessagesBridgePollParams = {}) =>
    ipcRenderer.invoke('message-channels:poll-once', params),
  submitLocalWebChannelMessage: (input: LocalWebChannelSubmitInput) =>
    ipcRenderer.invoke('message-channels:submit-web-message', input),
  drainLocalWebChannelOutbox: (params: { accountId?: string; chatGuid?: string } = {}) =>
    ipcRenderer.invoke('message-channels:drain-web-outbox', params) as Promise<{
      ok: true
      messages: LocalWebChannelOutboundMessage[]
    }>,
  listMessageChannelCursors: () => ipcRenderer.invoke('message-channels:list-cursors'),
  clearMessageChannelCursors: () => ipcRenderer.invoke('message-channels:clear-cursors'),
  clearMessageChannelBindingCursor: (bindingId: string) =>
    ipcRenderer.invoke('message-channels:clear-binding-cursor', bindingId),
  listMessageChannelAudit: (limit?: number) =>
    ipcRenderer.invoke('message-channels:list-audit', limit),
  listDiscordContextTargets: () => ipcRenderer.invoke('discord-context:list-targets'),
  readDiscordContext: (selection: DiscordContextSelection) =>
    ipcRenderer.invoke('discord-context:read-channel', selection),
  humanCollaborationCreateShare: (input: {
    chatId: string
    mode?: 'readOnly' | 'comments'
    inviteTtlMs?: number
  }) => ipcRenderer.invoke('human-collaboration:create-share', input),
  humanCollaborationCopyInvite: (input: { invite: string }) =>
    ipcRenderer.invoke('human-collaboration:copy-invite', input),
  humanCollaborationListShares: (chatId?: string) =>
    ipcRenderer.invoke('human-collaboration:list-shares', chatId),
  humanCollaborationConnectedChatIds: () =>
    ipcRenderer.invoke('human-collaboration:connected-chat-ids'),
  humanCollaborationRevokeShare: (shareId: string) =>
    ipcRenderer.invoke('human-collaboration:revoke-share', shareId),
  humanCollaborationRevokeParticipant: (input: { shareId: string; collaboratorId: string }) =>
    ipcRenderer.invoke('human-collaboration:revoke-participant', input),
  humanCollaborationConsumeInvite: (input: {
    shareId: string
    inviteToken: string
    displayName: string
    publicKeyId: string
  }) => ipcRenderer.invoke('human-collaboration:consume-invite', input),
  humanCollaborationAppendComment: (input: {
    shareId: string
    chatId: string
    collaboratorId: string
    clientMessageId: string
    content: string
  }) => ipcRenderer.invoke('human-collaboration:append-comment', input),
  humanCollaborationProjection: (input: {
    shareId: string
    chatId: string
    collaboratorId: string
  }) => ipcRenderer.invoke('human-collaboration:projection', input),
  humanCollaborationRuntimeBeginAdmission: (input: {
    shareId: string
    chatId: string
    displayName: string
    inviteToken?: string
    collaboratorId?: string
    collaboratorIdentityPubKeyB64: string
    collaboratorEphemeralPubKeyB64: string
    collaboratorNonceB64: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:begin-admission', input),
  humanCollaborationRuntimeConfirmSas: (input: {
    handshakeId: string
    confirmCode: string
    collaboratorTranscriptSigB64: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:confirm-sas', input),
  humanCollaborationRuntimeSubscribeProjection: (input: { sessionId: string }) =>
    ipcRenderer.invoke('human-collaboration-runtime:subscribe-projection', input),
  humanCollaborationRuntimeAppendComment: (input: {
    sessionId: string
    clientMessageId: string
    content: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:append-comment', input),
  humanCollaborationRuntimeReceiveFrame: (input: {
    t: 'humanCollaboration.enc'
    protocol: string
    sessionId: string
    direction: 'hostToCollaborator' | 'collaboratorToHost'
    seq: number
    nonce: string
    ct: string
    tag: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:receive-frame', input),
  humanCollaborationRuntimeDisconnect: (input: { sessionId: string }) =>
    ipcRenderer.invoke('human-collaboration-runtime:disconnect', input),
  humanCollaborationPromoteComment: (input: { chatId: string; messageId: string }) =>
    ipcRenderer.invoke('human-collaboration:promote-comment', input),
  // Collaborator side (this instance joining someone else's shared chat).
  humanCollaborationCollaboratorJoin: (input: {
    shareId: string
    chatId: string
    inviteToken: string
    displayName: string
    mode: 'readOnly' | 'comments'
    relayUrl: string
    relayUrls?: string[]
    roomId: string
    hostIdentityPubKeyB64?: string
  }) => ipcRenderer.invoke('human-collaboration-collaborator:join', input),
  humanCollaborationCollaboratorConfirm: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:confirm'),
  humanCollaborationCollaboratorAppendComment: (input: {
    content: string
    clientMessageId?: string
  }) => ipcRenderer.invoke('human-collaboration-collaborator:append-comment', input),
  humanCollaborationCollaboratorLeave: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:leave'),
  saveChat: (chat: any) => ipcRenderer.invoke('save-chat', chat),
  deleteChat: (chatId: string) => ipcRenderer.invoke('delete-chat', chatId),
  reapAbandonedChats: (renderer: {
    protectedChatIds?: string[]
    draftChatIds?: string[]
    keepChatId?: string
  }) => ipcRenderer.invoke('reap-abandoned-chats', renderer),
  /** Slash-picker `/clear` — wipes the chat's messages + runs while
   * leaving the record (and its provider session id) intact. */
  truncateChat: (chatId: string) => ipcRenderer.invoke('truncate-chat', chatId),
  clearChats: (workspaceId?: string) => ipcRenderer.invoke('clear-chats', workspaceId),
  recordUsage: (usage: any) => ipcRenderer.invoke('record-usage', usage),
  getUsage: (workspaceId?: string, chatId?: string) =>
    ipcRenderer.invoke('get-usage', workspaceId, chatId),
  getWorkspaceActivity: (workspacePath: string, dayCount?: number) =>
    ipcRenderer.invoke(
      'get-workspace-activity',
      workspacePath,
      dayCount
    ) as Promise<WorkspaceActivitySnapshot>,
  getScheduledTasks: (workspaceId?: string) =>
    ipcRenderer.invoke('get-scheduled-tasks', workspaceId),
  // Push the renderer's roster-preset list to main so the bridge can project
  // it to paired iOS devices (the renderer's localStorage is the source of truth).
  syncEnsembleRosterPresets: (presets: unknown[]) =>
    ipcRenderer.invoke('ensemble-roster-presets:sync', presets),
  saveScheduledTask: (task: any) => ipcRenderer.invoke('save-scheduled-task', task),
  updateScheduledTask: (id: string, partial: any) =>
    ipcRenderer.invoke('update-scheduled-task', id, partial),
  deleteScheduledTask: (id: string) => ipcRenderer.invoke('delete-scheduled-task', id),
  getWorkflowDefinitions: (workspaceId?: string) =>
    ipcRenderer.invoke('get-workflow-definitions', workspaceId),
  saveWorkflowDefinition: (workflow: any) =>
    ipcRenderer.invoke('save-workflow-definition', workflow),
  updateWorkflowDefinition: (id: string, partial: any) =>
    ipcRenderer.invoke('update-workflow-definition', id, partial),
  deleteWorkflowDefinition: (id: string) => ipcRenderer.invoke('delete-workflow-definition', id),
  getWorkspaceBoards: (workspaceId?: string) =>
    ipcRenderer.invoke('get-workspace-boards', workspaceId) as Promise<WorkspaceBoardDefinition[]>,
  saveWorkspaceBoard: (board: any) =>
    ipcRenderer.invoke('save-workspace-board', board) as Promise<WorkspaceBoardDefinition>,
  updateWorkspaceBoard: (id: string, partial: any) =>
    ipcRenderer.invoke(
      'update-workspace-board',
      id,
      partial
    ) as Promise<WorkspaceBoardDefinition | null>,
  deleteWorkspaceBoard: (id: string) => ipcRenderer.invoke('delete-workspace-board', id),
  getWorkspaceBoardCards: (boardId?: string) =>
    ipcRenderer.invoke('get-workspace-board-cards', boardId) as Promise<WorkspaceBoardCard[]>,
  saveWorkspaceBoardCard: (card: any) =>
    ipcRenderer.invoke('save-workspace-board-card', card) as Promise<WorkspaceBoardCard>,
  updateWorkspaceBoardCard: (id: string, partial: any) =>
    ipcRenderer.invoke(
      'update-workspace-board-card',
      id,
      partial
    ) as Promise<WorkspaceBoardCard | null>,
  deleteWorkspaceBoardCard: (id: string) => ipcRenderer.invoke('delete-workspace-board-card', id),
  runWorkflowNow: (id: string) => ipcRenderer.invoke('run-workflow-now', id),
  setWorkflowUnattendedElevation: (id: string, level: string) =>
    ipcRenderer.invoke('set-workflow-unattended-elevation', id, level),
  getWorkflowRunSummaries: (workflowId?: string) =>
    ipcRenderer.invoke('get-workflow-run-summaries', workflowId),
  getWorkflowRunEvents: (filter: any = {}) => ipcRenderer.invoke('get-workflow-run-events', filter),
  // Audit-run orchestration. startAuditRun resolves with the terminal record;
  // live phase/finding updates arrive via onAuditRunChanged ('audit-run-changed').
  startAuditRun: (input: {
    mode?: string
    chatId: string
    preferredProvider?: ProviderId
    workspacePath: string
    workspaceId?: string
  }) => ipcRenderer.invoke('audit-run:start', input),
  cancelAuditRun: (auditRunId: string) => ipcRenderer.invoke('audit-run:cancel', auditRunId),
  getAuditRun: (auditRunId: string) => ipcRenderer.invoke('get-audit-run', auditRunId),
  getAuditRuns: (workspaceId?: string) => ipcRenderer.invoke('get-audit-runs', workspaceId),
  getRunQueueJobs: (filter: any = {}) => ipcRenderer.invoke('get-run-queue-jobs', filter),
  requestRunQueueJob: (job: any) => ipcRenderer.invoke('request-run-queue-job', job),
  leaseRunQueueJob: (request: any = {}) => ipcRenderer.invoke('lease-run-queue-job', request),
  promoteQueuedJobForSteer: (
    input: PromoteQueuedJobForSteerInput
  ): Promise<PromoteQueuedJobForSteerResult> =>
    ipcRenderer.invoke('promote-queued-job-for-steer', input),
  leasePromotedSteerJob: (input: LeasePromotedSteerInput): Promise<LeasePromotedSteerJobResult> =>
    ipcRenderer.invoke('lease-promoted-steer-job', input),
  fallbackPromotedSteerJob: (
    input: FallbackPromotedSteerInput
  ): Promise<FallbackPromotedSteerJobResult> =>
    ipcRenderer.invoke('fallback-promoted-steer-job', input),
  transitionRunQueueJob: (runIdOrId: string, status: string, partial: any = {}) =>
    ipcRenderer.invoke('transition-run-queue-job', runIdOrId, status, partial),
  getRunRecoveryRecords: (filter: any = {}) =>
    ipcRenderer.invoke('get-run-recovery-records', filter),
  getRunEvents: (filter: any = {}) => ipcRenderer.invoke('get-run-events', filter),
  getRunEventReplay: (runId: string) => ipcRenderer.invoke('get-run-event-replay', runId),
  analyzeRun: (request: RunAnalystRequest) =>
    ipcRenderer.invoke('run-analyst:analyze', request) as Promise<RunAnalystSnapshot>,
  getApprovalLedger: (filter: any = {}) => ipcRenderer.invoke('get-approval-ledger', filter),
  recordApprovalElevationAck: (input: {
    provider: string
    workspacePath: string | null
    toMode: string
    tier: number
  }) => ipcRenderer.invoke('record-approval-elevation-ack', input),
  getProductOperationsStatus: () => ipcRenderer.invoke('get-product-operations-status'),
  getProductCrashes: (filter: any = {}) => ipcRenderer.invoke('get-product-crashes', filter),
  recordProductCrash: (input: any) => ipcRenderer.invoke('record-product-crash', input),
  exportProductDiagnostics: (path?: string) =>
    ipcRenderer.invoke('export-product-diagnostics', path),
  repairProductInstall: () => ipcRenderer.invoke('repair-product-install'),
  getAppShellStats: () =>
    ipcRenderer.invoke('app-shell-stats:snapshot') as Promise<AppShellStatsSnapshot>,
  // Tester-feedback intake (1.0.1). `getAppVersion` lets the bug-report
  // sheet show the same version string that `submit-bug-report` stamps
  // into the file. `submitBugReport` ships the form contents + an
  // auto-captured context block; main appends a Markdown entry to
  // `<userData>/TaskWraith/bug-reports.md`.
  getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
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
  }) =>
    ipcRenderer.invoke('submit-bug-report', payload) as Promise<{
      ok: boolean
      path?: string
      error?: string
    }>,

  onGeminiOutput: (callback: (data: any) => void) => {
    ipcRenderer.on('gemini-output', (_event, data) => callback(data))
  },
  onGeminiError: (callback: (error: any) => void) => {
    ipcRenderer.on('gemini-error', (_event, error) => callback(error))
  },
  onGeminiExit: (callback: (code: any) => void) => {
    ipcRenderer.on('gemini-exit', (_event, code) => callback(code))
  },
  onAgentOutput: (callback: (payload: any) => void) => {
    ipcRenderer.on('agent-output', (_event, payload) => callback(payload))
  },
  onAgentError: (callback: (payload: any) => void) => {
    ipcRenderer.on('agent-error', (_event, payload) => callback(payload))
  },
  onAgentExit: (callback: (payload: any) => void) => {
    ipcRenderer.on('agent-exit', (_event, payload) => callback(payload))
  },
  onRunQueueChanged: (callback: (jobs: any[]) => void) => {
    ipcRenderer.on('run-queue-changed', (_event, jobs) => callback(jobs))
  },
  onRunEventsChanged: (callback: (payload: any) => void) => {
    ipcRenderer.on('run-events-changed', (_event, payload) => callback(payload))
  },
  onAgentApprovalRequest: (callback: (payload: any) => void) => {
    ipcRenderer.on('agent-approval-request', (_event, payload) => callback(payload))
  },
  onAgentApprovalTimeout: (
    callback: (payload: { approvalId: string; appliedMs: number; source: string }) => void
  ) => {
    ipcRenderer.on('agent-approval-timeout', (_event, payload) => callback(payload))
  },
  onAgentApprovalResolved: (
    callback: (payload: {
      approvalId: string
      action?: string
      decisionSource?: string
      provider?: string
      threadId?: string
    }) => void
  ) => {
    ipcRenderer.on('agent-approval-resolved', (_event, payload) => callback(payload))
  },
  onScheduledTaskDue: (callback: (payload: any) => void) => {
    ipcRenderer.on('scheduled-task-due', (_event, payload) => callback(payload))
  },
  onScheduledTasksChanged: (callback: (payload: any) => void) => {
    ipcRenderer.on('scheduled-tasks-changed', (_event, payload) => callback(payload))
  },
  onWorkflowDefinitionsChanged: (callback: (payload: any) => void) => {
    ipcRenderer.on('workflow-definitions-changed', (_event, payload) => callback(payload))
  },
  onWorkspaceBoardsChanged: (
    callback: (payload: { boards: WorkspaceBoardDefinition[]; cards: WorkspaceBoardCard[] }) => void
  ) => {
    ipcRenderer.on('workspace-boards-changed', (_event, payload) => callback(payload))
  },
  // iOS-triggered roster-preset writes round-tripped back to the renderer (the
  // localStorage source of truth). The renderer persists, which re-syncs the
  // projected list back to the bridge.
  onEnsembleRosterPresetSaveRequested: (
    callback: (payload: { name: string; participants: unknown[] }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { name: string; participants: unknown[] }): void =>
      callback(payload)
    ipcRenderer.on('ensemble-roster-presets:save-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-roster-presets:save-requested', wrapped)
  },
  onEnsembleRosterPresetDeleteRequested: (callback: (presetId: string) => void) => {
    const wrapped = (_event: unknown, presetId: string): void => callback(presetId)
    ipcRenderer.on('ensemble-roster-presets:delete-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-roster-presets:delete-requested', wrapped)
  },
  onAuditRunChanged: (callback: (run: any) => void) => {
    const wrapped = (_event: unknown, run: unknown): void => callback(run)
    ipcRenderer.on('audit-run-changed', wrapped)
    return () => ipcRenderer.removeListener('audit-run-changed', wrapped)
  },
  onUsageChanged: (callback: () => void) => {
    ipcRenderer.on('usage-changed', () => callback())
  },
  onChatUpdated: (callback: (chat: unknown) => void) => {
    const wrapped = (_event: unknown, chat: unknown): void => callback(chat)
    ipcRenderer.on('chat-updated', wrapped)
    return () => ipcRenderer.removeListener('chat-updated', wrapped)
  },
  onHumanCollaborationUpdated: (callback: (payload: { chatId: string }) => void) => {
    const wrapped = (_event: unknown, payload: { chatId: string }): void => callback(payload)
    ipcRenderer.on('human-collaboration-updated', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-updated', wrapped)
  },
  onHumanCollaborationRuntimeProjectionUpdate: (
    callback: (payload: { sessionId: string; projection: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { sessionId: string; projection: unknown }): void =>
      callback(payload)
    ipcRenderer.on('human-collaboration-runtime-projection-update', wrapped)
    return () =>
      ipcRenderer.removeListener('human-collaboration-runtime-projection-update', wrapped)
  },
  onHumanCollaborationRuntimeEncryptedFrame: (
    callback: (payload: { sessionId: string; frame: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { sessionId: string; frame: unknown }): void =>
      callback(payload)
    ipcRenderer.on('human-collaboration-runtime-encrypted-frame', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-runtime-encrypted-frame', wrapped)
  },
  // Host side: a collaborator began admission — surface the 6-digit SAS to compare.
  onHumanCollaborationAdmissionBegan: (
    callback: (payload: {
      handshakeId: string
      chatId: string
      shareId: string
      displayName: string
      confirmCode: string
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        handshakeId: string
        chatId: string
        shareId: string
        displayName: string
        confirmCode: string
      }
    ): void => callback(payload)
    ipcRenderer.on('human-collaboration-admission-began', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-admission-began', wrapped)
  },
  // Collaborator side: live projection updates for the joined shared chat.
  onHumanCollaborationCollaboratorProjection: (
    callback: (payload: { projection: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { projection: unknown }): void => callback(payload)
    ipcRenderer.on('human-collaboration-collaborator-projection', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-collaborator-projection', wrapped)
  },
  // Collaborator side: connection/error status for the active join.
  onHumanCollaborationCollaboratorStatus: (
    callback: (payload: { connected?: boolean; error?: string }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { connected?: boolean; error?: string }): void =>
      callback(payload)
    ipcRenderer.on('human-collaboration-collaborator-status', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-collaborator-status', wrapped)
  },
  // Trusted audio/video media refs for a foreground solo run. Main constructs
  // these refs itself and pushes them on this dedicated main-only channel, so
  // the renderer attaches them WITHOUT the image-only RAW-provider sanitizer
  // (a provider's stdout cannot forge this IPC). See applyAssistantMediaRefsToChat.
  onRunTrustedMediaRefs: (
    callback: (payload: { appChatId: string; appRunId: string; mediaRefs: unknown[] }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { appChatId: string; appRunId: string; mediaRefs: unknown[] }
    ): void => callback(payload)
    ipcRenderer.on('run-trusted-media-refs', wrapped)
    return () => ipcRenderer.removeListener('run-trusted-media-refs', wrapped)
  },
  onAppShellStatsChanged: (callback: (snapshot: AppShellStatsSnapshot) => void) => {
    const wrapped = (_event: unknown, snapshot: AppShellStatsSnapshot): void => callback(snapshot)
    ipcRenderer.on('app-shell-stats-changed', wrapped)
    return () => ipcRenderer.removeListener('app-shell-stats-changed', wrapped)
  },
  // 1.0.5-PO2 — Workspace popout live-refresh signal. Main process
  // emits when something in the popout's workspace has changed
  // (chat update, run progress, etc.). The popout debounces a
  // re-fetch on its end. Returns an unsubscribe function so the
  // popout can clean up on unmount.
  onWorkspacePopoutRefresh: (
    callback: (payload: { workspacePath: string; reason: string }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { workspacePath: string; reason: string }): void =>
      callback(payload)
    ipcRenderer.on('workspace-popout-refresh', wrapped)
    return () => ipcRenderer.removeListener('workspace-popout-refresh', wrapped)
  },
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
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
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
      }
    ): void => callback(payload)
    ipcRenderer.on('side-chat:dock-request', wrapped)
    return () => ipcRenderer.removeListener('side-chat:dock-request', wrapped)
  },
  // Phase K3 — creative-app approval flow. Main process broadcasts
  // pending requests; renderer modal renders + collects decision.
  onCreativeActionRequest: (callback: (payload: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('creative-action:request', wrapped)
    return () => ipcRenderer.removeListener('creative-action:request', wrapped)
  },
  decideCreativeAction: (
    requestId: string,
    approved: boolean,
    rememberForSession: boolean
  ): void => {
    ipcRenderer.send('creative-action:decide', { requestId, approved, rememberForSession })
  },
  removeListeners: () => {
    ipcRenderer.removeAllListeners('gemini-output')
    ipcRenderer.removeAllListeners('gemini-error')
    ipcRenderer.removeAllListeners('gemini-exit')
    ipcRenderer.removeAllListeners('agent-output')
    ipcRenderer.removeAllListeners('agent-error')
    ipcRenderer.removeAllListeners('agent-exit')
    ipcRenderer.removeAllListeners('run-queue-changed')
    ipcRenderer.removeAllListeners('run-events-changed')
    ipcRenderer.removeAllListeners('agent-approval-request')
    ipcRenderer.removeAllListeners('agent-approval-timeout')
    ipcRenderer.removeAllListeners('agent-approval-resolved')
    ipcRenderer.removeAllListeners('spellcheck:context-menu')
    ipcRenderer.removeAllListeners('update-status-changed')
    ipcRenderer.removeAllListeners('scheduled-task-due')
    ipcRenderer.removeAllListeners('scheduled-tasks-changed')
    ipcRenderer.removeAllListeners('workflow-definitions-changed')
    ipcRenderer.removeAllListeners('workspace-boards-changed')
    ipcRenderer.removeAllListeners('audit-run-changed')
    ipcRenderer.removeAllListeners('usage-changed')
    ipcRenderer.removeAllListeners('chat-updated')
    ipcRenderer.removeAllListeners('human-collaboration-updated')
    ipcRenderer.removeAllListeners('human-collaboration-runtime-projection-update')
    ipcRenderer.removeAllListeners('human-collaboration-runtime-encrypted-frame')
    ipcRenderer.removeAllListeners('human-collaboration-admission-began')
    ipcRenderer.removeAllListeners('human-collaboration-collaborator-projection')
    ipcRenderer.removeAllListeners('human-collaboration-collaborator-status')
    ipcRenderer.removeAllListeners('run-trusted-media-refs')
    ipcRenderer.removeAllListeners('app-shell-stats-changed')
    ipcRenderer.removeAllListeners('workspace-popout-refresh')
    ipcRenderer.removeAllListeners('side-chat:dock-request')
    ipcRenderer.removeAllListeners('creative-action:request')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
