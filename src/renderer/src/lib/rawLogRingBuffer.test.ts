import { describe, expect, it } from 'vitest'
import type { RawLogEntry } from './rawLogEntry'
import { RawLogRingBuffer } from './rawLogRingBuffer'

function entry(content: string): RawLogEntry {
  return { type: 'stdout', content }
}

describe('RawLogRingBuffer', () => {
  it('keeps chronological order while overwriting the oldest entry', () => {
    const ring = new RawLogRingBuffer(3)
    ring.append(entry('one'))
    ring.append(entry('two'))
    ring.append(entry('three'))
    ring.append(entry('four'))

    expect(ring.size).toBe(3)
    expect(ring.snapshot().map((item) => item.content)).toEqual(['two', 'three', 'four'])
  })

  it('replaces with only the newest capacity-sized suffix', () => {
    const ring = new RawLogRingBuffer(2)
    ring.replace([entry('one'), entry('two'), entry('three')])

    expect(ring.snapshot().map((item) => item.content)).toEqual(['two', 'three'])
  })
})
