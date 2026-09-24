import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('queued attachment dispatch authority integration', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const queueServiceSource = readFileSync(
    new URL('./services/RunQueueService.ts', import.meta.url),
    'utf8'
  )

  it('restores exact main-owned queue paths before renderer attachment validation', () => {
    const handler = source.indexOf("ipcMain.handle('run-agent'")
    const derive = source.indexOf('const authorityBoundPayload = deriveRendererRunPayload', handler)
    const resolve = source.indexOf('resolveMainOwnedQueuedRunAttachmentPayloadAuthority({', derive)
    const invalid = source.indexOf("queuedAttachmentAuthority.kind === 'invalid'", resolve)
    const resolved = source.indexOf("queuedAttachmentAuthority.kind === 'resolved'", invalid)
    const dispatchOwned = source.indexOf(
      'dispatchAgentRun(queuedAttachmentAuthority.payload, event)',
      resolved
    )
    const rendererGate = source.indexOf('dispatchWithAuthorizedAttachmentPaths(', dispatchOwned)

    expect(handler).toBeGreaterThan(0)
    expect(derive).toBeGreaterThan(handler)
    expect(resolve).toBeGreaterThan(derive)
    expect(invalid).toBeGreaterThan(resolve)
    expect(resolved).toBeGreaterThan(invalid)
    expect(dispatchOwned).toBeGreaterThan(resolved)
    expect(rendererGate).toBeGreaterThan(dispatchOwned)
  })

  it('wires persistent directory receipt signing, verification, and queue copying', () => {
    const stager = source.indexOf('stageAttachments: createMainOwnedRunQueueAttachmentStager({')
    const signer = source.indexOf('signDirectoryReceipt: (binding) =>', stager)
    const signCall = source.indexOf(
      'signRunQueueDirectoryAttachmentReceipt(externalGrantSigningSecret, binding)',
      signer
    )
    const compose = source.indexOf('resolveMainOwnedQueuedComposerAttachmentAuthority({')
    const verifier = source.indexOf('verifyQueueReceipt: (receipt, expected) =>', compose)
    const verifyCall = source.indexOf('verifyRunQueueDirectoryAttachmentReceipt(', verifier)
    const copy = queueServiceSource.indexOf(
      '...(value.queueReceipt ? { queueReceipt: { ...value.queueReceipt } } : {})'
    )

    expect(stager).toBeGreaterThan(0)
    expect(signer).toBeGreaterThan(stager)
    expect(signCall).toBeGreaterThan(signer)
    expect(compose).toBeGreaterThan(0)
    expect(verifier).toBeGreaterThan(compose)
    expect(verifyCall).toBeGreaterThan(verifier)
    expect(copy).toBeGreaterThan(0)
  })

  it('keeps directory receipt minting and live replay on sender-local picker paths', () => {
    const queueRegistration = source.indexOf('registerRunQueueHandlers({')
    const pickerResolver = source.indexOf(
      'resolveSenderDirectoryPickerPaths: (event) =>',
      queueRegistration
    )
    const pickerRead = source.indexOf(
      'attachmentCapabilityRegistry.getAuthorizedPathsForRenderer(event.sender.id, {',
      pickerResolver
    )
    const excludesMain = source.indexOf('includeMainAuthority: false', pickerRead)
    const compose = source.indexOf('resolveMainOwnedQueuedComposerAttachmentAuthority({')
    const replayPickerPaths = source.indexOf('authorizedDirectoryPickerPaths:', compose)
    const replayRead = source.indexOf(
      'attachmentCapabilityRegistry.getAuthorizedPathsForRenderer(event.sender.id, {',
      replayPickerPaths
    )
    const replayExcludesMain = source.indexOf('includeMainAuthority: false', replayRead)

    expect(queueRegistration).toBeGreaterThan(0)
    expect(pickerResolver).toBeGreaterThan(queueRegistration)
    expect(pickerRead).toBeGreaterThan(pickerResolver)
    expect(excludesMain).toBeGreaterThan(pickerRead)
    expect(compose).toBeGreaterThan(0)
    expect(replayPickerPaths).toBeGreaterThan(compose)
    expect(replayRead).toBeGreaterThan(replayPickerPaths)
    expect(replayExcludesMain).toBeGreaterThan(replayRead)
  })
})
