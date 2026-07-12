import { describe, expect, it } from 'vitest'
import { deleteCliProviderProcessIfOwned } from './GrokProcessOwnership'

describe('deleteCliProviderProcessIfOwned', () => {
  it('does not let a late run delete a newer provider process', () => {
    const runA = { pid: 1 }
    const runB = { pid: 2 }
    const processes = new Map([['grok', runA]])

    processes.set('grok', runB)

    expect(deleteCliProviderProcessIfOwned(processes, 'grok', runA)).toBe(false)
    expect(processes.get('grok')).toBe(runB)
  })

  it('deletes the fallback when the finishing run still owns it', () => {
    const owned = { pid: 1 }
    const processes = new Map([['grok', owned]])

    expect(deleteCliProviderProcessIfOwned(processes, 'grok', owned)).toBe(true)
    expect(processes.has('grok')).toBe(false)
  })
})
