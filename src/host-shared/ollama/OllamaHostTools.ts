/**
 * Host-owned native tool tier for standalone Ollama runs.
 *
 * The desktop app advertises its gateway catalogue to Ollama; the pure-Node
 * Host has no gateway, so it owns a small, honest set of workspace-rooted file
 * tools instead. Every path is resolved and realpath-checked against the
 * thread's registered workspace root: a tool call can never escape it. The
 * write set is advertised and executable only when the thread's posture permits
 * edits — the executor enforces the same allow list the model was offered, so
 * a hallucinated write on a read-only posture fails legibly instead of
 * mutating.
 */

import { realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import type { OllamaToolCall } from './OllamaChatLoop'

const READ_FILE_MAX_CHARS = 64 * 1_024
const WRITE_FILE_MAX_CHARS = 256 * 1_024
const LIST_DIR_MAX_ENTRIES = 200

export interface OllamaHostToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

const PATH_PROPERTY = {
  type: 'string',
  description: 'Path relative to the workspace root.'
} as const

/** The tool definitions offered to the daemon for the given posture. */
export function ollamaHostToolDefinitions(options: {
  readonly write: boolean
}): OllamaHostToolDefinition[] {
  const definitions: OllamaHostToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file in the workspace. Returns bounded content.',
        parameters: {
          type: 'object',
          properties: { path: PATH_PROPERTY },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List entries of a directory in the workspace (dirs carry a trailing /).',
        parameters: {
          type: 'object',
          properties: { path: { ...PATH_PROPERTY, description: 'Directory, default ".".' } }
        }
      }
    }
  ]
  if (options.write) {
    definitions.push(
      {
        type: 'function',
        function: {
          name: 'write_file',
          description:
            'Create or replace a UTF-8 text file in the workspace, creating parent directories.',
          parameters: {
            type: 'object',
            properties: { path: PATH_PROPERTY, content: { type: 'string' } },
            required: ['path', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'replace_in_file',
          description: 'Replace every occurrence of `old` with `new` in a workspace text file.',
          parameters: {
            type: 'object',
            properties: {
              path: PATH_PROPERTY,
              old: { type: 'string' },
              new: { type: 'string' }
            },
            required: ['path', 'old', 'new']
          }
        }
      }
    )
  }
  return definitions
}

/**
 * Executor for the Host-owned tool set, bound to one workspace root. `write`
 * must match what was advertised for the run's posture; disallowed or unknown
 * tools return a legible failure rather than mutating.
 */
export function createOllamaHostToolExecutor(input: {
  readonly workspaceRoot: string
  readonly write: boolean
}): (toolCall: OllamaToolCall) => Promise<{ ok: boolean; result: string }> {
  const root = canonicalRoot(input.workspaceRoot)
  const allowed = new Set(
    ollamaHostToolDefinitions({ write: input.write }).map((entry) => entry.function.name)
  )

  const resolveWithin = (requested: unknown): string | null => {
    if (typeof requested !== 'string' || !requested.trim()) return null
    const resolved = resolve(root, requested)
    if (resolved !== root && !resolved.startsWith(root + sep)) return null
    // Symlink escape guard: the real path of an existing target (or its nearest
    // existing parent for a new file) must stay inside the real workspace root.
    try {
      const existing = existingAnchor(resolved)
      if (existing) {
        const real = realpathSync(existing)
        const anchor = real === resolved ? real : resolve(real, resolved.slice(existing.length + 1))
        if (anchor !== root && !anchor.startsWith(root + sep)) return null
      }
    } catch {
      return null
    }
    return resolved
  }

  return async (toolCall) => {
    try {
      if (!allowed.has(toolCall.name)) {
        return {
          ok: false,
          result: `${toolCall.name} is not available for this thread's permission tier.`
        }
      }
      const args = toolCall.arguments
      if (toolCall.name === 'read_file') {
        const target = resolveWithin(args.path)
        if (!target) return { ok: false, result: 'read_file refused: path escapes the workspace.' }
        const content = await readFile(target, 'utf8')
        if (content.length > READ_FILE_MAX_CHARS) {
          return {
            ok: true,
            result: `${content.slice(0, READ_FILE_MAX_CHARS)}\n…(truncated at ${READ_FILE_MAX_CHARS} chars)`
          }
        }
        return { ok: true, result: content }
      }
      if (toolCall.name === 'list_dir') {
        const target = resolveWithin(args.path ?? '.')
        if (!target) return { ok: false, result: 'list_dir refused: path escapes the workspace.' }
        const entries = await readdir(target, { withFileTypes: true })
        const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        return {
          ok: true,
          result:
            names.slice(0, LIST_DIR_MAX_ENTRIES).join('\n') +
            (names.length > LIST_DIR_MAX_ENTRIES
              ? `\n…(${names.length - LIST_DIR_MAX_ENTRIES} more)`
              : '')
        }
      }
      if (toolCall.name === 'write_file') {
        const target = resolveWithin(args.path)
        if (!target) return { ok: false, result: 'write_file refused: path escapes the workspace.' }
        if (typeof args.content !== 'string') {
          return { ok: false, result: 'write_file failed: content must be a string.' }
        }
        if (args.content.length > WRITE_FILE_MAX_CHARS) {
          return {
            ok: false,
            result: `write_file refused: content exceeds ${WRITE_FILE_MAX_CHARS} chars.`
          }
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, args.content, 'utf8')
        return { ok: true, result: `write_file wrote ${args.path} (${args.content.length} chars).` }
      }
      // replace_in_file
      const target = resolveWithin(args.path)
      if (!target) {
        return { ok: false, result: 'replace_in_file refused: path escapes the workspace.' }
      }
      if (typeof args.old !== 'string' || typeof args.new !== 'string' || args.old === '') {
        return { ok: false, result: 'replace_in_file failed: old/new must be non-empty strings.' }
      }
      const current = await readFile(target, 'utf8')
      const occurrences = current.split(args.old).length - 1
      if (occurrences === 0) {
        return { ok: false, result: 'replace_in_file failed: `old` does not occur in the file.' }
      }
      await writeFile(target, current.split(args.old).join(args.new), 'utf8')
      return {
        ok: true,
        result: `replace_in_file updated ${args.path} (${occurrences} occurrence(s)).`
      }
    } catch (error) {
      return {
        ok: false,
        result: `${toolCall.name} failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

function canonicalRoot(workspaceRoot: string): string {
  try {
    return realpathSync(workspaceRoot)
  } catch {
    return resolve(workspaceRoot)
  }
}

/** Nearest existing ancestor (or the path itself) for symlink resolution. */
function existingAnchor(resolved: string): string | null {
  let candidate = resolved
  // Bound the walk; the root is at most this many levels up.
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      realpathSync(candidate)
      return candidate
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
  return null
}
