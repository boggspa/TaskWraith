import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RegenerableHistoryByteStore,
  type RegenerableHistoryByteStoreOptions
} from './RegenerableHistoryByteStore'

const temporaryRoots: string[] = []

function createFixture(overrides: Partial<RegenerableHistoryByteStoreOptions> = {}): {
  temp: string
  media: string
  pdf: string
  journal: string
  store: RegenerableHistoryByteStore
} {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-derived-history-'))
  temporaryRoots.push(temp)
  const media = path.join(temp, 'media-staging')
  const pdf = path.join(temp, 'pdf-page-cache')
  const journal = path.join(temp, '.derived-purge.json')
  return {
    temp,
    media,
    pdf,
    journal,
    store: new RegenerableHistoryByteStore({
      roots: { media, pdf },
      journalPath: journal,
      ...overrides
    })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('RegenerableHistoryByteStore', () => {
  it('purges legacy bytes before first startup admission and creates private generations', async () => {
    const fixture = createFixture()
    fs.mkdirSync(fixture.media, { mode: 0o700 })
    fs.mkdirSync(fixture.pdf, { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.media, 'composer-dictation-old.wav'), 'secret')
    fs.writeFileSync(path.join(fixture.pdf, 'page-old.png'), 'secret')

    await fixture.store.initializeStrict()

    const media = fixture.store.begin('media')
    const pdf = fixture.store.begin('pdf')
    expect(media.root).toMatch(/media-staging[/\\]g-/)
    expect(pdf.root).toMatch(/pdf-page-cache[/\\]g-/)
    expect(media.generationId).toBe(pdf.generationId)
    expect(fs.existsSync(path.join(fixture.media, 'composer-dictation-old.wav'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.pdf, 'page-old.png'))).toBe(false)
    expect(fs.statSync(media.root).mode & 0o777).toBe(0o700)
    expect(fixture.store.end(media)).toBe(true)
    expect(fixture.store.end(pdf)).toBe(true)
  })

  it('closes same-tick admission and joins an already admitted operation before purge', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const active = fixture.store.begin('media')
    fs.writeFileSync(path.join(active.root, 'active.wav'), 'secret')

    const hold = fixture.store.beginHistoryMutation('operation-a')
    expect(() => fixture.store.begin('pdf')).toThrow(/admission is closed/)
    expect(fixture.store.isCurrent(active)).toBe(false)

    let purged = false
    const purging = fixture.store.purgeStrict(hold).then(() => {
      purged = true
    })
    await Promise.resolve()
    expect(purged).toBe(false)
    expect(fs.existsSync(active.root)).toBe(true)

    expect(fixture.store.end(active)).toBe(true)
    await purging
    expect(fs.existsSync(fixture.media)).toBe(false)
    expect(fs.existsSync(fixture.pdf)).toBe(false)

    expect(fixture.store.endHistoryMutation(hold)).toBe(true)
    const next = fixture.store.begin('media')
    expect(next.generationId).not.toBe(active.generationId)
    expect(fixture.store.end(next)).toBe(true)
  })

  it('does not allow an acquisition rollback to cancel a strict purge in progress', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    const hold = fixture.store.beginHistoryMutation('operation-purge-cancel')
    const purge = fixture.store.purgeStrict(hold)
    await Promise.resolve()

    expect(() => fixture.store.cancelHistoryMutation(hold)).toThrow(/cannot be cancelled/)
    fixture.store.end(reservation)
    await purge
    fixture.store.endHistoryMutation(hold)
  })

  it('rejects forged releases and release before strict purge', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('pdf')
    expect(fixture.store.end({ ...reservation } as typeof reservation)).toBe(false)
    expect(fixture.store.end(reservation)).toBe(true)

    const hold = fixture.store.beginHistoryMutation('operation-a')
    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(/before strict purge/)
    await fixture.store.purgeStrict(hold)
    expect(fixture.store.endHistoryMutation(hold)).toBe(true)
  })

  it('does not reopen admission after an indeterminate journal durability result', async () => {
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_journal_write' &&
          detail.operationId === 'operation-journal' &&
          !injected
        ) {
          injected = true
          throw new Error('injected post-rename journal failure')
        }
      }
    })
    await fixture.store.initializeStrict()

    expect(() => fixture.store.beginHistoryMutation('operation-journal')).toThrow(
      'injected post-rename journal failure'
    )
    expect(() => fixture.store.begin('media')).toThrow(/admission is closed/)
    expect(() => fixture.store.beginHistoryMutation('different-operation')).toThrow(
      /operation-journal/
    )

    const recoveredHold = fixture.store.beginHistoryMutation('operation-journal')
    await fixture.store.purgeStrict(recoveredHold)
    fixture.store.endHistoryMutation(recoveredHold)
    const admitted = fixture.store.begin('media')
    fixture.store.end(admitted)
  })

  it('retains the durable admission fence when a wider hold acquisition rolls back', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const firstHold = fixture.store.beginHistoryMutation('operation-retry')
    expect(fixture.store.cancelHistoryMutation(firstHold)).toBe(true)
    expect(() => fixture.store.begin('media')).toThrow(/admission is closed/)
    expect(() => fixture.store.beginHistoryMutation('different-operation')).toThrow(
      /operation-retry/
    )

    const retryHold = fixture.store.beginHistoryMutation('operation-retry')
    await fixture.store.purgeStrict(retryHold)
    fixture.store.endHistoryMutation(retryHold)
    const admitted = fixture.store.begin('pdf')
    fixture.store.end(admitted)
  })

  it.each(['root symlink', 'child symlink', 'child hardlink'] as const)(
    'fails closed on an unsafe %s without changing the outside peer',
    async (unsafeKind) => {
      const fixture = createFixture()
      await fixture.store.initializeStrict()
      const reservation = fixture.store.begin('media')
      expect(fixture.store.end(reservation)).toBe(true)
      const outside = path.join(fixture.temp, 'outside-secret')
      fs.writeFileSync(outside, 'keep-me')

      if (unsafeKind === 'root symlink') {
        fs.rmSync(fixture.media, { recursive: true })
        const outsideDirectory = path.join(fixture.temp, 'outside-directory')
        fs.mkdirSync(outsideDirectory)
        fs.symlinkSync(outsideDirectory, fixture.media)
      } else if (unsafeKind === 'child symlink') {
        fs.symlinkSync(outside, path.join(reservation.root, 'linked-secret'))
      } else {
        fs.linkSync(outside, path.join(reservation.root, 'hardlinked-secret'))
      }

      if (unsafeKind === 'root symlink') {
        expect(() => fixture.store.beginHistoryMutation(`operation-${unsafeKind}`)).toThrow(
          /symlink|unsafe/
        )
      } else {
        const hold = fixture.store.beginHistoryMutation(`operation-${unsafeKind}`)
        await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(
          unsafeKind === 'child hardlink' ? /multiple hard links/ : /symlink|unsafe/
        )
      }
      expect(fs.readFileSync(outside, 'utf8')).toBe('keep-me')
      expect(() => fixture.store.begin('pdf')).toThrow(/admission is closed/)
    }
  )

  it('refuses even a dangling symlink at the deterministic quarantine path', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const operationId = 'operation-quarantine-link'
    const digest = createHash('sha256').update(operationId).digest('hex').slice(0, 32)
    const quarantine = path.join(fixture.temp, `.media-staging.history-purge-${digest}`)
    fs.symlinkSync(path.join(fixture.temp, 'missing-outside-target'), quarantine)

    const hold = fixture.store.beginHistoryMutation(operationId)
    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(/symlink|unsafe/)
    expect(fs.lstatSync(quarantine).isSymbolicLink()).toBe(true)
    expect(() => fixture.store.begin('media')).toThrow(/admission is closed/)
  })

  it('does not adopt a same-uid replacement for an active generation path', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'original.wav'), 'original')
    const savedGeneration = path.join(fixture.temp, 'saved-generation')
    fs.renameSync(reservation.root, savedGeneration)
    fs.mkdirSync(reservation.root, { mode: 0o700 })
    fs.writeFileSync(path.join(reservation.root, 'unrelated.wav'), 'unrelated')

    expect(fixture.store.isCurrent(reservation)).toBe(false)
    expect(fixture.store.end(reservation)).toBe(true)
    expect(() => fixture.store.begin('media')).toThrow(/generation identity changed/)
    expect(fs.readFileSync(path.join(savedGeneration, 'original.wav'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(reservation.root, 'unrelated.wav'), 'utf8')).toBe('unrelated')
  })

  it('fails closed when a managed root is swapped after its identity is journaled', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'original.wav'), 'original')
    fixture.store.end(reservation)
    const hold = fixture.store.beginHistoryMutation('operation-root-swap')
    const savedRoot = path.join(fixture.temp, 'saved-media-root')
    fs.renameSync(fixture.media, savedRoot)
    fs.mkdirSync(fixture.media, { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.media, 'unrelated.wav'), 'unrelated')

    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(/root identity changed/)
    expect(fs.readFileSync(path.join(fixture.media, 'unrelated.wav'), 'utf8')).toBe('unrelated')
    expect(
      fs.readFileSync(path.join(savedRoot, reservation.generationId, 'original.wav'), 'utf8')
    ).toBe('original')
  })

  it('never adopts a replacement root after the first mutation capture fails', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'original.wav'), 'original')
    fixture.store.end(reservation)
    const savedRoot = path.join(fixture.temp, 'saved-before-capture')
    fs.renameSync(fixture.media, savedRoot)
    fs.mkdirSync(fixture.media, { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.media, 'replacement.wav'), 'replacement')

    expect(() => fixture.store.beginHistoryMutation('operation-capture-failure')).toThrow(
      /base identity changed/
    )
    expect(fs.existsSync(fixture.journal)).toBe(true)
    expect(() => fixture.store.beginHistoryMutation('operation-capture-failure')).toThrow(
      /base identity changed/
    )
    expect(() => fixture.store.beginHistoryMutation('different-operation')).toThrow(
      /operation-capture-failure/
    )
    expect(fs.readFileSync(path.join(fixture.media, 'replacement.wav'), 'utf8')).toBe('replacement')
    expect(
      fs.readFileSync(path.join(savedRoot, reservation.generationId, 'original.wav'), 'utf8')
    ).toBe('original')

    const restarted = new RegenerableHistoryByteStore({
      roots: { media: fixture.media, pdf: fixture.pdf },
      journalPath: fixture.journal
    })
    await expect(restarted.initializeStrict('operation-capture-failure')).rejects.toThrow(
      /root identity changed/
    )
    expect(fs.readFileSync(path.join(fixture.media, 'replacement.wav'), 'utf8')).toBe('replacement')
    expect(
      fs.readFileSync(path.join(savedRoot, reservation.generationId, 'original.wav'), 'utf8')
    ).toBe('original')
  })

  it('does not treat a journaled root moved away before purge as already deleted', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'original.wav'), 'original')
    fixture.store.end(reservation)
    const hold = fixture.store.beginHistoryMutation('operation-root-missing')
    const escapedRoot = path.join(fixture.temp, 'escaped-media-root')
    fs.renameSync(fixture.media, escapedRoot)

    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(/disappeared before purge/)
    expect(
      fs.readFileSync(path.join(escapedRoot, reservation.generationId, 'original.wav'), 'utf8')
    ).toBe('original')
    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(/before strict purge/)
  })

  it('fails closed when a file gains an outside hard link at the unlink boundary', async () => {
    let outsideLink = ''
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'before_file_unlink' &&
          detail.operationId === 'operation-unlink-race' &&
          detail.filePath &&
          !injected
        ) {
          injected = true
          fs.linkSync(detail.filePath, outsideLink)
        }
      }
    })
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    const stagedFile = path.join(reservation.root, 'secret.wav')
    fs.writeFileSync(stagedFile, 'secret')
    fixture.store.end(reservation)
    outsideLink = path.join(fixture.temp, 'outside-hardlink')
    const hold = fixture.store.beginHistoryMutation('operation-unlink-race')

    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(/multiple hard links/)
    expect(fs.readFileSync(outsideLink, 'utf8')).toBe('secret')
    expect(fs.existsSync(fixture.journal)).toBe(true)
    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(/before strict purge/)
  })

  it('refuses a replacement quarantine on crash recovery without traversing it', async () => {
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_root_rename' &&
          detail.operationId === 'operation-quarantine-swap' &&
          detail.kind === 'media' &&
          !injected
        ) {
          injected = true
          throw new Error('injected quarantine crash')
        }
      }
    })
    await fixture.store.initializeStrict()
    const reservation = fixture.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'original.wav'), 'original')
    fixture.store.end(reservation)
    const hold = fixture.store.beginHistoryMutation('operation-quarantine-swap')
    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow('injected quarantine crash')

    const digest = createHash('sha256')
      .update('operation-quarantine-swap')
      .digest('hex')
      .slice(0, 32)
    const quarantine = path.join(fixture.temp, `.media-staging.history-purge-${digest}`)
    const savedQuarantine = path.join(fixture.temp, 'saved-quarantine')
    fs.renameSync(quarantine, savedQuarantine)
    fs.mkdirSync(quarantine, { mode: 0o700 })
    fs.writeFileSync(path.join(quarantine, 'unrelated.wav'), 'unrelated')

    const recovered = new RegenerableHistoryByteStore({
      roots: { media: fixture.media, pdf: fixture.pdf },
      journalPath: fixture.journal
    })
    await expect(recovered.initializeStrict('operation-quarantine-swap')).rejects.toThrow(
      /quarantine identity changed/
    )
    expect(fs.readFileSync(path.join(quarantine, 'unrelated.wav'), 'utf8')).toBe('unrelated')
    expect(
      fs.readFileSync(path.join(savedQuarantine, reservation.generationId, 'original.wav'), 'utf8')
    ).toBe('original')
  })

  it('recovers a crash immediately after root-to-quarantine rename', async () => {
    let injected = false
    const base = createFixture({
      testHook: (step, detail) => {
        if (step === 'after_root_rename' && detail.operationId === 'operation-crash' && !injected) {
          injected = true
          throw new Error('injected rename crash')
        }
      }
    })
    await base.store.initializeStrict()
    const reservation = base.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'secret.wav'), 'secret')
    base.store.end(reservation)
    const hold = base.store.beginHistoryMutation('operation-crash')

    await expect(base.store.purgeStrict(hold)).rejects.toThrow('injected rename crash')
    expect(fs.existsSync(base.journal)).toBe(true)

    const recovered = new RegenerableHistoryByteStore({
      roots: { media: base.media, pdf: base.pdf },
      journalPath: base.journal
    })
    await recovered.initializeStrict('operation-crash')
    expect(() => recovered.begin('media')).toThrow(/admission is closed/)
    const recoveredHold = recovered.beginHistoryMutation('operation-crash')
    await recovered.purgeStrict(recoveredHold)
    recovered.endHistoryMutation(recoveredHold)
    const next = recovered.begin('media')
    expect(fs.existsSync(next.root)).toBe(true)
    recovered.end(next)
  })

  it('recovers when content purge finishes before the per-root phase receipt', async () => {
    let injected = false
    const base = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_content_purge' &&
          detail.operationId === 'operation-content-crash' &&
          detail.kind === 'media' &&
          !injected
        ) {
          injected = true
          throw new Error('injected content-purge crash')
        }
      }
    })
    await base.store.initializeStrict()
    const reservation = base.store.begin('media')
    fs.writeFileSync(path.join(reservation.root, 'secret.wav'), 'secret')
    base.store.end(reservation)
    const hold = base.store.beginHistoryMutation('operation-content-crash')
    await expect(base.store.purgeStrict(hold)).rejects.toThrow('injected content-purge crash')

    const recovered = new RegenerableHistoryByteStore({
      roots: { media: base.media, pdf: base.pdf },
      journalPath: base.journal
    })
    await recovered.initializeStrict('operation-content-crash')
    const recoveredHold = recovered.beginHistoryMutation('operation-content-crash')
    await recovered.purgeStrict(recoveredHold)
    recovered.endHistoryMutation(recoveredHold)
    const next = recovered.begin('media')
    expect(fs.existsSync(path.join(next.root, 'secret.wav'))).toBe(false)
    recovered.end(next)
  })

  it('retries an interrupted second-root purge without issuing a partial completion', async () => {
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_root_rename' &&
          detail.operationId === 'operation-partial' &&
          detail.kind === 'pdf' &&
          !injected
        ) {
          injected = true
          throw new Error('injected PDF purge failure')
        }
      }
    })
    await fixture.store.initializeStrict()
    const media = fixture.store.begin('media')
    const pdf = fixture.store.begin('pdf')
    fs.writeFileSync(path.join(media.root, 'media.bin'), 'media')
    fs.writeFileSync(path.join(pdf.root, 'page.png'), 'pdf')
    fixture.store.end(media)
    fixture.store.end(pdf)
    const hold = fixture.store.beginHistoryMutation('operation-partial')

    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow('injected PDF purge failure')
    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(/before strict purge/)

    await fixture.store.purgeStrict(hold)
    expect(fixture.store.endHistoryMutation(hold)).toBe(true)
    expect(fs.existsSync(fixture.journal)).toBe(false)
  })

  it('rechecks every root after awaited sibling purge work before global completion', async () => {
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_root_purge' &&
          detail.operationId === 'operation-reappearance' &&
          detail.kind === 'pdf' &&
          !injected
        ) {
          injected = true
          fs.mkdirSync(fixture.media, { mode: 0o700 })
          fs.writeFileSync(path.join(fixture.media, 'reappeared.bin'), 'history')
        }
      }
    })
    await fixture.store.initializeStrict()
    const hold = fixture.store.beginHistoryMutation('operation-reappearance')

    await expect(fixture.store.purgeStrict(hold)).rejects.toThrow(/reappeared before completion/)
    expect(fs.readFileSync(path.join(fixture.media, 'reappeared.bin'), 'utf8')).toBe('history')
    expect(JSON.parse(fs.readFileSync(fixture.journal, 'utf8')).state).toBe('pending')
    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(/before strict purge/)
  })

  it('never aliases a late writer path into the next generation', async () => {
    const fixture = createFixture()
    await fixture.store.initializeStrict()
    const first = fixture.store.begin('media')
    const oldRoot = first.root
    fixture.store.end(first)
    const firstHold = fixture.store.beginHistoryMutation('operation-first')
    await fixture.store.purgeStrict(firstHold)
    fixture.store.endHistoryMutation(firstHold)

    const second = fixture.store.begin('media')
    expect(second.root).not.toBe(oldRoot)
    expect(() => fs.writeFileSync(path.join(oldRoot, 'late.wav'), 'late')).toThrow()

    // Even a misbehaving detached writer which recreates all old parents is
    // isolated under the unguessable old generation and never adopted.
    fs.mkdirSync(oldRoot, { recursive: true })
    fs.writeFileSync(path.join(oldRoot, 'late.wav'), 'late')
    expect(fs.existsSync(path.join(second.root, 'late.wav'))).toBe(false)
    fixture.store.end(second)

    const secondHold = fixture.store.beginHistoryMutation('operation-second')
    await fixture.store.purgeStrict(secondHold)
    expect(fs.existsSync(oldRoot)).toBe(false)
    fixture.store.endHistoryMutation(secondHold)
  })

  it('keeps a recovered outer mutation fenced until its exact coordinator hold commits', async () => {
    const fixture = createFixture()
    fs.mkdirSync(fixture.media, { mode: 0o700 })
    fs.mkdirSync(fixture.pdf, { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.media, 'secret.wav'), 'secret')
    const identity = (filePath: string) => {
      const stat = fs.lstatSync(filePath)
      return { dev: String(stat.dev), ino: String(stat.ino) }
    }
    fs.writeFileSync(
      fixture.journal,
      `${JSON.stringify({
        version: 1,
        operationId: 'outer-op',
        state: 'pending',
        roots: {
          media: { base: identity(fixture.media), phase: 'present' },
          pdf: { base: identity(fixture.pdf), phase: 'present' }
        }
      })}\n`,
      { mode: 0o600 }
    )

    await fixture.store.initializeStrict('outer-op')
    expect(() => fixture.store.begin('media')).toThrow(/admission is closed/)
    expect(() => fixture.store.beginHistoryMutation('different-op')).toThrow(/outer-op/)

    const hold = fixture.store.beginHistoryMutation('outer-op')
    await fixture.store.purgeStrict(hold)
    fixture.store.endHistoryMutation(hold)
    const admitted = fixture.store.begin('media')
    fixture.store.end(admitted)
  })

  it('recovers again after startup purges bytes while the outer deletion remains pending', async () => {
    const fixture = createFixture()
    fs.mkdirSync(fixture.media, { mode: 0o700 })
    fs.mkdirSync(fixture.pdf, { mode: 0o700 })
    fs.writeFileSync(path.join(fixture.media, 'secret.wav'), 'secret')

    await fixture.store.initializeStrict('outer-restart-op')
    expect(fs.existsSync(fixture.journal)).toBe(true)
    expect(fs.existsSync(fixture.media)).toBe(false)

    const restarted = new RegenerableHistoryByteStore({
      roots: { media: fixture.media, pdf: fixture.pdf },
      journalPath: fixture.journal
    })
    await restarted.initializeStrict('outer-restart-op')
    const hold = restarted.beginHistoryMutation('outer-restart-op')
    await restarted.purgeStrict(hold)
    restarted.endHistoryMutation(hold)
    const admitted = restarted.begin('media')
    restarted.end(admitted)
  })

  it('restarts cleanly after generation creation fails after the completed journal retires', async () => {
    let injected = false
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step === 'after_generation_create' &&
          detail.operationId === 'operation-generation-crash' &&
          !injected
        ) {
          injected = true
          throw new Error('injected post-generation crash')
        }
      }
    })
    await fixture.store.initializeStrict()
    const hold = fixture.store.beginHistoryMutation('operation-generation-crash')
    await fixture.store.purgeStrict(hold)

    expect(() => fixture.store.endHistoryMutation(hold)).toThrow('injected post-generation crash')
    expect(fs.existsSync(fixture.journal)).toBe(false)

    const recovered = new RegenerableHistoryByteStore({
      roots: { media: fixture.media, pdf: fixture.pdf },
      journalPath: fixture.journal
    })
    await recovered.initializeStrict()
    const next = recovered.begin('pdf')
    expect(fs.existsSync(next.root)).toBe(true)
    recovered.end(next)
  })

  it.each(['growth', 'same-size mutation'] as const)(
    'rejects same-inode journal %s during an exact descriptor read',
    async (mutationKind) => {
      const fixture = createFixture()
      const operationId = `operation-journal-${mutationKind.replaceAll(' ', '-')}`
      await fixture.store.initializeStrict(operationId)
      const originalIdentity = fs.lstatSync(fixture.journal)
      let injected = false
      const recovered = new RegenerableHistoryByteStore({
        roots: { media: fixture.media, pdf: fixture.pdf },
        journalPath: fixture.journal,
        testHook: (step) => {
          if (step !== 'after_journal_bytes_read' || injected) return
          injected = true
          if (mutationKind === 'growth') {
            fs.appendFileSync(fixture.journal, ' ')
            return
          }
          const fd = fs.openSync(fixture.journal, 'r+')
          try {
            fs.writeSync(fd, Buffer.from(' '), 0, 1, 0)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
        }
      })

      await expect(recovered.initializeStrict(operationId)).rejects.toThrow(
        /journal changed during read/
      )
      const mutatedIdentity = fs.lstatSync(fixture.journal)
      expect(mutatedIdentity.ino).toBe(originalIdentity.ino)
      if (process.platform !== 'win32') {
        expect(mutatedIdentity.dev).toBe(originalIdentity.dev)
      }
      expect(injected).toBe(true)
      expect(() => recovered.begin('media')).toThrow(/startup recovery failed/)
    }
  )

  it('refuses an identical-content journal replacement at operation-bound retirement', async () => {
    let injected = false
    let displacedJournal = ''
    const fixture = createFixture({
      testHook: (step, detail) => {
        if (
          step !== 'before_journal_unlink' ||
          detail.operationId !== 'operation-retirement-replacement' ||
          injected
        ) {
          return
        }
        injected = true
        displacedJournal = path.join(fixture.temp, 'displaced-derived-purge.json')
        fs.renameSync(fixture.journal, displacedJournal)
        fs.copyFileSync(displacedJournal, fixture.journal)
        fs.chmodSync(fixture.journal, 0o600)
      }
    })
    await fixture.store.initializeStrict()
    const hold = fixture.store.beginHistoryMutation('operation-retirement-replacement')
    await fixture.store.purgeStrict(hold)
    const receiptContent = fs.readFileSync(fixture.journal)
    const receiptIdentity = fs.lstatSync(fixture.journal)

    expect(() => fixture.store.endHistoryMutation(hold)).toThrow(
      /changed before operation-bound retirement/
    )
    expect(injected).toBe(true)
    expect(fs.existsSync(fixture.journal)).toBe(true)
    expect(fs.existsSync(displacedJournal)).toBe(true)
    expect(fs.readFileSync(fixture.journal)).toEqual(receiptContent)
    expect(fs.readFileSync(displacedJournal)).toEqual(receiptContent)
    expect(fs.lstatSync(fixture.journal).ino).not.toBe(receiptIdentity.ino)
    expect(() => fixture.store.begin('media')).toThrow(/admission is closed/)
  })

  it('fails closed on a malformed or link-backed recovery journal', async () => {
    const malformed = createFixture()
    fs.writeFileSync(malformed.journal, '{nope}\n', { mode: 0o600 })
    await expect(malformed.store.initializeStrict()).rejects.toThrow(/malformed/)
    expect(() => malformed.store.begin('media')).toThrow(/startup recovery failed/)

    const linked = createFixture()
    const outside = path.join(linked.temp, 'outside-journal')
    fs.writeFileSync(outside, '{}')
    fs.symlinkSync(outside, linked.journal)
    await expect(linked.store.initializeStrict()).rejects.toThrow(/not a regular file/)
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}')
  })
})
