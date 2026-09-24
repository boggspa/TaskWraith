import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ApnsClient } from '../src/shared/apns/apnsSendCore'
import { sharedApnsCollapseId } from '../src/shared/e2ee/push'

export interface P7RelayTokenEntry {
  pairID: string
  macIdentityPubKey: string
  deviceTokenHex: string
  env: 'production' | 'sandbox'
  notifyFinishedTurns: boolean
}

export function selectP7TokenEntry(
  raw: unknown,
  selection: { pairId?: string; env?: string } = {}
): P7RelayTokenEntry {
  const entries =
    raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries as unknown[])
      : []
  const candidates = entries.filter((candidate): candidate is P7RelayTokenEntry => {
    if (!candidate || typeof candidate !== 'object') return false
    const entry = candidate as Record<string, unknown>
    return (
      typeof entry.pairID === 'string' &&
      typeof entry.macIdentityPubKey === 'string' &&
      typeof entry.deviceTokenHex === 'string' &&
      (entry.env === 'production' || entry.env === 'sandbox') &&
      typeof entry.notifyFinishedTurns === 'boolean' &&
      (!selection.pairId || entry.pairID === selection.pairId) &&
      (!selection.env || entry.env === selection.env)
    )
  })
  if (candidates.length !== 1) {
    throw new Error(`P7 direct send requires exactly one token row (found ${candidates.length})`)
  }
  return candidates[0]
}

export function buildP7DirectSend(input: {
  entry: P7RelayTokenEntry
  reason: 'runComplete' | 'runFailed'
  threadId: string
  runId: string
}) {
  return {
    deviceTokenHex: input.entry.deviceTokenHex,
    env: input.entry.env,
    pushType: 'alert' as const,
    priority: 10 as const,
    body: {
      aps: {
        alert: {
          title: 'TaskWraith',
          body: input.reason === 'runFailed' ? 'A task failed.' : 'A task finished.'
        },
        sound: 'default'
      }
    },
    collapseId: sharedApnsCollapseId({
      reason: input.reason,
      threadId: input.threadId,
      runId: input.runId
    })
  }
}

export async function runP7DirectSend(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.TASKWRAITH_P7_CONFIRMED !== '1') {
    throw new Error('P7 direct send requires TASKWRAITH_P7_CONFIRMED=1')
  }
  const keyPath = String(env.TASKWRAITH_P7_APNS_KEY_PATH || '')
  const keyId = String(env.TASKWRAITH_P7_APNS_KEY_ID || '')
  const teamId = String(env.TASKWRAITH_P7_APNS_TEAM_ID || '')
  const tokenTablePath = String(env.TASKWRAITH_P7_TOKEN_TABLE_PATH || '')
  const threadId = String(env.TASKWRAITH_P7_THREAD_ID || '')
  const runId = String(env.TASKWRAITH_P7_RUN_ID || '')
  const reason = env.TASKWRAITH_P7_REASON === 'runFailed' ? 'runFailed' : 'runComplete'
  if (!keyPath || !keyId || !teamId || !tokenTablePath || !threadId || !runId) {
    throw new Error('P7 direct send is missing an explicit credential, token-table, or event input')
  }
  const entry = selectP7TokenEntry(JSON.parse(readFileSync(tokenTablePath, 'utf8')), {
    pairId: env.TASKWRAITH_P7_PAIR_ID,
    env: env.TASKWRAITH_P7_APNS_ENV
  })
  const send = buildP7DirectSend({ entry, reason, threadId, runId })
  const client = new ApnsClient({
    authKeyPem: readFileSync(keyPath, 'utf8'),
    keyId,
    teamId,
    bundleId: env.TASKWRAITH_P7_APNS_BUNDLE_ID || 'com.taskwraith.companion'
  })
  const outcome = await client.send(send)
  const receipt = {
    schemaVersion: 1,
    kind: 'taskwraith-push-p7-direct-send',
    delivered: outcome.delivered,
    reason: outcome.reason ?? null,
    pairId: entry.pairID,
    environment: entry.env,
    collapseId: send.collapseId
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (!outcome.delivered) process.exitCode = 1
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  runP7DirectSend().catch((error) => {
    process.stderr.write(
      `P7 direct send failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  })
}
