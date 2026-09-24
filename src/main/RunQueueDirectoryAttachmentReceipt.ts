import { createHmac, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

import type { ProviderId, RunQueueDirectoryAttachmentReceipt } from './store/types'

const RECEIPT_DOMAIN = 'taskwraith:run-queue-directory-attachment:v1\n'
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i

export interface RunQueueDirectoryAttachmentReceiptBinding {
  canonicalPath: string
  runId: string
  chatId: string
  workspaceId: string | null
  workspacePath: string | null
  provider: ProviderId
}

function exactIdentity(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && value === value.trim()
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
}

function validBinding(value: RunQueueDirectoryAttachmentReceiptBinding): boolean {
  if (
    !value ||
    !absolutePath(value.canonicalPath) ||
    !exactIdentity(value.runId) ||
    !exactIdentity(value.chatId) ||
    !exactIdentity(value.provider)
  ) {
    return false
  }
  const globalBinding = value.workspaceId === null && value.workspacePath === null
  const workspaceBinding = exactIdentity(value.workspaceId) && absolutePath(value.workspacePath)
  return globalBinding || workspaceBinding
}

function signingPayload(binding: RunQueueDirectoryAttachmentReceiptBinding): string {
  return `${RECEIPT_DOMAIN}${JSON.stringify({
    schemaVersion: 1,
    canonicalPath: binding.canonicalPath,
    runId: binding.runId,
    chatId: binding.chatId,
    workspaceId: binding.workspaceId,
    workspacePath: binding.workspacePath,
    provider: binding.provider
  })}`
}

function assertSigningSecret(secret: Buffer): void {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 32) {
    throw new Error('Run queue directory attachment receipt secret is unavailable.')
  }
}

export function runQueueDirectoryAttachmentReceiptMatchesBinding(
  receipt: RunQueueDirectoryAttachmentReceipt,
  binding: RunQueueDirectoryAttachmentReceiptBinding
): boolean {
  return Boolean(
    validBinding(binding) &&
    receipt?.schemaVersion === 1 &&
    receipt.canonicalPath === binding.canonicalPath &&
    receipt.runId === binding.runId &&
    receipt.chatId === binding.chatId &&
    receipt.workspaceId === binding.workspaceId &&
    receipt.workspacePath === binding.workspacePath &&
    receipt.provider === binding.provider &&
    SIGNATURE_PATTERN.test(receipt.signature || '')
  )
}

/** Mint a queue-local directory receipt using main's persistent HMAC root. */
export function signRunQueueDirectoryAttachmentReceipt(
  secret: Buffer,
  binding: RunQueueDirectoryAttachmentReceiptBinding
): RunQueueDirectoryAttachmentReceipt {
  assertSigningSecret(secret)
  if (!validBinding(binding)) {
    throw new Error('Run queue directory attachment receipt binding is invalid.')
  }
  return {
    schemaVersion: 1,
    ...binding,
    signature: createHmac('sha256', secret).update(signingPayload(binding)).digest('hex')
  }
}

/**
 * Verify both HMAC integrity and the exact current queue-job binding. No
 * process-local execution registry participates in this decision.
 */
export function verifyRunQueueDirectoryAttachmentReceipt(
  secret: Buffer,
  receipt: RunQueueDirectoryAttachmentReceipt,
  expected: RunQueueDirectoryAttachmentReceiptBinding
): boolean {
  try {
    assertSigningSecret(secret)
    if (!runQueueDirectoryAttachmentReceiptMatchesBinding(receipt, expected)) return false
    const actual = Buffer.from(receipt.signature, 'hex')
    const computed = Buffer.from(
      createHmac('sha256', secret).update(signingPayload(expected)).digest('hex'),
      'hex'
    )
    return actual.byteLength === computed.byteLength && timingSafeEqual(actual, computed)
  } catch {
    return false
  }
}
