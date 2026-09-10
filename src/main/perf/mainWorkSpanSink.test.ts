import { describe, expect, it } from 'vitest'
import { bindMainWorkSpanSink, mainWorkSpanSink } from './mainWorkSpanSink'

describe('mainWorkSpanSink', () => {
  it('binds and clears the process sink', () => {
    const previous = mainWorkSpanSink()
    const sink = { record: () => undefined }
    bindMainWorkSpanSink(sink)
    expect(mainWorkSpanSink()).toBe(sink)
    bindMainWorkSpanSink(undefined)
    expect(mainWorkSpanSink()).toBeUndefined()
    bindMainWorkSpanSink(previous)
  })
})
