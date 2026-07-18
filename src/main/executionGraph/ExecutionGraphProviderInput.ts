import { createHash } from 'node:crypto'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import {
  deepFreezeExecutionGraph,
  stableExecutionGraphStringify
} from './ExecutionGraphCompiler'

export const MAX_EXECUTION_GRAPH_PROVIDER_INPUT_BYTES = 2 * 1024 * 1024

export interface ExecutionGraphProviderInputManifest {
  readonly schemaVersion: 1
  readonly payloadDigest: string
  readonly promptDigest: string
  readonly canonicalByteLength: number
}

function canonicalProviderInput(payload: AgentRunPayload): string {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(payload)
  } catch {
    throw new Error('Execution graph provider input is not JSON-serializable.')
  }
  if (!serialized) throw new Error('Execution graph provider input is unavailable.')
  const plain = JSON.parse(serialized) as unknown
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) {
    throw new Error('Execution graph provider input must be an object.')
  }
  return stableExecutionGraphStringify(plain)
}

export function buildExecutionGraphProviderInputManifest(
  payload: AgentRunPayload
): ExecutionGraphProviderInputManifest {
  const canonical = canonicalProviderInput(payload)
  const canonicalByteLength = Buffer.byteLength(canonical, 'utf8')
  if (canonicalByteLength > MAX_EXECUTION_GRAPH_PROVIDER_INPUT_BYTES) {
    throw new Error('Execution graph provider input exceeds its durable authority limit.')
  }
  return Object.freeze({
    schemaVersion: 1,
    payloadDigest: createHash('sha256')
      .update('taskwraith.execution-graph.provider-input.v1\0')
      .update(canonical)
      .digest('hex'),
    promptDigest: createHash('sha256').update(payload.prompt).digest('hex'),
    canonicalByteLength
  })
}

export function verifyExecutionGraphProviderInputManifest(
  payload: AgentRunPayload,
  manifest: ExecutionGraphProviderInputManifest
): boolean {
  try {
    const rebuilt = buildExecutionGraphProviderInputManifest(payload)
    return (
      rebuilt.payloadDigest === manifest.payloadDigest &&
      rebuilt.promptDigest === manifest.promptDigest &&
      rebuilt.canonicalByteLength === manifest.canonicalByteLength
    )
  } catch {
    return false
  }
}

/** Freeze the exact normalized object that the provider adapter receives. */
export function freezeExecutionGraphProviderInput(
  payload: AgentRunPayload
): Readonly<AgentRunPayload> {
  return deepFreezeExecutionGraph(payload)
}
