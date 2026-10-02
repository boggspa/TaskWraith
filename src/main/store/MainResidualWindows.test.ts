import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MainDurabilityResiduals } from './MainDurabilityResiduals'
import { createMainResidualWindows } from './MainResidualWindows'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { createIncrementalChatPersistence } from './IncrementalChatPersistence'
import type { ChatRecord } from './types'

describe('actual residual baseline observer', () => {
  it('counts a real journal baseline check with private same-label window custody', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'residual-baseline-'))
    const collector = new MainDurabilityResiduals('private-process', () => 10)
    const windows = createMainResidualWindows(collector)
    const observer = collector.enroll(['baselineVerifies'])
    const persistence = createIncrementalChatPersistence({
      journal: createIncrementalChatJournal(root),
      residualObserver: observer
    })
    const before = {
      appChatId: 'chat',
      title: 'before',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runs: [],
      persistenceRevision: 1
    } as ChatRecord
    const after = { ...before, title: 'after', persistenceRevision: 2 }
    try {
      windows.begin('label')
      collector.snapshot('label') // Same-label runtime diagnostics cannot replace the issued baseline.
      persistence.persist(before, after, 'normal')
      const delta = windows.end('label')
      expect(delta.counters.baselineVerifies).toBe(1)
      expect(delta.complete).toBe(false)
      expect(delta.counters.orphanReclaims).toBeNull()
      for (const file of fs.readdirSync(root)) {
        const bytes = fs.readFileSync(path.join(root, file), 'utf8')
        expect(bytes).not.toContain('private-process')
        expect(bytes).not.toContain('residualObserver')
      }
      expect(() => windows.begin('../bad')).toThrow()
      windows.begin('cancelled')
      windows.cancel()
      expect(() => windows.end('cancelled')).toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
