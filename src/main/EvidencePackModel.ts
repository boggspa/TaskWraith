import type {
  AuditEvidenceRef,
  CapabilityLedgerCell,
  CapabilityLedgerSnapshot,
  CapabilityMapEntry,
  CapabilityMapProvenance,
  CapabilityStallSignal,
  CompletionClaimSupportAssessment,
  EvidenceCapabilityStatus,
  EvidencePackCapabilityCell,
  EvidencePackCompletionClaim,
  EvidencePackRecord,
  ProviderId,
  RepoConventionIndexEntry,
  RepoConventionIndexEntryKind,
  RepoConventionIndexSnapshot
} from './store/types'

const CAPABILITY_STATUS_VALUES = new Set<EvidenceCapabilityStatus>([
  'verified',
  'partial',
  'blocked',
  'unsupported',
  'unverified'
])

const MAP_PROVENANCE_STATES = new Set<CapabilityMapProvenance['state']>([
  'inferred',
  'user_confirmed',
  'implementation_revised',
  'deprecated'
])

const MAP_PROVENANCE_SOURCES = new Set<CapabilityMapProvenance['source']>([
  'scope_radar',
  'user',
  'agent',
  'evidence_pack',
  'system'
])

const PROVIDERS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])

const CONVENTION_ENTRY_KINDS = new Set<RepoConventionIndexEntryKind>([
  'component_family',
  'utility',
  'architectural_boundary',
  'style_system',
  'generated_path',
  'decision',
  'do_not_repeat'
])

const MAX_TITLE_LENGTH = 180
const MAX_NOTE_LENGTH = 500
const MAX_PATH_LENGTH = 800
const MAX_EVIDENCE_REFS = 24
const MAX_MAP_ENTRIES = 200
const MAX_CELLS = 200
const MAX_CLAIMS = 100
const STALL_WINDOW = 3
const COMPLETION_LANGUAGE_PATTERNS: Array<{ phrase: string; pattern: RegExp }> = [
  { phrase: 'done', pattern: /\b(done|all done)\b/i },
  { phrase: 'implemented', pattern: /\b(implemented|implementation is complete)\b/i },
  { phrase: 'fixed', pattern: /\b(fixed|resolved)\b/i },
  { phrase: 'ready', pattern: /\b(ready|ready for review|ready to ship)\b/i },
  { phrase: 'complete', pattern: /\b(complete|completed|finished)\b/i },
  { phrase: 'shipped', pattern: /\b(shipped|landed)\b/i }
]

function text(value: unknown, max = MAX_NOTE_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function stringList(value: unknown, maxItems = 20, maxChars = MAX_PATH_LENGTH): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const normalized = text(item, maxChars)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function isoOrNow(value: unknown, nowIso: string): string {
  const candidate = text(value, 80)
  if (!candidate) return nowIso
  const date = new Date(candidate)
  return Number.isFinite(date.getTime()) ? date.toISOString() : nowIso
}

function normalizeEvidenceRef(value: unknown): AuditEvidenceRef | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<AuditEvidenceRef>
  const path = text(input.path, MAX_PATH_LENGTH)
  if (!path) return null
  const line =
    typeof input.line === 'number' && Number.isFinite(input.line)
      ? Math.max(1, Math.floor(input.line))
      : undefined
  return {
    path,
    ...(line ? { line } : {}),
    ...(text(input.note, MAX_NOTE_LENGTH) ? { note: text(input.note, MAX_NOTE_LENGTH) } : {})
  }
}

function normalizeEvidenceRefs(value: unknown): AuditEvidenceRef[] {
  if (!Array.isArray(value)) return []
  const out: AuditEvidenceRef[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const ref = normalizeEvidenceRef(item)
    if (!ref) continue
    const key = evidenceRefKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= MAX_EVIDENCE_REFS) break
  }
  return out
}

export function normalizeCapabilityKey(value: unknown, fallback = 'capability'): string {
  const raw = text(value, 120) || fallback
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return key || fallback
}

function evidenceRefKey(ref: AuditEvidenceRef): string {
  return `${ref.path}:${ref.line || 0}:${ref.note || ''}`
}

function mergeEvidenceRefs(a: AuditEvidenceRef[], b: AuditEvidenceRef[]): AuditEvidenceRef[] {
  const out: AuditEvidenceRef[] = []
  const seen = new Set<string>()
  for (const ref of [...a, ...b]) {
    const key = evidenceRefKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= MAX_EVIDENCE_REFS) break
  }
  return out
}

function normalizeMapProvenance(value: unknown, nowIso: string): CapabilityMapProvenance {
  const input = value && typeof value === 'object' ? (value as Partial<CapabilityMapProvenance>) : {}
  return {
    state: MAP_PROVENANCE_STATES.has(input.state as CapabilityMapProvenance['state'])
      ? (input.state as CapabilityMapProvenance['state'])
      : 'inferred',
    source: MAP_PROVENANCE_SOURCES.has(input.source as CapabilityMapProvenance['source'])
      ? (input.source as CapabilityMapProvenance['source'])
      : 'system',
    at: isoOrNow(input.at, nowIso),
    ...(text(input.note, MAX_NOTE_LENGTH) ? { note: text(input.note, MAX_NOTE_LENGTH) } : {}),
    ...(normalizeEvidenceRefs(input.evidenceRefs).length > 0
      ? { evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs) }
      : {})
  }
}

function normalizeMapEntry(value: unknown, nowIso: string): CapabilityMapEntry | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CapabilityMapEntry>
  const title = text(input.title, MAX_TITLE_LENGTH)
  const key = normalizeCapabilityKey(input.key || title, '')
  if (!key || !title) return null
  return {
    key,
    title,
    ...(text(input.description, 1000) ? { description: text(input.description, 1000) } : {}),
    ...(text(input.parentKey, 120) ? { parentKey: normalizeCapabilityKey(input.parentKey) } : {}),
    provenance: normalizeMapProvenance(input.provenance, nowIso)
  }
}

function normalizeCapabilityCell(value: unknown): EvidencePackCapabilityCell | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<EvidencePackCapabilityCell>
  const title = text(input.title, MAX_TITLE_LENGTH)
  const capabilityKey = normalizeCapabilityKey(input.capabilityKey || title, '')
  if (!capabilityKey) return null
  return {
    capabilityKey,
    ...(title ? { title } : {}),
    status: CAPABILITY_STATUS_VALUES.has(input.status as EvidenceCapabilityStatus)
      ? (input.status as EvidenceCapabilityStatus)
      : 'unverified',
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
    ...(text(input.statusReason, 1000) ? { statusReason: text(input.statusReason, 1000) } : {}),
    ...(text(input.validationCommand, 500) ? { validationCommand: text(input.validationCommand, 500) } : {}),
    ...(stringList(input.unsupportedClaims, 20, 240).length > 0
      ? { unsupportedClaims: stringList(input.unsupportedClaims, 20, 240) }
      : {})
  }
}

function normalizeCompletionClaim(value: unknown): EvidencePackCompletionClaim | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<EvidencePackCompletionClaim>
  const claim = text(input.claim, 1000)
  if (!claim) return null
  return {
    claim,
    supported: input.supported === true,
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
    ...(text(input.note, MAX_NOTE_LENGTH) ? { note: text(input.note, MAX_NOTE_LENGTH) } : {})
  }
}

export function normalizeEvidencePackRecord(
  value: unknown,
  now = new Date()
): EvidencePackRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<EvidencePackRecord>
  const nowIso = now.toISOString()
  const id = text(input.id, 200) || `evidence-${now.getTime()}`
  const workspaceId = text(input.workspaceId, 200)
  if (!workspaceId) return null
  const mapEntries = Array.isArray(input.mapEntries)
    ? input.mapEntries
        .map((item) => normalizeMapEntry(item, nowIso))
        .filter((item): item is CapabilityMapEntry => Boolean(item))
        .slice(0, MAX_MAP_ENTRIES)
    : []
  const capabilityCells = Array.isArray(input.capabilityCells)
    ? input.capabilityCells
        .map(normalizeCapabilityCell)
        .filter((item): item is EvidencePackCapabilityCell => Boolean(item))
        .slice(0, MAX_CELLS)
    : []
  const completionClaims = Array.isArray(input.completionClaims)
    ? input.completionClaims
        .map(normalizeCompletionClaim)
        .filter((item): item is EvidencePackCompletionClaim => Boolean(item))
        .slice(0, MAX_CLAIMS)
    : []
  return {
    schemaVersion: 1,
    id,
    workspaceId,
    ...(text(input.workspacePath, 4000) ? { workspacePath: text(input.workspacePath, 4000) } : {}),
    ...(text(input.chatId, 200) ? { chatId: text(input.chatId, 200) } : {}),
    ...(text(input.runId, 200) ? { runId: text(input.runId, 200) } : {}),
    ...(PROVIDERS.has(input.provider as ProviderId) ? { provider: input.provider as ProviderId } : {}),
    ...(text(input.title, MAX_TITLE_LENGTH) ? { title: text(input.title, MAX_TITLE_LENGTH) } : {}),
    mapEntries,
    capabilityCells,
    completionClaims,
    ...(stringList(input.diffTouchedFiles, 200, MAX_PATH_LENGTH).length > 0
      ? { diffTouchedFiles: stringList(input.diffTouchedFiles, 200, MAX_PATH_LENGTH) }
      : {}),
    createdAt: isoOrNow(input.createdAt, nowIso),
    updatedAt: isoOrNow(input.updatedAt, nowIso)
  }
}

export function detectCompletionLanguage(value: unknown): string[] {
  const source = text(value, 4000)
  if (!source) return []
  const phrases: string[] = []
  for (const item of COMPLETION_LANGUAGE_PATTERNS) {
    if (item.pattern.test(source)) phrases.push(item.phrase)
  }
  return [...new Set(phrases)]
}

export function assessCompletionClaimSupport(
  finalText: unknown,
  packs: EvidencePackRecord[],
  options: { workspaceId?: string; chatId?: string; runId?: string } = {}
): CompletionClaimSupportAssessment {
  const completionPhrases = detectCompletionLanguage(finalText)
  const scopedPacks = packs.filter((pack) => {
    if (options.workspaceId && pack.workspaceId !== options.workspaceId) return false
    if (options.chatId && pack.chatId !== options.chatId) return false
    if (options.runId && pack.runId !== options.runId) return false
    return true
  })
  const evidencePackIds = scopedPacks.map((pack) => pack.id)
  const claims = scopedPacks.flatMap((pack) => pack.completionClaims)
  const supportedClaims = claims.filter((claim) => claim.supported && claim.evidenceRefs.length > 0)
  const unsupportedClaims = claims.filter((claim) => !claim.supported)
  const verifiedCells = scopedPacks.flatMap((pack) =>
    pack.capabilityCells.filter((cell) => cell.status === 'verified' && cell.evidenceRefs.length > 0)
  )
  const partialCells = scopedPacks.flatMap((pack) =>
    pack.capabilityCells.filter((cell) => cell.status === 'partial' && cell.evidenceRefs.length > 0)
  )
  const supportingEvidenceRefs = [
    ...supportedClaims.flatMap((claim) => claim.evidenceRefs),
    ...verifiedCells.flatMap((cell) => cell.evidenceRefs)
  ].slice(0, MAX_EVIDENCE_REFS)

  if (completionPhrases.length === 0) {
    return {
      status: 'no_completion_claim',
      hasCompletionLanguage: false,
      completionPhrases,
      evidencePackIds,
      supportedClaims,
      unsupportedClaims,
      supportingEvidenceRefs,
      message: 'No completion-style claim was detected.'
    }
  }

  if (unsupportedClaims.length > 0) {
    return {
      status: 'unsupported',
      hasCompletionLanguage: true,
      completionPhrases,
      evidencePackIds,
      supportedClaims,
      unsupportedClaims,
      supportingEvidenceRefs,
      message: 'Completion-style language is present, but the Evidence Pack records unsupported claims.',
      recommendedCaveat:
        'Do not present this as complete. Name the unsupported claim and the evidence still needed.'
    }
  }

  if (supportedClaims.length > 0 || verifiedCells.length > 0) {
    return {
      status: 'supported',
      hasCompletionLanguage: true,
      completionPhrases,
      evidencePackIds,
      supportedClaims,
      unsupportedClaims,
      supportingEvidenceRefs,
      message: 'Completion-style language is supported by evidence-backed claims or verified capability cells.'
    }
  }

  if (partialCells.length > 0) {
    return {
      status: 'partial',
      hasCompletionLanguage: true,
      completionPhrases,
      evidencePackIds,
      supportedClaims,
      unsupportedClaims,
      supportingEvidenceRefs: partialCells.flatMap((cell) => cell.evidenceRefs).slice(0, MAX_EVIDENCE_REFS),
      message: 'Completion-style language is too strong for partial evidence.',
      recommendedCaveat:
        'Say this is partially implemented or still under validation, and list the missing proof.'
    }
  }

  return {
    status: 'unsupported',
    hasCompletionLanguage: true,
    completionPhrases,
    evidencePackIds,
    supportedClaims,
    unsupportedClaims,
    supportingEvidenceRefs,
    message: 'Completion-style language is unsupported because no evidence-backed completion claim was found.',
    recommendedCaveat:
      'Avoid done/implemented/ready wording until an Evidence Pack includes supported claims or verified cells.'
  }
}

function completionClaimMetric(packs: EvidencePackRecord[]) {
  const totalCompletionClaims = packs.reduce((sum, pack) => sum + pack.completionClaims.length, 0)
  const unsupportedCompletionClaims = packs.reduce(
    (sum, pack) => sum + pack.completionClaims.filter((claim) => !claim.supported).length,
    0
  )
  return {
    totalCompletionClaims,
    unsupportedCompletionClaims,
    unsupportedCompletionClaimRate:
      totalCompletionClaims > 0 ? unsupportedCompletionClaims / totalCompletionClaims : 0
  }
}

function cellDelta(before: Map<string, CapabilityLedgerCell>, after: Map<string, CapabilityLedgerCell>): boolean {
  if (before.size !== after.size) return true
  for (const [key, next] of after) {
    const prior = before.get(key)
    if (!prior) return true
    if (prior.status !== next.status) return true
    if (prior.evidenceRefs.length !== next.evidenceRefs.length) return true
    if ((prior.unsupportedClaims || []).length !== (next.unsupportedClaims || []).length) return true
  }
  return false
}

function applyPackToLedgerCells(
  cellsByKey: Map<string, CapabilityLedgerCell>,
  pack: EvidencePackRecord
): Map<string, CapabilityLedgerCell> {
  const next = new Map(cellsByKey)
  for (const cell of pack.capabilityCells) {
    const prior = next.get(cell.capabilityKey)
    next.set(cell.capabilityKey, {
      capabilityKey: cell.capabilityKey,
      title: cell.title || prior?.title || cell.capabilityKey,
      status: cell.status,
      evidenceRefs: mergeEvidenceRefs(prior?.evidenceRefs || [], cell.evidenceRefs),
      ...(cell.statusReason ? { statusReason: cell.statusReason } : prior?.statusReason ? { statusReason: prior.statusReason } : {}),
      ...(cell.validationCommand ? { validationCommand: cell.validationCommand } : prior?.validationCommand ? { validationCommand: prior.validationCommand } : {}),
      ...(cell.unsupportedClaims?.length ? { unsupportedClaims: cell.unsupportedClaims } : prior?.unsupportedClaims ? { unsupportedClaims: prior.unsupportedClaims } : {}),
      latestEvidencePackId: pack.id,
      ...(pack.runId ? { latestRunId: pack.runId } : prior?.latestRunId ? { latestRunId: prior.latestRunId } : {}),
      updatedAt: pack.updatedAt
    })
  }
  return next
}

export function detectDeterministicCapabilityStalls(
  packs: EvidencePackRecord[]
): CapabilityStallSignal[] {
  const sorted = [...packs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const signals: CapabilityStallSignal[] = []
  let cellsByKey = new Map<string, CapabilityLedgerCell>()
  const noDeltaDiffPacks: EvidencePackRecord[] = []
  const partialHistory = new Map<string, { packIds: string[]; evidenceCounts: number[]; runIds: string[] }>()

  for (const pack of sorted) {
    const before = cellsByKey
    const after = applyPackToLedgerCells(before, pack)
    const changed = cellDelta(before, after)
    if ((pack.diffTouchedFiles || []).length > 0 && !changed) {
      noDeltaDiffPacks.push(pack)
      if (noDeltaDiffPacks.length >= STALL_WINDOW) {
        const window = noDeltaDiffPacks.slice(-STALL_WINDOW)
        signals.push({
          kind: 'diff_without_capability_delta',
          severity: 'warning',
          evidencePackIds: window.map((item) => item.id),
          runIds: window.map((item) => item.runId).filter((runId): runId is string => Boolean(runId)),
          note: `${STALL_WINDOW} evidence packs touched files without changing the capability ledger.`
        })
      }
    } else if (changed) {
      noDeltaDiffPacks.length = 0
    }
    cellsByKey = after

    for (const cell of pack.capabilityCells) {
      if (cell.status !== 'partial') continue
      const prior = partialHistory.get(cell.capabilityKey) || {
        packIds: [],
        evidenceCounts: [],
        runIds: []
      }
      prior.packIds.push(pack.id)
      prior.evidenceCounts.push(cell.evidenceRefs.length)
      if (pack.runId) prior.runIds.push(pack.runId)
      partialHistory.set(cell.capabilityKey, prior)
      const recentCounts = prior.evidenceCounts.slice(-STALL_WINDOW)
      if (
        recentCounts.length >= STALL_WINDOW &&
        recentCounts.every((count) => count === recentCounts[0])
      ) {
        signals.push({
          kind: 'partial_without_new_evidence',
          severity: 'warning',
          capabilityKey: cell.capabilityKey,
          evidencePackIds: prior.packIds.slice(-STALL_WINDOW),
          runIds: prior.runIds.slice(-STALL_WINDOW),
          note: `Capability "${cell.capabilityKey}" stayed partial without new evidence across ${STALL_WINDOW} packs.`
        })
      }
    }
  }

  const deduped = new Map<string, CapabilityStallSignal>()
  for (const signal of signals) {
    deduped.set(
      `${signal.kind}:${signal.capabilityKey || ''}:${signal.evidencePackIds.join(',')}`,
      signal
    )
  }
  return [...deduped.values()]
}

export function projectCapabilityLedgerFromEvidencePacks(
  packs: EvidencePackRecord[],
  options: { workspaceId?: string; now?: Date } = {}
): CapabilityLedgerSnapshot {
  const workspacePacks = options.workspaceId
    ? packs.filter((pack) => pack.workspaceId === options.workspaceId)
    : packs
  const sorted = [...workspacePacks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const mapEntriesByKey = new Map<string, CapabilityMapEntry>()
  let cellsByKey = new Map<string, CapabilityLedgerCell>()
  for (const pack of sorted) {
    for (const entry of pack.mapEntries) mapEntriesByKey.set(entry.key, entry)
    cellsByKey = applyPackToLedgerCells(cellsByKey, pack)
  }
  const metric = completionClaimMetric(sorted)
  return {
    workspaceId: options.workspaceId,
    generatedAt: (options.now || new Date()).toISOString(),
    cells: [...cellsByKey.values()].sort((a, b) => a.title.localeCompare(b.title)),
    mapEntries: [...mapEntriesByKey.values()].sort((a, b) => a.title.localeCompare(b.title)),
    ...metric,
    stallSignals: detectDeterministicCapabilityStalls(sorted)
  }
}

export function normalizeRepoConventionIndexSnapshot(
  value: unknown,
  now = new Date()
): RepoConventionIndexSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<RepoConventionIndexSnapshot>
  const workspaceId = text(input.workspaceId, 200)
  if (!workspaceId) return null
  const entries = Array.isArray(input.entries)
    ? input.entries
        .map((entry): RepoConventionIndexEntry | null => {
          if (!entry || typeof entry !== 'object') return null
          const raw = entry as Partial<RepoConventionIndexEntry>
          const id = text(raw.id, 200)
          const title = text(raw.title, MAX_TITLE_LENGTH)
          if (!id || !title) return null
          return {
            id,
            kind: CONVENTION_ENTRY_KINDS.has(raw.kind as RepoConventionIndexEntryKind)
              ? (raw.kind as RepoConventionIndexEntryKind)
              : 'decision',
            title,
            ...(text(raw.description, 1000) ? { description: text(raw.description, 1000) } : {}),
            ...(stringList(raw.paths, 100, MAX_PATH_LENGTH).length > 0
              ? { paths: stringList(raw.paths, 100, MAX_PATH_LENGTH) }
              : {}),
            ...(normalizeEvidenceRefs(raw.evidenceRefs).length > 0
              ? { evidenceRefs: normalizeEvidenceRefs(raw.evidenceRefs) }
              : {}),
            provenance:
              raw.provenance === 'scan' ||
              raw.provenance === 'blackboard' ||
              raw.provenance === 'evidence_pack' ||
              raw.provenance === 'user'
                ? raw.provenance
                : 'scan',
            updatedAt: isoOrNow(raw.updatedAt, now.toISOString())
          }
        })
        .filter((entry): entry is RepoConventionIndexEntry => Boolean(entry))
    : []
  return {
    schemaVersion: 1,
    workspaceId,
    ...(text(input.workspacePath, 4000) ? { workspacePath: text(input.workspacePath, 4000) } : {}),
    generatedAt: isoOrNow(input.generatedAt, now.toISOString()),
    entries,
    ...(text(input.staleReason, MAX_NOTE_LENGTH) ? { staleReason: text(input.staleReason, MAX_NOTE_LENGTH) } : {})
  }
}
