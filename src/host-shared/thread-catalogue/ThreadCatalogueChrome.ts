import type { TaskWraithControlThreadFacts } from '../../shared/taskWraithControlProjection'
import { CHAT_COMPOSER_SELECTION_METADATA_KEYS } from '../../shared/chatComposerSelectionKeys'
import type { ThreadCatalogueChrome, ThreadCatalogueRun } from '../../shared/threadCatalogueTypes'
export type { ThreadCatalogueChrome, ThreadCatalogueRun } from '../../shared/threadCatalogueTypes'
type Shape =
  | 'scalar'
  | number
  | { text: number; truncate: boolean }
  | { fields: Readonly<Record<string, Shape>> }
  | { items: Shape; maximum: number }
const fields = (value: Readonly<Record<string, Shape>>): Shape => ({ fields: value })
const exactText = (maximum: number): Shape => ({ text: maximum, truncate: false })
const scalars = (keys: readonly string[], maximum = 512): Record<string, Shape> =>
  Object.fromEntries(keys.map((key) => [key, maximum]))

export const THREAD_CATALOGUE_RUN_FIELDS = fields({
  ...scalars([
    'runId',
    'provider',
    'providerRunId',
    'providerThreadId',
    'startedAt',
    'endedAt',
    'requestedModel',
    'actualModel',
    'approvalMode',
    'workflowMode',
    'status',
    'phase',
    'errorCode',
    'providerSessionId',
    'runtimeProfileId',
    'geminiAuthProfileId',
    'ensembleRoundId',
    'ensembleParticipantId',
    'ensembleLaneId',
    'ensembleRole',
    'ensembleStageRole',
    'activeGoalId'
  ]),
  warningSummaries: { maximum: 16, items: 300 },
  cancelled: 'scalar',
  exitCode: 'scalar',
  ensembleOrder: 'scalar',
  suppressRunSummary: 'scalar',
  usage: fields(
    Object.fromEntries(
      [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'estimatedCostUsd'
      ].map((key) => [key, 'scalar'])
    )
  )
})

const CHROME_FIELDS = fields({
  pinned: 'scalar',
  hiddenFromMainList: 'scalar',
  workflowMode: 32,
  linkedProviderSessionId: 512,
  linkedGeminiSessionId: 512,
  providerMetadata: fields(scalars(CHAT_COMPOSER_SELECTION_METADATA_KEYS, 4096)),
  threadTitle: fields(
    scalars(['source', 'sourceMessageId', 'sourceFingerprint', 'evidenceFingerprint'])
  ),
  gitWorkflow: fields({
    ...scalars(['state', 'prUrl'], 2048),
    updatedAt: 'scalar',
    prNumber: 'scalar'
  }),
  watchedPr: fields({
    ...scalars(['chatId', 'workspacePath', 'owner', 'repo'], 4096),
    prNumber: 'scalar'
  }),
  agentIdentity: fields(scalars(['name', 'accent', 'slug'], 128)),
  sideChatContext: fields({
    ...Object.fromEntries(
      [
        'createdAt',
        'openedAt',
        'closedAt',
        'terminatedAt',
        'returnResultToParent',
        'returnResultEnabledAt',
        'resultReturnedAt'
      ].map((key) => [key, 'scalar' as const])
    ),
    ...scalars(
      [
        'mode',
        'lifecycleState',
        'terminationReason',
        'lastReturnedMessageId',
        'originMessageId',
        'originRunId',
        'originChatId',
        'transcriptVisibility'
      ],
      512
    )
  }),
  delegationContext: fields({
    createdAt: 'scalar',
    returnResultToParent: 'scalar',
    resultReturnedAt: 'scalar',
    workerControl: fields({ schemaVersion: 'scalar', attachedAt: 64 }),
    dispatchError: fields({ at: 'scalar', message: 1024 }),
    ...scalars(
      [
        'parentProvider',
        'parentAppRunId',
        'lifecycle',
        'spawnedBy',
        'role',
        'label',
        'parentEnsembleParticipantId',
        'parentEnsembleRole',
        'selectedParticipantId',
        'selectedParticipantRole'
      ],
      512
    )
  }),
  activeGoal: fields({
    ...scalars(
      [
        'id',
        'goalId',
        'objective',
        'objectiveSource',
        'createdAt',
        'updatedAt',
        'blockedAt',
        'blockedReason',
        'completedSummary',
        'lastStatusReason',
        'status',
        'mode',
        'provider',
        'startedAt',
        'completedAt',
        'pausedAt',
        'failedAt',
        'stopReason'
      ],
      1024
    ),
    specification: fields({
      ...scalars(['kind', 'sourceMessageId', 'intendedPlanId'], 512),
      acceptanceCriteria: { maximum: 16, items: 512 }
    }),
    runtimeLedger: fields({
      ...scalars(['startedAt', 'endedAt', 'endStatus'], 64),
      intervals: { maximum: 128, items: fields(scalars(['status', 'startedAt', 'endedAt'], 64)) }
    }),
    tokenBudget: 'scalar',
    tokensUsed: 'scalar',
    elapsedMs: 'scalar'
  }),
  // This block must carry every key in ENSEMBLE_PANEL_CONFIGURATION_KEYS and
  // ENSEMBLE_SEAT_CONFIGURATION_KEYS (shared/ensembleAuthoredSlice): paged
  // opens render the lean row built from this projection, so a missing shape
  // presents as a lost edit. ThreadCatalogueEnsembleContract.test.ts pins it.
  ensemble: fields({
    ...scalars(
      [
        'ensembleId',
        'name',
        'brief',
        'orchestrationMode',
        'bossmanParticipantId',
        'secondInCommandParticipantId',
        'synthesizerParticipantId',
        'fanoutPolicy',
        'activeRosterPresetId'
      ],
      500
    ),
    // Short user-authored enums: 'off' | 'worktree' | 'any' and the four round modes.
    ...scalars(['fanoutIsolation', 'roundMode'], 32),
    enabled: 'scalar',
    maxParticipants: 'scalar',
    concurrentModeEnabled: 'scalar',
    maxContinuationHops: 'scalar',
    ensembleContextChars: 'scalar',
    selfReflective: 'scalar',
    bossmanAutoApprovals: fields({ enabled: 'scalar', mode: 32, confirmedAt: 64 }),
    captainParticipantIds: { maximum: 50, items: 256 },
    contextTokens: 'scalar',
    participants: {
      maximum: 50,
      items: fields({
        id: exactText(512),
        ...scalars(
          [
            'provider',
            'model',
            'role',
            'reasoningEffort',
            'permissionPresetId',
            'runtimeProfileId',
            'geminiAuthProfileId',
            'ollamaRunProfile',
            'serviceTier',
            'pooledAgentId',
            'stageRole'
          ],
          256
        ),
        // Seat briefs are user-authored free text; 129-char briefs are measured
        // in the wild, so this carries an order of magnitude more.
        instructions: 4096,
        permissionOverrides: fields({
          approvalMode: 128,
          networkAccess: 32,
          agenticServices: fields({
            shellCommands: 32,
            fileChanges: 32,
            externalPublish: 32,
            mcpTools: 32,
            subThreadDelegation: 32,
            canvasInteraction: 32
          }),
          externalPathGrants: {
            maximum: 16,
            items: fields({
              ...scalars(
                [
                  'id',
                  'provider',
                  'workspaceId',
                  'chatId',
                  'appRunId',
                  'kind',
                  'access',
                  'duration',
                  'issuedBy',
                  'createdAt'
                ],
                512
              ),
              bindingVersion: 'scalar',
              path: 4096,
              securityScopedBookmark: 4096,
              signature: 4096,
              order: 'scalar'
            })
          }
        }),
        pooledAgentIdentity: fields({
          schemaVersion: 'scalar',
          agentId: 512,
          nickname: 256,
          iconKind: 32,
          hue: 'scalar',
          saturation: 'scalar',
          brightness: 'scalar',
          accent: 128
        }),
        enabled: 'scalar',
        order: 'scalar',
        fastMode: 'scalar',
        fastModeEnabled: 'scalar',
        thinkingEnabled: 'scalar'
      })
    },
    activeRound: fields({
      ...scalars(
        [
          'id',
          'roundId',
          'status',
          'startedAt',
          'completedAt',
          'endedAt',
          'activeParticipantId',
          'ownerRuntimeInstanceId',
          'authority'
        ],
        512
      ),
      queuedPromptCount: 'scalar',
      hops: 'scalar'
    })
  }),
  derivedThreadTitle: 512,
  searchText: 4096,
  searchPreview: 1024,
  lastUserMessageAt: 'scalar',
  hasPinnedNotes: 'scalar',
  hasTodos: 'scalar',
  sourceChatSize: 'scalar'
})

function copy(value: unknown, shape: Shape, budget: { bytes: number }): unknown {
  if (value === undefined || budget.bytes <= 0) return undefined
  if (typeof shape === 'object' && 'text' in shape) {
    if (typeof value !== 'string' || (!shape.truncate && value.length > shape.text))
      return undefined
    const candidate = shape.truncate ? value.slice(0, shape.text) : value
    const bytes = Buffer.byteLength(JSON.stringify(candidate)) + 8
    if (budget.bytes < bytes) return undefined
    budget.bytes -= bytes
    return candidate
  }
  if (shape === 'scalar' || typeof shape === 'number') {
    let candidate: string | number | boolean | null
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      candidate = value as number | boolean | null
    else if (typeof shape === 'number' && typeof value === 'string')
      candidate = value.slice(0, shape)
    else return undefined
    const bytes = Buffer.byteLength(JSON.stringify(candidate)) + 8
    if (budget.bytes < bytes) return undefined
    budget.bytes -= bytes
    return candidate
  }
  if ('items' in shape) {
    if (!Array.isArray(value)) return undefined
    return value.slice(0, shape.maximum).flatMap((item) => {
      const result = copy(item, shape.items, budget)
      return result === undefined ? [] : [result]
    })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(shape.fields)) {
    const item = copy((value as Record<string, unknown>)[key], spec, budget)
    if (item !== undefined) {
      result[key] = item
      budget.bytes -= key.length + 4
    }
  }
  return result
}

export function copyThreadCatalogueChrome(value: unknown): ThreadCatalogueChrome {
  return (copy(value, CHROME_FIELDS, { bytes: 40 * 1024 }) ?? {}) as ThreadCatalogueChrome
}

export function copyThreadCatalogueLastRun(value: unknown): ThreadCatalogueRun {
  return copy(value, THREAD_CATALOGUE_RUN_FIELDS, { bytes: 8 * 1024 }) as ThreadCatalogueRun
}

const CONTROL_FACTS = fields({
  revision: 'scalar',
  thread: fields({
    ...scalars(['id', 'parentThreadId'], 256),
    workspaceId: 512,
    title: 2048,
    provider: fields(
      scalars(
        [
          'runtimeProvider',
          'displayProvider',
          'hueKey',
          'accent',
          'model',
          'modelLabel',
          'shortCode'
        ],
        512
      )
    ),
    reasoning: 128,
    status: 64,
    chatKind: 32,
    archived: 'scalar',
    pinned: 'scalar',
    updatedAt: 'scalar',
    messageCount: 'scalar',
    tokenEstimate: 'scalar'
  }),
  runWindow: fields({ startedAt: 64, endedAt: 64 }),
  ensemble: fields({
    presetId: 256,
    mode: 128,
    fanout: 128,
    continuationHops: 'scalar',
    maxContinuationHops: 'scalar',
    backgroundCount: 'scalar',
    participants: {
      maximum: 50,
      items: fields({
        ...scalars(
          [
            'id',
            'provider',
            'displayProvider',
            'hueKey',
            'accent',
            'shortCode',
            'role',
            'model',
            'reasoning',
            'stage',
            'status'
          ],
          512
        ),
        order: 'scalar',
        active: 'scalar',
        next: 'scalar',
        enabled: 'scalar'
      })
    }
  })
})

export function copyThreadCatalogueControlFacts(
  value: unknown
): TaskWraithControlThreadFacts | undefined {
  if (!value || typeof value !== 'object') return undefined
  return copy(value, CONTROL_FACTS, { bytes: 64 * 1024 }) as TaskWraithControlThreadFacts
}
