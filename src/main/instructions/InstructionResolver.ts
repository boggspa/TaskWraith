import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import {
  INSTRUCTION_LAYER_MAX_BYTES,
  WORKSPACE_INSTRUCTIONS_FILE,
  type InstructionSkipReason,
  type ResolvedInstructionContext,
  type ResolvedInstructionLayer
} from '../../shared/instructions/InstructionTypes'

export const GLOBAL_INSTRUCTIONS_SOURCE_LABEL = 'Settings → Custom Instructions'

/**
 * Bidi override/isolate controls (U+202A–U+202E, U+2066–U+2069): the
 * Trojan-Source class — text that renders differently than it parses.
 * C0 controls other than tab/newline/CR have no place in an instruction
 * document either. Both refuse the layer whole; nothing is stripped.
 * Escaped forms only — a literal control byte in source trips the
 * control-byte CI guard and flips the file to binary in git diffs.
 */
const UNSAFE_CHARS_RE =
  // eslint-disable-next-line no-control-regex -- refusing controls is the point
  /[\u202A-\u202E\u2066-\u2069\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export interface InstructionResolverInput {
  /** settings.customInstructionsEnabled !== false */
  enabled: boolean
  /** The global document body (InstructionStore.readGlobalDocument().content). */
  globalContent: string
  /** Absolute workspace root for workspace-scoped runs; null/undefined for
   * global (General-chat) runs, which simply have no workspace layer. */
  workspacePath?: string | null
}

function realpathNative(input: string): string {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(input)
    : fs.realpathSync(input)
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Strip a UTF-8 BOM (benign), normalize CRLF, trim outer whitespace. */
function normalizeInstructionText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function appliedLayer(
  scope: ResolvedInstructionLayer['scope'],
  source: string,
  normalized: string,
  bytes: number
): ResolvedInstructionLayer {
  return {
    scope,
    source,
    status: 'applied',
    sha256: sha256Hex(normalized),
    bytes,
    content: normalized
  }
}

function skippedLayer(
  scope: ResolvedInstructionLayer['scope'],
  source: string,
  skipReason: InstructionSkipReason,
  bytes?: number
): ResolvedInstructionLayer {
  return {
    scope,
    source,
    status: 'skipped',
    skipReason,
    ...(bytes === undefined ? {} : { bytes })
  }
}

/** Shared content gate for both layers: size → UTF-8 → unsafe characters. */
function classifyContent(
  scope: ResolvedInstructionLayer['scope'],
  source: string,
  buffer: Buffer
): ResolvedInstructionLayer {
  if (buffer.byteLength > INSTRUCTION_LAYER_MAX_BYTES) {
    return skippedLayer(scope, source, 'too_large', buffer.byteLength)
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return skippedLayer(scope, source, 'invalid_utf8', buffer.byteLength)
  }
  const normalized = normalizeInstructionText(decoded)
  if (!normalized) {
    return { scope, source, status: 'absent', bytes: buffer.byteLength }
  }
  if (UNSAFE_CHARS_RE.test(normalized)) {
    return skippedLayer(scope, source, 'unsafe_characters', buffer.byteLength)
  }
  return appliedLayer(scope, source, normalized, buffer.byteLength)
}

function resolveGlobalLayer(globalContent: string): ResolvedInstructionLayer {
  return classifyContent(
    'global',
    GLOBAL_INSTRUCTIONS_SOURCE_LABEL,
    Buffer.from(globalContent ?? '', 'utf8')
  )
}

function resolveWorkspaceLayer(workspacePath: string): ResolvedInstructionLayer {
  const source = WORKSPACE_INSTRUCTIONS_FILE
  let realRoot: string
  try {
    realRoot = realpathNative(path.resolve(workspacePath))
  } catch {
    return skippedLayer('workspace', source, 'unreadable')
  }
  const filePath = path.join(realRoot, WORKSPACE_INSTRUCTIONS_FILE)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    return { scope: 'workspace', source, status: 'absent' }
  }
  if (stat.isSymbolicLink()) {
    return skippedLayer('workspace', source, 'symlink_refused', stat.size)
  }
  if (!stat.isFile()) {
    return skippedLayer('workspace', source, 'unreadable', stat.size)
  }
  // Containment: the file's canonical location must remain under the
  // canonical workspace root. lstat above already refused a link at the
  // leaf; this catches intermediate-hop escapes on unusual roots.
  try {
    const realFile = realpathNative(filePath)
    if (!pathWithinRoot(realFile, realRoot)) {
      return skippedLayer('workspace', source, 'outside_workspace', stat.size)
    }
  } catch {
    return skippedLayer('workspace', source, 'unreadable', stat.size)
  }
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch {
    return skippedLayer('workspace', source, 'unreadable', stat.size)
  }
  return classifyContent('workspace', source, buffer)
}

/**
 * Resolve the user's instruction layers for a run. Pure over its inputs plus
 * the workspace file's on-disk state; never throws. The result is snapshotted
 * with the run — post-dispatch inspection reads the snapshot, not the disk.
 */
export function resolveInstructionContext(
  input: InstructionResolverInput
): ResolvedInstructionContext {
  const workspacePath =
    typeof input.workspacePath === 'string' && input.workspacePath.trim()
      ? input.workspacePath
      : null

  if (!input.enabled) {
    const layers: ResolvedInstructionLayer[] = [
      { scope: 'global', source: GLOBAL_INSTRUCTIONS_SOURCE_LABEL, status: 'disabled' },
      ...(workspacePath
        ? [
            {
              scope: 'workspace',
              source: WORKSPACE_INSTRUCTIONS_FILE,
              status: 'disabled'
            } satisfies ResolvedInstructionLayer
          ]
        : [])
    ]
    return { layers, digest: 'none', enabled: false }
  }

  const layers: ResolvedInstructionLayer[] = [resolveGlobalLayer(input.globalContent)]
  if (workspacePath) layers.push(resolveWorkspaceLayer(workspacePath))

  const applied = layers.filter((layer) => layer.status === 'applied')
  const digest =
    applied.length === 0
      ? 'none'
      : sha256Hex(applied.map((layer) => `${layer.scope}:${layer.sha256}`).join('\n'))

  return { layers, digest, enabled: true }
}
