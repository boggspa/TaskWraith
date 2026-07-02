import type {
  ChatRecord,
  ChatRun,
  ProviderId,
  RunQueueJob,
  ScheduledTask,
  RuntimeProfile
} from '../../../main/store/types'

export interface RunLane {
  id: string
  runId?: string
  scheduledTaskId?: string
  provider: ProviderId
  phase: 'active' | 'queued' | 'paused' | 'scheduled' | 'completed' | 'failed' | 'cancelled'
  status: string
  source: string
  chatId?: string
  chatTitle?: string
  workspaceId?: string
  workspacePath?: string
  runtimeProfileId?: string
  runtimeProfileName?: string
  handoffSourceRunId?: string
  promptPreview?: string
  blockedReason?: string
  conflictSummary?: string
  touchedFiles: string[]
  updatedAt?: string
}

export interface CockpitRunSource {
  chat: ChatRecord | null
  run: ChatRun | null
  prompt: string
}

const getChatProvider = (chat?: ChatRecord | null): ProviderId => chat?.provider || 'gemini'

const getRuntimeProfileLabel = (profiles: RuntimeProfile[], id?: string): string | undefined =>
  id ? profiles.find((profile) => profile.id === id)?.name || id : undefined

export const compactPromptPreview = (value?: string): string => {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 140 ? `${text.slice(0, 140)}...` : text
}

const laneUpdatedAt = (lane: Pick<RunLane, 'updatedAt'>): number => {
  const time = lane.updatedAt ? new Date(lane.updatedAt).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

export const extractRunTouchedFiles = (run: ChatRun): string[] => {
  const runDiff = run.runDiff as any
  const files: string[] = []
  for (const key of ['createdFiles', 'modifiedFiles', 'deletedFiles']) {
    const list = Array.isArray(runDiff?.[key]) ? runDiff[key] : []
    for (const item of list) {
      if (typeof item === 'string') files.push(item)
      if (item && typeof item.path === 'string') files.push(item.path)
    }
  }
  return [...new Set(files)]
}

export const resolveCockpitRunSource = (
  lane: RunLane,
  chats: ChatRecord[],
  chatById?: ReadonlyMap<string, ChatRecord>
): CockpitRunSource => {
  const chat = lane.chatId
    ? chatById?.get(lane.chatId) || chats.find((item) => item.appChatId === lane.chatId) || null
    : null
  const run = chat?.runs?.find((item) => item.runId === lane.runId) || null
  const prompt = run
    ? chat?.messages.find(
        (message) =>
          message.id === run.promptMessageId && message.metadata?.kind !== 'channelInbound'
      )?.content ||
      [...(chat?.messages || [])]
        .reverse()
        .find((message) => message.role === 'user' && message.metadata?.kind !== 'channelInbound')
        ?.content ||
      lane.promptPreview ||
      ''
    : lane.promptPreview || ''
  return { chat, run, prompt }
}

const runLanePhaseFromStatus = (status: string): RunLane['phase'] => {
  if (status === 'queued' || status === 'starting') return 'queued'
  if (
    status === 'active' ||
    status === 'running' ||
    status === 'promoting' ||
    status === 'steer_promoting'
  )
    return 'active'
  if (status === 'paused') return 'paused'
  if (status === 'cancelled' || status === 'cancelling') return 'cancelled'
  if (status === 'failed') return 'failed'
  return 'completed'
}

export const buildRunLanes = (
  jobs: RunQueueJob[],
  chats: ChatRecord[],
  scheduledTasks: ScheduledTask[],
  runtimeProfiles: RuntimeProfile[]
): RunLane[] => {
  const chatMap = new Map(chats.map((chat) => [chat.appChatId, chat]))
  const lanes: RunLane[] = []
  const seenRunIds = new Set<string>()

  for (const job of jobs) {
    const chat = job.chatId ? chatMap.get(job.chatId) : undefined
    const request = job.request
    const runtimeProfileId = job.runtimeProfileId || request?.runtimeProfileId
    seenRunIds.add(job.runId)
    lanes.push({
      id: `job:${job.runId}`,
      runId: job.runId,
      provider: job.provider,
      phase: runLanePhaseFromStatus(job.status),
      status: job.status,
      source: job.source,
      chatId: job.chatId,
      chatTitle: chat?.title,
      workspaceId: job.workspaceId,
      workspacePath: job.workspacePath,
      runtimeProfileId,
      runtimeProfileName: getRuntimeProfileLabel(runtimeProfiles, runtimeProfileId),
      handoffSourceRunId: job.handoffSourceRunId || request?.handoffSourceRunId,
      promptPreview: compactPromptPreview(
        job.promptPreview || request?.displayPrompt || request?.prompt
      ),
      blockedReason:
        job.status === 'queued'
          ? job.statusReason || 'Waiting for this chat to finish its active run.'
          : job.statusReason,
      touchedFiles: [],
      updatedAt: job.updatedAt
    })
  }

  for (const task of scheduledTasks) {
    if (task.status !== 'pending' && task.status !== 'due' && task.status !== 'running') continue
    const chat = chatMap.get(task.chatId)
    lanes.push({
      id: `task:${task.id}`,
      runId: task.runId,
      scheduledTaskId: task.id,
      provider: task.provider,
      phase: 'scheduled',
      status: task.status,
      source: 'scheduled',
      chatId: task.chatId,
      chatTitle: chat?.title,
      workspaceId: task.workspaceId,
      workspacePath: task.workspacePath,
      runtimeProfileId: task.runtimeProfileId,
      runtimeProfileName: getRuntimeProfileLabel(runtimeProfiles, task.runtimeProfileId),
      handoffSourceRunId: task.handoffSourceRunId,
      promptPreview: compactPromptPreview(task.displayPrompt || task.prompt),
      blockedReason:
        task.status === 'due'
          ? 'Due and waiting for this chat to become idle.'
          : `Scheduled for ${new Date(task.runAt).toLocaleString()}`,
      touchedFiles: [],
      updatedAt: task.updatedAt
    })
  }

  for (const chat of chats) {
    for (const run of chat.runs || []) {
      if (seenRunIds.has(run.runId)) continue
      const provider = run.provider || getChatProvider(chat)
      const phase =
        run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'completed'
      lanes.push({
        id: `run:${run.runId}`,
        runId: run.runId,
        provider,
        phase,
        status: run.status || 'completed',
        source: 'history',
        chatId: chat.appChatId,
        chatTitle: chat.title,
        workspaceId: chat.workspaceId,
        workspacePath: run.effectiveWorkspacePath || chat.workspacePath,
        runtimeProfileId: run.runtimeProfileId,
        runtimeProfileName: getRuntimeProfileLabel(runtimeProfiles, run.runtimeProfileId),
        handoffSourceRunId: run.handoffSourceRunId,
        promptPreview: compactPromptPreview(
          chat.messages.find(
            (message) =>
              message.id === run.promptMessageId && message.metadata?.kind !== 'channelInbound'
          )?.content
        ),
        touchedFiles: extractRunTouchedFiles(run),
        updatedAt: run.endedAt || run.startedAt
      })
    }
  }

  const supervised = lanes.map((lane) => ({ ...lane }))
  const livePhases = new Set<RunLane['phase']>(['active', 'queued', 'paused', 'scheduled'])
  for (const lane of supervised) {
    if (!lane.workspacePath || !livePhases.has(lane.phase)) continue
    const peers = supervised.filter(
      (peer) =>
        peer.id !== lane.id &&
        peer.workspacePath === lane.workspacePath &&
        livePhases.has(peer.phase)
    )
    if (peers.length === 0) continue
    const laneFiles = new Set(lane.touchedFiles)
    const overlappingFiles = peers.flatMap((peer) =>
      peer.touchedFiles.filter((file) => laneFiles.has(file))
    )
    lane.conflictSummary =
      overlappingFiles.length > 0
        ? `Potential file overlap: ${[...new Set(overlappingFiles)].slice(0, 3).join(', ')}`
        : `Shares workspace with ${peers.length} other live lane${peers.length === 1 ? '' : 's'}.`
  }

  return supervised
    .sort((a, b) => {
      const phaseRank: Record<RunLane['phase'], number> = {
        active: 0,
        queued: 1,
        paused: 2,
        scheduled: 3,
        failed: 4,
        cancelled: 5,
        completed: 6
      }
      return phaseRank[a.phase] - phaseRank[b.phase] || laneUpdatedAt(b) - laneUpdatedAt(a)
    })
    .slice(0, 80)
}
