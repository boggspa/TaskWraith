import fsSync from 'fs'
import {
  createDocumentToolExecutors,
  type DocumentToolContext,
  type DocumentToolExecutors,
  type DocumentOcrBlock
} from '../mcp/DocumentToolExecutors'
import { extractPdfText, MAX_PDF_BYTES } from './PdfTextExtractor'
import {
  openAuthorizedWorkspaceFile,
  TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES,
  type StageWorkspaceMediaSnapshotOptions,
  type StagedWorkspaceMediaSnapshotResult
} from '../services/TranscriptMediaService'

/**
 * Host wiring for the document tools, kept OUT of index.ts.
 *
 * index.ts is the repo's biggest hotspot and is already over its
 * architecture-guard budget, so the parts of this feature that only need
 * collaborators (rather than index.ts's module state) live here. index.ts
 * supplies the two things it genuinely owns — run authorization and the mutable
 * bridge-daemon handle — through `deps`.
 */

/** Everything the tools need to know about where a call is allowed to read. */
export interface DocumentToolAuthorization {
  workspacePath: string
  /** Run-scoped grants for paths outside the workspace root. */
  externalPathGrants: readonly any[]
}

export interface DocumentToolWiringDeps {
  /**
   * Resolve the workspace + run grants for a tool call, or null when the chat has
   * no workspace. index.ts owns this because it holds the run manager.
   */
  authorize: (ctx: DocumentToolContext) => DocumentToolAuthorization | null
  /** JSON-RPC into the bridge daemon. Injected because the handle is mutable. */
  requestDaemon: <T>(method: string, params: unknown, options: { timeoutMs: number }) => Promise<T>
  /**
   * Stage a workspace file to a main-owned snapshot. Injected rather than called
   * directly: index.ts's wrapper opens a SYNCHRONOUS regenerable-history-byte
   * reservation around the staging, and every staged path must go through it.
   */
  stageImage: (
    options: Omit<StageWorkspaceMediaSnapshotOptions, 'stagingDirectory'>
  ) => Promise<StagedWorkspaceMediaSnapshotResult>
  /** Native capability snapshot — gates the macOS-only Vision OCR path. */
  isOcrAvailable: () => { available: boolean; reason?: string }
}

export function createWiredDocumentToolExecutors(
  deps: DocumentToolWiringDeps
): DocumentToolExecutors {
  return createDocumentToolExecutors({
    // Authorize + size-cap + magic-byte check + READ in one step, straight off the
    // descriptor openAuthorizedWorkspaceFile returns. Deliberately NOT
    // jail-then-reopen-by-path: that leaves a TOCTOU window where the validated
    // file can be swapped for one outside the workspace before the read lands.
    readPdfBytes: async (sourcePath, ctx) => {
      const auth = deps.authorize(ctx)
      if (!auth) return { ok: false, reason: 'no workspace to resolve sourcePath' }
      const opened = openAuthorizedWorkspaceFile({
        workspacePath: auth.workspacePath,
        candidatePath: sourcePath,
        externalPathGrants: auth.externalPathGrants,
        maxBytes: MAX_PDF_BYTES
      })
      if (!opened.ok) return { ok: false, reason: opened.reason }
      try {
        const size = opened.stat.size
        if (size <= 0) return { ok: false, reason: 'unsupported' }
        const buffer = Buffer.alloc(size)
        // Explicit position 0 — never trust the descriptor's implicit offset.
        const bytesRead = fsSync.readSync(opened.fd, buffer, 0, size, 0)
        const data = buffer.subarray(0, bytesRead)
        // Magic-byte check on the SAME bytes we just authorized and read, mirroring
        // how the media validators sniff rather than trusting the extension.
        if (!data.subarray(0, 5).equals(Buffer.from('%PDF-', 'latin1'))) {
          return { ok: false, reason: 'unsupported' }
        }
        return { ok: true, data: new Uint8Array(data) }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'unreadable' }
      } finally {
        try {
          fsSync.closeSync(opened.fd)
        } catch {
          // descriptor already gone — nothing to reclaim
        }
      }
    },
    // The daemon opens the image itself, so this one DOES need a path — staged to a
    // main-owned snapshot (kind 'image' sniffs raster mime and rejects SVG), which
    // is what makes handing a path across the process boundary safe.
    jailImage: async (sourcePath, ctx) => {
      const auth = deps.authorize(ctx)
      if (!auth) return { ok: false, reason: 'no workspace to resolve sourcePath' }
      const staged = await deps.stageImage({
        workspacePath: auth.workspacePath,
        candidatePath: sourcePath,
        externalPathGrants: auth.externalPathGrants,
        maxBytes: TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES,
        kind: 'image'
      })
      return staged.ok
        ? { ok: true, realPath: staged.realPath, cleanup: staged.cleanup }
        : { ok: false, reason: staged.reason }
    },
    extractText: (options) => extractPdfText(options),
    ocrImage: (params) =>
      deps.requestDaemon<{ text: string; blocks: DocumentOcrBlock[] }>(
        'document.ocrImage',
        params,
        { timeoutMs: 60_000 }
      ),
    ocrAvailable: () => deps.isOcrAvailable()
  })
}
