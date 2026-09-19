import { readFile, stat } from 'node:fs/promises'
import type { AcpPermissionRequest } from '../grok/GrokAcpProtocol'
import {
  SHARED_WORKSPACE_MAX_CAPTURE_BYTES,
  isSharedWorkspaceCapturableTool
} from '../sharedWorkspace/SharedWorkspaceContributions'
import type { NativeWorkspaceToolPreflight } from './NativeWorkspaceToolGate'
import type { ProviderId } from '../store/types'

/** A refusal carrying where it came from, so a seat cannot misread it. */
export interface NativeWriteGateDenial {
  decision: 'deny'
  origin: 'host-containment' | 'host-policy' | 'human' | 'unknown'
  reason: string
}

export type NativeWriteGateDecision = 'allow' | 'deny' | NativeWriteGateDenial

/**
 * The refusal a native write receives when it is not one of the two tools this
 * journal can represent. Kept verbatim from the terminal deny it replaces, so
 * opening capture does not change what a seat is told about delete_path,
 * move_path, rename_path, create_directory or apply_patch.
 */
export const NATIVE_WRITE_UNCAPTURABLE_REASON =
  'Native mutations cannot provide TaskWraith exact-edit transactions; use an actually listed TaskWraith broker tool within the assigned scope.'

/** Admission result the gate needs to hold a lock across the provider's write. */
export interface NativeWriteAdmission {
  ok: boolean
  reason?: string
  lockOwnerId?: string
  /** Opaque handle the caller uses to release exactly this admission. */
  handle?: unknown
}

export interface NativeWriteJournalEntry {
  targetPath: string
  before: Buffer | null
  after: Buffer
  executable: boolean
  canonicalTool: string
  lockOwnerId?: string
}

export interface NativeWriteCaptureDeps {
  provider: ProviderId
  /** Canonical workspace root; every captured path is already inside it. */
  workspacePath: string
  /** Admission through the SHARED coordinator: lane scope, finality, lock. */
  admit: (input: {
    canonicalTool: string
    nativeAction: string
    rawToolCall: unknown
    paths: readonly string[]
  }) => Promise<NativeWriteAdmission>
  release: (admission: NativeWriteAdmission) => Promise<void>
  requestApproval: (approval: {
    method: string
    title: string
    body: string
    preview: unknown
    riskLabels?: string[]
  }) => Promise<boolean>
  /**
   * Binds a provider-native actor and writes ONE contribution record. Injected
   * rather than called directly so the AsyncLocalStorage binding lives with the
   * run context at the call site, and so this module is testable with a spy.
   */
  journalNativeEdit: (entry: NativeWriteJournalEntry) => Promise<void>
  readFileBytes?: (path: string) => Promise<Buffer>
  statPath?: (path: string) => Promise<{ size: number; mode: number }>
  onCaptureError?: (path: string, error: unknown) => void
}

interface HeldPath {
  before: Buffer | null
}

interface HeldWrite {
  canonicalTool: string
  admission: NativeWriteAdmission
  paths: Map<string, HeldPath>
}

/**
 * Bounded, matching the MistralAcpClient refusal map. A turn that is cancelled
 * or crashes never delivers its terminal tool_result, so entries must not be
 * able to accumulate without limit.
 */
const MAX_IN_FLIGHT = 128

function toolCallIdOf(request: AcpPermissionRequest): string | null {
  const raw = request?.rawToolCall
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  for (const key of ['toolCallId', 'toolcallid', 'tool_call_id', 'id', 'toolId']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function denial(origin: NativeWriteGateDenial['origin'], reason: string): NativeWriteGateDenial {
  return { decision: 'deny', origin, reason }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: string }).code === 'ENOENT'
}

export interface NativeWriteCapture {
  gate: (
    request: AcpPermissionRequest,
    preflight: NativeWorkspaceToolPreflight
  ) => Promise<NativeWriteGateDecision>
  settle: (toolCallId: string | null | undefined, succeeded: boolean) => Promise<void>
  /** Drop and release everything still held, for turn teardown. */
  sweep: () => Promise<void>
  inFlightCount: () => number
}

export function createNativeWriteContributionCapture(
  deps: NativeWriteCaptureDeps
): NativeWriteCapture {
  const held = new Map<string, HeldWrite>()
  const pathsInFlight = new Set<string>()
  const readBytes = deps.readFileBytes || ((path: string) => readFile(path))
  const statOne =
    deps.statPath ||
    (async (path: string) => {
      const info = await stat(path)
      return { size: info.size, mode: info.mode }
    })

  const forget = (toolCallId: string): HeldWrite | null => {
    const entry = held.get(toolCallId)
    if (!entry) return null
    held.delete(toolCallId)
    for (const path of entry.paths.keys()) pathsInFlight.delete(path)
    return entry
  }

  const gate = async (
    request: AcpPermissionRequest,
    preflight: NativeWorkspaceToolPreflight
  ): Promise<NativeWriteGateDecision> => {
    if (preflight.kind !== 'allow' || preflight.access !== 'write') {
      return denial('host-containment', NATIVE_WRITE_UNCAPTURABLE_REASON)
    }
    // The load-bearing check. `access` is 'write' for seven canonical tools and
    // this journal can represent two; the other five have no after-bytes, no
    // before-bytes, or no file bytes at all. Admitting one of them would mean a
    // mutation with no snapshot -- for delete_path, an unrecoverable removal.
    if (!isSharedWorkspaceCapturableTool(preflight.canonicalTool)) {
      return denial('host-containment', NATIVE_WRITE_UNCAPTURABLE_REASON)
    }
    const toolCallId = toolCallIdOf(request)
    if (!toolCallId) {
      // Without a correlator the settle can never find these buffers, so the
      // write would land uncaptured. Refuse rather than allow blind.
      return denial(
        'host-containment',
        'This native write carries no tool call id, so TaskWraith cannot record it for Undo.'
      )
    }
    if (held.has(toolCallId)) {
      return denial('host-containment', 'This native write is already in flight.')
    }
    const paths = preflight.checkedPaths.filter((path) => typeof path === 'string' && path.trim())
    if (paths.length === 0) {
      return denial(
        'host-containment',
        'This native write declares no verifiable workspace path, so it cannot be recorded for Undo.'
      )
    }
    for (const path of paths) {
      // Two native edits to one file inside a single parallel batch both read
      // the same `before`, and the journal's chain check then sees a break and
      // refuses Undo for BOTH. Serialise instead of silently losing the undo.
      if (pathsInFlight.has(path)) {
        return denial(
          'host-containment',
          'Another native write to this file is still in flight; retry after it settles.'
        )
      }
    }

    const captured = new Map<string, HeldPath>()
    for (const path of paths) {
      let before: Buffer | null = null
      try {
        const info = await statOne(path)
        if (info.size > SHARED_WORKSPACE_MAX_CAPTURE_BYTES) {
          return denial(
            'host-containment',
            'This file is too large for TaskWraith to snapshot, so the write cannot be recorded for Undo.'
          )
        }
        before = await readBytes(path)
      } catch (error) {
        // ONLY a genuinely absent file may become a null `before`. Any other
        // read failure -- EACCES, ELOOP, EMFILE -- must refuse, because a
        // pre-existing file journalled as a create is undone by DELETING it,
        // destroying content the journal never held.
        if (!isMissingFileError(error)) {
          deps.onCaptureError?.(path, error)
          return denial(
            'host-containment',
            'TaskWraith could not read this file to snapshot it, so the write cannot be recorded for Undo.'
          )
        }
        before = null
      }
      if (before && before.length > SHARED_WORKSPACE_MAX_CAPTURE_BYTES) {
        return denial(
          'host-containment',
          'This file is too large for TaskWraith to snapshot, so the write cannot be recorded for Undo.'
        )
      }
      captured.set(path, { before })
    }

    if (held.size >= MAX_IN_FLIGHT) {
      return denial(
        'host-containment',
        'Too many native writes are already in flight to record this one for Undo.'
      )
    }

    const admission = await deps.admit({
      canonicalTool: preflight.canonicalTool,
      nativeAction: request.toolName || preflight.canonicalTool,
      rawToolCall: request.rawToolCall,
      paths
    })
    if (!admission.ok) {
      return denial(
        'host-policy',
        admission.reason || 'This native write was not admitted by the workspace lock authority.'
      )
    }

    let approved = false
    try {
      approved = await deps.requestApproval({
        method: `${deps.provider}/native-write`,
        title: `${deps.provider} wants to edit files directly`,
        body:
          `${request.toolName || preflight.canonicalTool} will write ${paths.length} ` +
          `file${paths.length === 1 ? '' : 's'} in the workspace using the provider's own tool. ` +
          'TaskWraith snapshots each file before and after so the change stays undoable.',
        preview: { kind: 'tool', toolName: request.toolName, params: { paths } },
        riskLabels: ['native-write']
      })
    } catch {
      approved = false
    }
    if (!approved) {
      await deps.release(admission)
      // Never attributed to the user unless a human actually refused; this seam
      // cannot tell an auto-resolve from a decline, so it claims neither.
      return denial('unknown', 'This native write was not approved.')
    }

    held.set(toolCallId, {
      canonicalTool: preflight.canonicalTool,
      admission,
      paths: captured
    })
    for (const path of captured.keys()) pathsInFlight.add(path)
    return 'allow'
  }

  const settleEntry = async (entry: HeldWrite, succeeded: boolean): Promise<void> => {
    try {
      if (!succeeded) return
      for (const [path, holdState] of entry.paths) {
        let after: Buffer
        let executable = false
        try {
          after = await readBytes(path)
          // The exec bit is taken AFTER the write, because prepareEdit stamps a
          // single mode onto both sides and currentFileHash compares that mode
          // to the live file. Taking it from before the write would mark the
          // record unavailable whenever the provider changed the bit.
          const info = await statOne(path)
          executable = (info.mode & 0o111) !== 0
        } catch (error) {
          // A file that is gone after a write_file/replace was not something
          // this journal could have represented anyway; record nothing.
          if (!isMissingFileError(error)) deps.onCaptureError?.(path, error)
          continue
        }
        if (after.length > SHARED_WORKSPACE_MAX_CAPTURE_BYTES) continue
        if (holdState.before && holdState.before.equals(after)) continue
        try {
          await deps.journalNativeEdit({
            targetPath: path,
            before: holdState.before,
            after,
            executable,
            canonicalTool: entry.canonicalTool,
            lockOwnerId: entry.admission.lockOwnerId
          })
        } catch (error) {
          deps.onCaptureError?.(path, error)
        }
      }
    } finally {
      await deps.release(entry.admission)
    }
  }

  return {
    gate,
    settle: async (toolCallId, succeeded) => {
      if (!toolCallId) return
      const entry = forget(toolCallId)
      if (!entry) return
      await settleEntry(entry, succeeded)
    },
    sweep: async () => {
      const ids = [...held.keys()]
      for (const id of ids) {
        const entry = forget(id)
        // A turn that ends without a terminal result still wrote the file, so
        // attempt the capture rather than dropping it on the floor.
        if (entry) await settleEntry(entry, true)
      }
    },
    inFlightCount: () => held.size
  }
}
