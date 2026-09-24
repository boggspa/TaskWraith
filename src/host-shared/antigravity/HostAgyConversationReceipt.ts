import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOST_AGY_SESSION_PREFIX = 'agy-project-v1:'

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RECEIPT_BYTES = 1024 * 1024

export interface HostAgyConversationReceiptDependencies {
  readonly read?: (path: string) => Promise<string>
  readonly resolve?: (path: string) => Promise<string>
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

function conversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return CONVERSATION_ID.test(normalized) ? normalized : null
}

export function formatHostAgySessionId(value: unknown): string | null {
  const id = conversationId(value)
  return id ? `${HOST_AGY_SESSION_PREFIX}${id}` : null
}

export function parseHostAgySessionId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(HOST_AGY_SESSION_PREFIX)) return null
  return conversationId(value.slice(HOST_AGY_SESSION_PREFIX.length))
}

function expandHome(value: string, home: string): string {
  return value.startsWith('~') ? join(home, value.slice(1)) : value
}

export function hostAgyConversationReceiptPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string {
  const configuredHome = environment.GEMINI_CLI_HOME?.trim()
  const configuredRoot = environment.GEMINI_HOME?.trim()
  const root = configuredHome
    ? join(expandHome(configuredHome, home), '.gemini')
    : configuredRoot
      ? expandHome(configuredRoot, home)
      : join(home, '.gemini')
  return join(root, 'antigravity-cli', 'cache', 'last_conversations.json')
}

export function parseHostAgyConversationReceipt(
  raw: string,
  candidateWorkspacePaths: readonly string[]
): string | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const path of candidateWorkspacePaths) {
    const id = conversationId(record[path])
    if (id) return id
  }
  return null
}

/** Best-effort non-secret receipt read after an agy turn. */
export async function readHostAgyConversationReceipt(
  workspacePath: string,
  dependencies: HostAgyConversationReceiptDependencies = {}
): Promise<string | null> {
  const workspace = workspacePath.trim()
  if (!workspace) return null
  let canonical: string | null = null
  try {
    canonical = await (dependencies.resolve ?? realpath)(workspace)
  } catch {
    canonical = null
  }
  try {
    const raw = await (dependencies.read ?? ((path) => readFile(path, 'utf8')))(
      hostAgyConversationReceiptPath(dependencies.env, dependencies.home)
    )
    const candidates = [
      ...new Set([workspace, canonical].filter((value): value is string => Boolean(value)))
    ]
    return formatHostAgySessionId(parseHostAgyConversationReceipt(raw, candidates))
  } catch {
    return null
  }
}
