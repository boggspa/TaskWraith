import { createHash } from 'crypto'
import type { RunQueueDispatchReceipt, RunQueueJob } from './store/types'

export function buildRunQueueDispatchReceipt(
  job: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider'>,
  generatedAt = new Date().toISOString()
): RunQueueDispatchReceipt {
  const source = job.source || 'manual'
  const request = job.request
  const permissionPosture = job.permissionPosture
  const remoteComposer = request?.remoteComposer
  const workflowMode =
    request?.workflowMode || permissionPosture?.workflowMode || remoteComposer?.workflowMode
  const remoteComposerReceipt = remoteComposer
    ? {
        workspaceId: optionalString(remoteComposer.workspaceId),
        threadId: optionalString(remoteComposer.threadId),
        provider: optionalString(remoteComposer.provider),
        approvalMode: optionalString(remoteComposer.approvalMode),
        workflowMode: remoteComposer.workflowMode
      }
    : undefined
  const body: Omit<RunQueueDispatchReceipt, 'receiptHash'> = {
    schemaVersion: 1,
    generatedAt,
    runId: job.runId,
    provider: job.provider,
    source,
    ...(job.scope ? { scope: job.scope } : {}),
    ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
    ...(job.chatId ? { chatId: job.chatId } : {}),
    ...(job.ensembleParticipantId ? { ensembleParticipantId: job.ensembleParticipantId } : {}),
    ...(job.ensembleLaneId ? { ensembleLaneId: job.ensembleLaneId } : {}),
    ...(job.ensembleRole ? { ensembleRole: job.ensembleRole } : {}),
    ...(job.ensembleStageRole ? { ensembleStageRole: job.ensembleStageRole } : {}),
    ...(request?.approvalMode || permissionPosture?.approvalMode || remoteComposer?.approvalMode
      ? {
          approvalMode:
            request?.approvalMode || permissionPosture?.approvalMode || remoteComposer?.approvalMode
        }
      : {}),
    ...(workflowMode ? { workflowMode } : {}),
    ...(permissionPosture?.presetId ? { permissionPresetId: permissionPosture.presetId } : {}),
    ...(typeof permissionPosture?.readOnly === 'boolean'
      ? { readOnly: permissionPosture.readOnly }
      : {}),
    ...(permissionPosture?.postureHash
      ? { permissionPostureHash: permissionPosture.postureHash }
      : {}),
    permissionPostureSignaturePresent: Boolean(permissionPosture?.signaturePresent),
    ...(remoteComposerReceipt && Object.values(remoteComposerReceipt).some(Boolean)
      ? { remoteComposer: remoteComposerReceipt }
      : {})
  }
  return {
    ...body,
    receiptHash: hashStableJson(body)
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function hashStableJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}
