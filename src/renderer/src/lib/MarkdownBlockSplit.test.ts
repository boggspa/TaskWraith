import { describe, expect, it } from 'vitest'
import { splitMarkdownIntoBlocks } from './MarkdownBlockSplit'

describe('splitMarkdownIntoBlocks', () => {
  it('returns empty split for empty content', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('')
    expect(stable).toEqual([])
    expect(tail).toBeNull()
  })

  it('treats a single paragraph as the tail (no trailing blank)', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('Hello world')
    expect(stable).toEqual([])
    expect(tail).not.toBeNull()
    expect(tail?.raw).toBe('Hello world')
    expect(tail?.type).toBe('paragraph')
    expect(tail?.complete).toBe(true)
  })

  it('splits two paragraphs separated by a blank line into stable + tail', () => {
    // Stable blocks have their raw normalised to end with a single \n
    // (regardless of how many blank lines actually separated them in
    // the source). This is what makes the append-only contract robust
    // — a stable block's raw doesn't depend on what comes after it.
    const { stable, tail } = splitMarkdownIntoBlocks('A\n\nB')
    expect(stable).toHaveLength(1)
    expect(stable[0].raw).toBe('A\n')
    expect(stable[0].type).toBe('paragraph')
    expect(tail?.raw).toBe('B')
    expect(tail?.complete).toBe(true)
  })

  it('commits both paragraphs to stable when content ends on a blank line', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('A\n\nB\n\n')
    expect(stable).toHaveLength(2)
    expect(stable[0].raw).toBe('A\n')
    expect(stable[1].raw).toBe('B\n')
    expect(tail).toBeNull()
  })

  it('marks an open fenced code block as the tail with complete=false', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('Intro paragraph\n\n```ts\nconst x = 1')
    expect(stable).toHaveLength(1)
    expect(stable[0].raw).toBe('Intro paragraph\n')
    expect(stable[0].type).toBe('paragraph')
    expect(tail).not.toBeNull()
    expect(tail?.type).toBe('code')
    expect(tail?.complete).toBe(false)
    expect(tail?.raw.startsWith('```ts')).toBe(true)
  })

  it('marks a closed fenced code block as stable with complete=true', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('```ts\nconst x = 1\n```')
    expect(stable).toHaveLength(1)
    expect(stable[0].type).toBe('code')
    expect(stable[0].complete).toBe(true)
    // Normalised to end with a single \n.
    expect(stable[0].raw).toBe('```ts\nconst x = 1\n```\n')
    expect(tail).toBeNull()
  })

  it('classifies an ATX heading block', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('# Title\n\nbody')
    expect(stable).toHaveLength(1)
    expect(stable[0].type).toBe('heading')
    expect(stable[0].complete).toBe(true)
    expect(stable[0].raw).toBe('# Title\n')
    expect(tail?.raw).toBe('body')
  })

  it('classifies a list block, leaving the in-progress list as the tail', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('- one\n- two')
    expect(stable).toEqual([])
    expect(tail?.type).toBe('list')
    expect(tail?.raw).toBe('- one\n- two')
    expect(tail?.complete).toBe(true)
  })

  it('marks a completed list block as stable when followed by a blank line', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('- one\n- two\n\nnext')
    expect(stable).toHaveLength(1)
    expect(stable[0].type).toBe('list')
    expect(stable[0].raw).toBe('- one\n- two\n')
    expect(tail?.raw).toBe('next')
  })

  it('classifies a GFM table (header row + separator row) as type=table', () => {
    const { stable, tail } = splitMarkdownIntoBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter')
    expect(stable).toHaveLength(1)
    expect(stable[0].type).toBe('table')
    expect(tail?.raw).toBe('after')
  })

  it('maintains append-only stability for stable block ids across grow steps', () => {
    // Start with "A\n\nB" — "A" (normalised to "A\n") is the stable
    // block. Capture its id.
    const step1 = splitMarkdownIntoBlocks('A\n\nB')
    expect(step1.stable).toHaveLength(1)
    const aId = step1.stable[0].id
    const tailIdAtStep1 = step1.tail?.id
    expect(aId).toBeTruthy()
    expect(tailIdAtStep1).toBeTruthy()

    // Append "C" — tail grows to "BC" but the stable "A\n" id MUST
    // stay identical. This is the property React.memo relies on for
    // short-circuit on the stable prefix.
    const step2 = splitMarkdownIntoBlocks('A\n\nBC')
    expect(step2.stable).toHaveLength(1)
    expect(step2.stable[0].id).toBe(aId)
    expect(step2.tail?.id).not.toBe(tailIdAtStep1)

    // Append more chars to close the second paragraph and start a new
    // tail. "A\n\nBC\n\nD": "A\n" AND the now-finished "BC\n" are
    // both stable, and their ids must match what a fresh call to the
    // splitter would produce for those exact raws.
    const step3 = splitMarkdownIntoBlocks('A\n\nBC\n\nD')
    expect(step3.stable).toHaveLength(2)
    expect(step3.stable[0].id).toBe(aId)
    // The "BC\n" id is the djb2 of that normalised raw — deterministic.
    // Verify by hashing the same raw via a second split where we KNOW
    // that raw is in stable position.
    const direct = splitMarkdownIntoBlocks('BC\n\nE')
    expect(direct.stable).toHaveLength(1)
    expect(direct.stable[0].raw).toBe('BC\n')
    expect(step3.stable[1].id).toBe(direct.stable[0].id)
    expect(step3.tail?.raw).toBe('D')
  })

  it('keeps a closed code fence stable across trailing-newline keystrokes', () => {
    // After the closing ``` lands, the user may type \n, then \n\n,
    // then start a new paragraph. The code block's stable id should
    // NOT flicker across these — it's normalised to a single trailing
    // newline regardless of what blank-line padding follows.
    const step1 = splitMarkdownIntoBlocks('```\ncode\n```')
    expect(step1.stable).toHaveLength(1)
    expect(step1.stable[0].type).toBe('code')
    const codeId = step1.stable[0].id

    const step2 = splitMarkdownIntoBlocks('```\ncode\n```\n')
    expect(step2.stable[0].id).toBe(codeId)

    const step3 = splitMarkdownIntoBlocks('```\ncode\n```\n\n')
    expect(step3.stable[0].id).toBe(codeId)

    const step4 = splitMarkdownIntoBlocks('```\ncode\n```\n\nA')
    expect(step4.stable[0].id).toBe(codeId)
    expect(step4.tail?.raw).toBe('A')
  })

  it('produces deterministic ids — same content yields same ids on repeated calls', () => {
    const input = 'Para one\n\nPara two\n\n```\ncode\n```\n'
    const a = splitMarkdownIntoBlocks(input)
    const b = splitMarkdownIntoBlocks(input)
    expect(a.stable.map((c) => c.id)).toEqual(b.stable.map((c) => c.id))
    expect(a.tail?.id ?? null).toBe(b.tail?.id ?? null)
  })

  it('stable.length (the tail key) is constant within a block and grows only on commit', () => {
    // MarkdownMessage keys the streaming tail by `tail-${stable.length}` so
    // the tail re-renders IN PLACE while one block grows (key unchanged) and
    // only remounts when a block commits (key changes). Lock that progression.
    const len = (c: string) => splitMarkdownIntoBlocks(c).stable.length
    // Intra-block growth of the first paragraph → stable.length stays 0.
    expect(len('Hel')).toBe(0)
    expect(len('Hello')).toBe(0)
    expect(len('Hello wor')).toBe(0)
    // Blank-line commit → stable.length increments; a fresh tail begins.
    expect(len('Hello world\n\nN')).toBe(1)
    // Second block grows in place → stable.length stays 1.
    expect(len('Hello world\n\nNext par')).toBe(1)
    // An open code fence is the tail (not yet committed) → still 1.
    expect(len('Hello world\n\n```ts\nx')).toBe(1)
    // A closed fence is a commit boundary → stable.length increments.
    expect(len('Hello world\n\n```ts\nx\n```\n\nafter')).toBe(2)
  })
})
