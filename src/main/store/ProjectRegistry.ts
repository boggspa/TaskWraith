import { createHash } from 'crypto'

import {
  applyAddChatToProject,
  applyProjectOp,
  migrateProjectWorkProfiles,
  migrateProjects,
  projectById,
  type Project,
  type ProjectOp,
  type ProjectWorkProfile
} from '../../shared/projects'

/**
 * Main-owned durable registry for Project records (the containers behind the
 * sidebar's Work surface) and their ProjectWorkProfile companion records.
 *
 * Records were historically renderer-local (`localStorage`), which made main
 * blind to membership and barred any iOS projection. This registry is the
 * single durable authority after the one-shot legacy import; the renderer
 * keeps an optimistic in-memory snapshot and sends `ProjectOp`s here.
 *
 * Persistence is deliberately thin and injected: the hardened atomic
 * `writeJson` / backup-on-corrupt `readJson` pair lives in store/index.ts and
 * is passed in, so this module never grows its own (subtly different) disk
 * semantics. Reads go to disk per call, matching the workspaces registry —
 * the file is small and main is its only writer.
 *
 * Record LOGIC does not live here: every list mutation flows through
 * `applyProjectOp` from src/shared/projects.ts, the same function the
 * renderer applies optimistically, so the two sides cannot drift. Work
 * profiles are the exception — they are low-frequency, main-authoritative
 * mutations with no optimistic twin, so their rules (one home per chat, the
 * claim+membership transaction) live here.
 */

export interface ProjectRegistryPersistenceDeps {
  filePath: string
  readJson: <T>(filePath: string, defaultData: T) => T
  writeJson: (filePath: string, data: unknown) => void
  /** Clock seam for tests; production omits it. Used to seed migration
   * timestamps, the import marker, and profile mutations — list-op
   * timestamps arrive inside ops. */
  now?: () => number
}

export type ProjectLegacyImportStatus =
  | 'imported'
  | 'already-imported'
  | 'nothing-to-import'
  | 'invalid-payload'

/**
 * Written exactly once, when the renderer first hands over its localStorage
 * payload. Its presence is the one-shot gate: later import calls return
 * 'already-imported' without touching state, which lets the renderer retry
 * the handshake safely until it has durably tombstoned its side.
 */
export interface ProjectLegacyImportMarker {
  importedAt: number
  /** sha256 of the exact raw payload string the marker was written for. */
  sourceHash: string
  /** Records actually added (post-validation, post-dedupe). */
  importedCount: number
  status: Exclude<ProjectLegacyImportStatus, 'already-imported'>
}

export interface ProjectLegacyImportResult {
  status: ProjectLegacyImportStatus
  importedCount: number
  marker: ProjectLegacyImportMarker
}

/** The authoritative state fanned out to renderers on every change. */
export interface ProjectRegistryState {
  projects: Project[]
  workProfiles: ProjectWorkProfile[]
}

export interface ProjectRegistryMutationResult extends ProjectRegistryState {
  changed: boolean
}

interface ProjectRegistryFileV1 {
  schemaVersion: 1
  projects: Project[]
  workProfiles: ProjectWorkProfile[]
  legacyImport?: ProjectLegacyImportMarker
}

export interface ProjectRegistry {
  getProjects(): Project[]
  getWorkProfiles(): ProjectWorkProfile[]
  /** Apply a wire op against authoritative state. Persists and notifies only
   * when the op changed something (profile reconciliation counts). Validation
   * errors propagate to the caller (the IPC handler surfaces them to the
   * renderer). */
  applyOp(op: ProjectOp): ProjectRegistryMutationResult
  /**
   * The home-chat claim transaction: sets `homeChatId` AND adds the chat to
   * the Project's membership in ONE envelope write, enforcing one-home-per-
   * chat across Projects. `chatId: null` clears the claim (membership is
   * untouched — un-homing a thread must not eject it from the Project).
   */
  setHomeChat(projectId: string, chatId: string | null): ProjectRegistryMutationResult
  importLegacyProjects(rawJson: string | null): ProjectLegacyImportResult
  getLegacyImportMarker(): ProjectLegacyImportMarker | null
  /** Single listener (the window broadcast); fires after every persisted
   * change with the full authoritative state. */
  setChangeListener(listener: ((state: ProjectRegistryState) => void) | null): void
}

function isImportMarker(value: unknown): value is ProjectLegacyImportMarker {
  if (!value || typeof value !== 'object') return false
  const marker = value as Partial<ProjectLegacyImportMarker>
  return (
    typeof marker.importedAt === 'number' &&
    Number.isFinite(marker.importedAt) &&
    typeof marker.sourceHash === 'string' &&
    typeof marker.importedCount === 'number' &&
    Number.isFinite(marker.importedCount) &&
    (marker.status === 'imported' ||
      marker.status === 'nothing-to-import' ||
      marker.status === 'invalid-payload')
  )
}

/** Clear `homeChatId` from every profile the predicate matches, dropping
 * profiles left with no semantic fields. Same-reference return = no-op. */
function clearHomeChatWhere(
  profiles: ProjectWorkProfile[],
  matches: (profile: ProjectWorkProfile) => boolean,
  now: number
): ProjectWorkProfile[] {
  let changed = false
  const next: ProjectWorkProfile[] = []
  for (const profile of profiles) {
    if (!profile.homeChatId || !matches(profile)) {
      next.push(profile)
      continue
    }
    changed = true
    const { homeChatId: _cleared, ...rest } = profile
    if (rest.brief !== undefined || rest.preferredWorkspaceId !== undefined) {
      next.push({ ...rest, updatedAt: now })
    }
  }
  return changed ? next : profiles
}

/** Post-op profile reconciliation: deletes drop orphaned profiles, chat
 * removals clear matching home claims (a home must remain a member). */
function reconcileProfilesForOp(
  profiles: ProjectWorkProfile[],
  nextProjects: Project[],
  op: ProjectOp,
  now: number
): ProjectWorkProfile[] {
  switch (op.kind) {
    case 'delete': {
      const surviving = new Set(nextProjects.map((project) => project.id))
      const next = profiles.filter((profile) => surviving.has(profile.projectId))
      return next.length === profiles.length ? profiles : next
    }
    case 'remove-chat': {
      const chatId = op.chatId.trim()
      if (!chatId) return profiles
      return clearHomeChatWhere(
        profiles,
        (profile) => profile.projectId === op.projectId && profile.homeChatId === chatId,
        now
      )
    }
    case 'remove-chat-everywhere': {
      const chatId = op.chatId.trim()
      if (!chatId) return profiles
      return clearHomeChatWhere(profiles, (profile) => profile.homeChatId === chatId, now)
    }
    default:
      return profiles
  }
}

export function createProjectRegistry(deps: ProjectRegistryPersistenceDeps): ProjectRegistry {
  const now = deps.now ?? Date.now
  let changeListener: ((state: ProjectRegistryState) => void) | null = null

  const readEnvelope = (): ProjectRegistryFileV1 => {
    const raw = deps.readJson<unknown>(deps.filePath, null)
    // Tolerate every historical/corrupt shape: a bare array is treated as the
    // project list, anything unrecognizable degrades to an empty registry
    // (readJson has already preserved a .corrupt backup of unparseable files).
    if (Array.isArray(raw)) {
      const projects = migrateProjects(raw, now())
      return { schemaVersion: 1, projects, workProfiles: [] }
    }
    if (!raw || typeof raw !== 'object') {
      return { schemaVersion: 1, projects: [], workProfiles: [] }
    }
    const envelope = raw as Partial<ProjectRegistryFileV1>
    const projects = migrateProjects(
      Array.isArray(envelope.projects) ? envelope.projects : [],
      now()
    )
    const workProfiles = migrateProjectWorkProfiles(
      Array.isArray(envelope.workProfiles) ? envelope.workProfiles : [],
      new Set(projects.map((project) => project.id)),
      now()
    )
    return {
      schemaVersion: 1,
      projects,
      workProfiles,
      ...(isImportMarker(envelope.legacyImport) ? { legacyImport: envelope.legacyImport } : {})
    }
  }

  const writeEnvelope = (envelope: ProjectRegistryFileV1): void => {
    deps.writeJson(deps.filePath, envelope)
  }

  const notify = (state: ProjectRegistryState): void => {
    try {
      changeListener?.(state)
    } catch (error) {
      // The broadcast must never poison the persistence path.
      console.error('Project registry change listener failed', error)
    }
  }

  return {
    getProjects(): Project[] {
      return readEnvelope().projects
    },

    getWorkProfiles(): ProjectWorkProfile[] {
      return readEnvelope().workProfiles
    },

    applyOp(op: ProjectOp): ProjectRegistryMutationResult {
      const envelope = readEnvelope()
      const { projects, changed: listChanged } = applyProjectOp(envelope.projects, op)
      const workProfiles = reconcileProfilesForOp(
        envelope.workProfiles,
        projects,
        op,
        now()
      )
      const changed = listChanged || workProfiles !== envelope.workProfiles
      if (changed) {
        writeEnvelope({ ...envelope, projects, workProfiles })
        notify({ projects, workProfiles })
      }
      return { projects, workProfiles, changed }
    },

    setHomeChat(projectId: string, chatId: string | null): ProjectRegistryMutationResult {
      const envelope = readEnvelope()
      const project = projectById(envelope.projects, projectId)
      if (!project) throw new Error('Project not found.')
      const nowMs = now()

      if (chatId === null) {
        const workProfiles = clearHomeChatWhere(
          envelope.workProfiles,
          (profile) => profile.projectId === projectId,
          nowMs
        )
        if (workProfiles === envelope.workProfiles) {
          return { projects: envelope.projects, workProfiles, changed: false }
        }
        writeEnvelope({ ...envelope, workProfiles })
        notify({ projects: envelope.projects, workProfiles })
        return { projects: envelope.projects, workProfiles, changed: true }
      }

      const trimmed = chatId.trim()
      if (!trimmed) throw new Error('Chat id is required.')
      const conflict = envelope.workProfiles.find(
        (profile) => profile.projectId !== projectId && profile.homeChatId === trimmed
      )
      if (conflict) throw new Error('Chat is already the home of another project.')

      const existing = envelope.workProfiles.find((profile) => profile.projectId === projectId)
      const alreadyClaimed =
        existing?.homeChatId === trimmed && project.memberChatIds.includes(trimmed)
      if (alreadyClaimed) {
        return { projects: envelope.projects, workProfiles: envelope.workProfiles, changed: false }
      }

      // Claim + membership are one transaction: the home chat must always be
      // an ordinary member, and a crash can never persist one without the
      // other because both land in the same atomic envelope write.
      const { projects } = applyAddChatToProject(envelope.projects, projectId, trimmed, nowMs)
      const nextProfile: ProjectWorkProfile = {
        ...(existing ?? { projectId }),
        projectId,
        homeChatId: trimmed,
        updatedAt: nowMs
      }
      const workProfiles = existing
        ? envelope.workProfiles.map((profile) =>
            profile.projectId === projectId ? nextProfile : profile
          )
        : [...envelope.workProfiles, nextProfile]

      writeEnvelope({ ...envelope, projects, workProfiles })
      notify({ projects, workProfiles })
      return { projects, workProfiles, changed: true }
    },

    importLegacyProjects(rawJson: string | null): ProjectLegacyImportResult {
      const envelope = readEnvelope()
      if (envelope.legacyImport) {
        return {
          status: 'already-imported',
          importedCount: envelope.legacyImport.importedCount,
          marker: envelope.legacyImport
        }
      }

      const importedAt = now()
      const sourceHash = createHash('sha256')
        .update(rawJson ?? '', 'utf8')
        .digest('hex')

      let parsed: unknown = null
      let parseFailed = false
      if (rawJson) {
        try {
          parsed = JSON.parse(rawJson)
        } catch {
          parseFailed = true
        }
      }

      let status: ProjectLegacyImportMarker['status']
      let imported: Project[] = []
      if (!rawJson || (Array.isArray(parsed) && parsed.length === 0)) {
        status = 'nothing-to-import'
      } else if (parseFailed || !Array.isArray(parsed)) {
        // Unparseable/non-list payloads carry nothing recoverable. Recording
        // the marker anyway ends the handshake instead of retrying forever;
        // the renderer's original payload survives untouched on its side
        // until it tombstones, and sourceHash documents what was seen.
        status = 'invalid-payload'
      } else {
        status = 'imported'
        imported = migrateProjects(parsed, importedAt)
      }

      // Merge policy: records created directly in this registry win on id
      // collision — the legacy copy is by definition staler than live state.
      const existingIds = new Set(envelope.projects.map((project) => project.id))
      const added = imported.filter((project) => !existingIds.has(project.id))
      const merged = [...envelope.projects, ...added]

      const marker: ProjectLegacyImportMarker = {
        importedAt,
        sourceHash,
        importedCount: added.length,
        status
      }
      writeEnvelope({ ...envelope, projects: merged, legacyImport: marker })
      if (added.length > 0) notify({ projects: merged, workProfiles: envelope.workProfiles })
      return { status, importedCount: added.length, marker }
    },

    getLegacyImportMarker(): ProjectLegacyImportMarker | null {
      return readEnvelope().legacyImport ?? null
    },

    setChangeListener(listener: ((state: ProjectRegistryState) => void) | null): void {
      changeListener = listener
    }
  }
}
