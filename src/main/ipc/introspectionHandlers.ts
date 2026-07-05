import { ipcMain } from 'electron'
import type {
  IntrospectionScheduleSettings,
  MemoryProposal,
  MemoryProposalPack,
  MemoryProposalStatus
} from '../store/types'
import type { ApplyMemoryProposalResult } from '../introspection/IntrospectionApplyService'
import type {
  RunManualIntrospectionInput,
  RunManualIntrospectionResult
} from '../introspection/IntrospectionRunService'

const REVIEWABLE_STATUSES = new Set<MemoryProposalStatus>(['approved', 'rejected', 'expired'])

export interface IntrospectionHandlersDeps {
  getMemoryProposalPacks: (workspaceId?: string) => MemoryProposalPack[]
  getMemoryProposalPack: (id: string) => MemoryProposalPack | null
  updateMemoryProposal: (
    packId: string,
    proposalId: string,
    partial: Partial<MemoryProposal>
  ) => MemoryProposalPack | null
  applyMemoryProposal: (packId: string, proposalId: string) => ApplyMemoryProposalResult
  runManualIntrospection: (input: RunManualIntrospectionInput) => RunManualIntrospectionResult
  getIntrospectionSchedule: (workspaceId?: string) => IntrospectionScheduleSettings
  updateIntrospectionSchedule: (
    partial: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null }
  ) => IntrospectionScheduleSettings
  scheduleNextTaskTimer?: () => void
}

export interface UpdateMemoryProposalInput {
  packId: string
  proposalId: string
  partial?: Partial<MemoryProposal>
}

export interface ApplyMemoryProposalInput {
  packId: string
  proposalId: string
}

function text(value: unknown, max = 240): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function optionalText(value: unknown, max = 240): string | undefined {
  const trimmed = text(value, max)
  return trimmed || undefined
}

function parseIsoWindow(value: unknown): string | null {
  const raw = text(value, 80)
  if (!raw) return null
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function sanitizeProposalPatch(partial: unknown): Partial<MemoryProposal> {
  if (!partial || typeof partial !== 'object') return {}
  const input = partial as Partial<MemoryProposal>
  const patch: Partial<MemoryProposal> = {}

  if (input.status && REVIEWABLE_STATUSES.has(input.status)) {
    patch.status = input.status
  }

  const reviewNote = optionalText(input.reviewNote, 2000)
  if (reviewNote) patch.reviewNote = reviewNote

  const expiresAt = parseIsoWindow(input.expiresAt)
  if (expiresAt) patch.expiresAt = expiresAt

  return patch
}

function sanitizeIntrospectionSchedulePatch(
  input: unknown
): Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null } {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null }
  const patch: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null } = {}

  if (typeof raw.enabled === 'boolean') {
    patch.enabled = raw.enabled
  }

  const workspaceId = optionalText(raw.workspaceId, 120)
  if (workspaceId !== undefined) {
    patch.workspaceId = workspaceId
  } else if (raw.workspaceId === null) {
    patch.workspaceId = null
  }

  if (raw.lastRunAt === null) {
    patch.lastRunAt = null
  } else {
    const lastRunAt = parseIsoWindow(raw.lastRunAt)
    if (lastRunAt) patch.lastRunAt = lastRunAt
  }

  if (raw.nextRunAt === null) {
    patch.nextRunAt = null
  } else {
    const nextRunAt = parseIsoWindow(raw.nextRunAt)
    if (nextRunAt) patch.nextRunAt = nextRunAt
  }

  return patch
}

function sanitizeRunManualIntrospectionInput(input: unknown): RunManualIntrospectionInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Manual introspection input is required.')
  }
  const raw = input as Partial<RunManualIntrospectionInput>
  const windowStart = parseIsoWindow(raw.windowStart)
  const windowEnd = parseIsoWindow(raw.windowEnd)
  if (!windowStart || !windowEnd) {
    throw new Error('windowStart and windowEnd must be valid ISO timestamps.')
  }
  if (Date.parse(windowStart) >= Date.parse(windowEnd)) {
    throw new Error('windowStart must be earlier than windowEnd.')
  }

  const trigger = raw.trigger
  const allowedTriggers = new Set(['manual', 'scheduled', 'workflow'])
  const normalizedTrigger =
    trigger && allowedTriggers.has(trigger) ? trigger : ('manual' as const)

  return {
    windowStart,
    windowEnd,
    workspaceId: optionalText(raw.workspaceId, 120),
    workspacePath: optionalText(raw.workspacePath, 4096),
    trigger: normalizedTrigger,
    chatId: optionalText(raw.chatId, 120),
    workflowId: optionalText(raw.workflowId, 120),
    minConfidence:
      typeof raw.minConfidence === 'number' && Number.isFinite(raw.minConfidence)
        ? Math.min(1, Math.max(0, raw.minConfidence))
        : undefined,
    summary: optionalText(raw.summary, 8000)
  }
}

export function registerIntrospectionHandlers(deps: IntrospectionHandlersDeps): void {
  ipcMain.handle('get-memory-proposal-packs', (_, workspaceId?: string | null) => {
    const scoped = optionalText(workspaceId, 120)
    return deps.getMemoryProposalPacks(scoped)
  })

  ipcMain.handle('get-memory-proposal-pack', (_, packId: string) => {
    const id = text(packId, 120)
    if (!id) return null
    return deps.getMemoryProposalPack(id)
  })

  ipcMain.handle('update-memory-proposal', (_, input: UpdateMemoryProposalInput) => {
    const packId = text(input?.packId, 120)
    const proposalId = text(input?.proposalId, 120)
    if (!packId || !proposalId) {
      throw new Error('packId and proposalId are required.')
    }
    const patch = sanitizeProposalPatch(input?.partial)
    if (Object.keys(patch).length === 0) {
      throw new Error('At least one reviewable proposal field is required.')
    }
    return deps.updateMemoryProposal(packId, proposalId, patch)
  })

  ipcMain.handle('apply-memory-proposal', (_, input: ApplyMemoryProposalInput) => {
    const packId = text(input?.packId, 120)
    const proposalId = text(input?.proposalId, 120)
    if (!packId || !proposalId) {
      throw new Error('packId and proposalId are required.')
    }
    return deps.applyMemoryProposal(packId, proposalId)
  })

  ipcMain.handle('run-manual-introspection', (_, input: unknown) => {
    const normalized = sanitizeRunManualIntrospectionInput(input)
    const result = deps.runManualIntrospection(normalized)
    return {
      pack: result.pack,
      evidenceCount: result.evidenceCount,
      proposalCount: result.proposalCount
    }
  })

  ipcMain.handle('get-introspection-schedule', (_, workspaceId?: string | null) => {
    const scoped = optionalText(workspaceId, 120)
    return deps.getIntrospectionSchedule(scoped)
  })

  ipcMain.handle('update-introspection-schedule', (_, input: unknown) => {
    const patch = sanitizeIntrospectionSchedulePatch(input)
    if (typeof patch.enabled !== 'boolean' && patch.workspaceId === undefined) {
      throw new Error('At least one schedule field is required.')
    }
    const updated = deps.updateIntrospectionSchedule(patch)
    deps.scheduleNextTaskTimer?.()
    return updated
  })
}