// PreToolUse approval bridge for the official agy CLI.
//
// Official agy exposes exactly one per-tool seam: documented lifecycle hooks
// (`hooks.json` in the workspace customization root, e.g. `.agents/`). A
// PreToolUse hook receives each tool call as JSON on stdin and must print a
// decision object on stdout. This module builds the temporary named-hook
// overlay TaskWraith installs for a run, and the localhost server that turns
// each hook invocation into a real TaskWraith approval-gate decision — the
// same fast paths, tier holds, and approval cards every other provider gets.
//
// Fail-safe shape: every error path (bad token, malformed body, gate throw,
// curl/network failure, stale overlay after a crash) resolves to `{}` — "no
// decision" — which returns agy to its native confirmation flow (headless
// soft-deny). The bridge can therefore never widen permissions by failing.

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

const HOOK_NAME = 'taskwraith-approval-bridge'
/** agy default hook timeout is 30s; an attended approval card needs longer. */
const HOOK_TIMEOUT_SECONDS = 600
/** curl gives up before agy's own hook timeout so the fallback `{}` wins. */
const CURL_MAX_TIME_SECONDS = HOOK_TIMEOUT_SECONDS - 10
const MAX_REQUEST_BYTES = 512 * 1024
const TOKEN_HEX_RE = /^[0-9a-f]{32,128}$/

export interface AgyHookBridgeDecision {
  /** `none` responds `{}` — no decision, agy's native flow proceeds. */
  decision: 'allow' | 'deny' | 'none'
  reason?: string
}

export interface AgyHookToolCall {
  name: string
  command: string | null
}

export function createAgyHookBridgeToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * The named-hook object merged into the workspace `hooks.json`. The command is
 * assembled only from a validated port and hex token, so no caller-controlled
 * text can reach the shell line agy executes. `|| printf {}` keeps every curl
 * failure (bridge gone, timeout, refused) on the no-decision path.
 */
export function buildAgyHookBridgeNamedHook(input: { port: number; token: string }): {
  hookName: string
  namedHook: Record<string, unknown>
} {
  const port = input.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The agy hook bridge requires a valid localhost port.')
  }
  if (!TOKEN_HEX_RE.test(input.token)) {
    throw new Error('The agy hook bridge requires a lowercase-hex session token.')
  }
  const command = `/usr/bin/curl -sS --max-time ${CURL_MAX_TIME_SECONDS} -X POST -H 'Content-Type: application/json' -H 'X-TaskWraith-Hook-Token: ${input.token}' --data-binary @- http://127.0.0.1:${port}/agy/pretooluse || printf {}`
  return {
    hookName: HOOK_NAME,
    namedHook: {
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }]
        }
      ]
    }
  }
}

function extractToolCall(body: unknown): AgyHookToolCall | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const toolCall = (body as { toolCall?: unknown }).toolCall
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return null
  const name = (toolCall as { name?: unknown }).name
  if (typeof name !== 'string' || !name) return null
  const args = (toolCall as { args?: unknown }).args
  const commandLine =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { CommandLine?: unknown }).CommandLine
      : undefined
  return { name, command: typeof commandLine === 'string' ? commandLine : null }
}

export interface AgyHookBridgeServer {
  port: number
  /** Register a run's token; returns the matching unregister. */
  registerRun(
    token: string,
    decide: (toolCall: AgyHookToolCall) => Promise<AgyHookBridgeDecision>
  ): () => void
  close(): Promise<void>
}

/**
 * One loopback server for the app lifetime; runs register per-launch tokens.
 * Responses are ALWAYS 200 with a JSON body, because the hook prints the
 * response body verbatim to stdout — a non-decision must still be valid JSON.
 */
export async function startAgyHookBridgeServer(): Promise<AgyHookBridgeServer> {
  const runs = new Map<string, (toolCall: AgyHookToolCall) => Promise<AgyHookBridgeDecision>>()

  const server: Server = createServer((request, response) => {
    const respond = (payload: Record<string, unknown>): void => {
      const text = JSON.stringify(payload)
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text)
      })
      response.end(text)
    }

    if (request.method !== 'POST' || request.url !== '/agy/pretooluse') {
      respond({})
      return
    }
    const token = request.headers['x-taskwraith-hook-token']
    const decide = typeof token === 'string' ? runs.get(token) : undefined
    if (!decide) {
      respond({})
      return
    }

    const chunks: Buffer[] = []
    let received = 0
    let overflowed = false
    request.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_REQUEST_BYTES) {
        overflowed = true
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => {
      if (!response.writableEnded) respond({})
    })
    request.on('end', () => {
      if (overflowed) {
        respond({})
        return
      }
      let toolCall: AgyHookToolCall | null = null
      try {
        toolCall = extractToolCall(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        toolCall = null
      }
      if (!toolCall) {
        respond({})
        return
      }
      decide(toolCall).then(
        (decision) =>
          respond(
            decision.decision === 'deny'
              ? { decision: 'deny', ...(decision.reason ? { reason: decision.reason } : {}) }
              : decision.decision === 'allow'
                ? { decision: 'allow' }
                : {}
          ),
        () => respond({})
      )
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address !== 'object') {
    server.close()
    throw new Error('The agy hook bridge could not bind a loopback port.')
  }

  return {
    port: address.port,
    registerRun(token, decide) {
      if (!TOKEN_HEX_RE.test(token)) {
        throw new Error('The agy hook bridge requires a lowercase-hex session token.')
      }
      if (runs.has(token)) {
        throw new Error('The agy hook bridge token is already registered.')
      }
      runs.set(token, decide)
      return () => {
        runs.delete(token)
      }
    },
    close() {
      runs.clear()
      return new Promise((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }
}
