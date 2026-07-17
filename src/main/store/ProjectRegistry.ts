import { createHash } from 'crypto'

import {
  applyProjectOp,
  migrateProjects,
  type Project,
  type ProjectOp
} from '../../shared/projects'

/**
 * Main-owned durable registry for Project records (the containers behind the
 * sidebar's Work surface).
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
 * Record LOGIC does not live here: every mutation flows through
 * `applyProjectOp` from src/shared/projects.ts, the same function the
 * renderer applies optimistically, so the two sides cannot drift.
 */

export interface ProjectRegistryPersistenceDeps {
  filePath: string
  readJson: <T>(filePath: string, defaultData: T) => T
  writeJson: (filePath: string, data: unknown) => void
  /** Clock seam for tests; production omits it. Used only to seed migration
   * timestamps and the import marker — op timestamps arrive inside ops. */
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

interface ProjectRegistryFileV1 {
  schemaVersion: 1
  projects: Project[]
  legacyImport?: ProjectLegacyImportMarker
}

export interface ProjectRegistry {
  getProjects(): Project[]
  /** Apply a wire op against authoritative state. Persists and notifies only
   * when the op changed something. Validation errors propagate to the caller
   * (the IPC handler surfaces them to the renderer). */
  applyOp(op: ProjectOp): { projects: Project[]; changed: boolean }
  importLegacyProjects(rawJson: string | null): ProjectLegacyImportResult
  getLegacyImportMarker(): ProjectLegacyImportMarker | null
  /** Single listener (the window broadcast); fires after every persisted
   * change with the full authoritative list. */
  setChangeListener(listener: ((projects: Project[]) => void) | null): void
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

export function createProjectRegistry(deps: ProjectRegistryPersistenceDeps): ProjectRegistry {
  const now = deps.now ?? Date.now
  let changeListener: ((projects: Project[]) => void) | null = null

  const readEnvelope = (): ProjectRegistryFileV1 => {
    const raw = deps.readJson<unknown>(deps.filePath, null)
    // Tolerate every historical/corrupt shape: a bare array is treated as the
    // project list, anything unrecognizable degrades to an empty registry
    // (readJson has already preserved a .corrupt backup of unparseable files).
    if (Array.isArray(raw)) {
      return { schemaVersion: 1, projects: migrateProjects(raw, now()) }
    }
    if (!raw || typeof raw !== 'object') {
      return { schemaVersion: 1, projects: [] }
    }
    const envelope = raw as Partial<ProjectRegistryFileV1>
    const candidates = Array.isArray(envelope.projects) ? envelope.projects : []
    return {
      schemaVersion: 1,
      projects: migrateProjects(candidates, now()),
      ...(isImportMarker(envelope.legacyImport) ? { legacyImport: envelope.legacyImport } : {})
    }
  }

  const writeEnvelope = (envelope: ProjectRegistryFileV1): void => {
    deps.writeJson(deps.filePath, envelope)
  }

  const notify = (projects: Project[]): void => {
    try {
      changeListener?.(projects)
    } catch (error) {
      // The broadcast must never poison the persistence path.
      console.error('Project registry change listener failed', error)
    }
  }

  return {
    getProjects(): Project[] {
      return readEnvelope().projects
    },

    applyOp(op: ProjectOp): { projects: Project[]; changed: boolean } {
      const envelope = readEnvelope()
      const { projects, changed } = applyProjectOp(envelope.projects, op)
      if (changed) {
        writeEnvelope({ ...envelope, projects })
        notify(projects)
      }
      return { projects, changed }
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
      writeEnvelope({ schemaVersion: 1, projects: merged, legacyImport: marker })
      if (added.length > 0) notify(merged)
      return { status, importedCount: added.length, marker }
    },

    getLegacyImportMarker(): ProjectLegacyImportMarker | null {
      return readEnvelope().legacyImport ?? null
    },

    setChangeListener(listener: ((projects: Project[]) => void) | null): void {
      changeListener = listener
    }
  }
}
