import { describe, expect, it } from 'vitest'
import {
  MCP_READ_FILE_WINDOW_DEFAULT_LINES,
  MCP_READ_FILE_WINDOW_MAX_LINES
} from '../index.constants'
import { windowReadFileText } from './ReadFileWindow'

const numbered = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line-${index + 1}`).join('\n')

describe('windowReadFileText', () => {
  it('returns the text byte-identical when neither offset nor limit is given', () => {
    const text = 'a\r\nb\nc\n'
    expect(windowReadFileText(text, {})).toBe(text)
    expect(windowReadFileText(text, { offset: undefined, limit: undefined })).toBe(text)
  })

  it('ignores non-numeric, zero, and negative window args (whole file)', () => {
    const text = numbered(5)
    expect(windowReadFileText(text, { offset: 'x', limit: null })).toBe(text)
    expect(windowReadFileText(text, { offset: 0 })).toBe(text)
    expect(windowReadFileText(text, { limit: -3 })).toBe(text)
  })

  it('windows offset+limit with a header naming the window and the total', () => {
    const result = windowReadFileText(numbered(10), { offset: 3, limit: 2 })
    expect(result).toBe('[read_file: lines 3-4 of 10]\nline-3\nline-4')
  })

  it('limit alone starts at line 1', () => {
    const result = windowReadFileText(numbered(10), { limit: 2 })
    expect(result).toBe('[read_file: lines 1-2 of 10]\nline-1\nline-2')
  })

  it('offset alone applies the default window size', () => {
    const total = MCP_READ_FILE_WINDOW_DEFAULT_LINES + 10
    const result = windowReadFileText(numbered(total), { offset: 6 })
    const header = result.split('\n', 1)[0]
    expect(header).toBe(
      `[read_file: lines 6-${5 + MCP_READ_FILE_WINDOW_DEFAULT_LINES} of ${total}]`
    )
  })

  it('clamps limit to the window cap', () => {
    const total = MCP_READ_FILE_WINDOW_MAX_LINES + 50
    const result = windowReadFileText(numbered(total), { offset: 1, limit: total })
    const header = result.split('\n', 1)[0]
    expect(header).toBe(`[read_file: lines 1-${MCP_READ_FILE_WINDOW_MAX_LINES} of ${total}]`)
  })

  it('a window running past EOF returns the available tail', () => {
    const result = windowReadFileText(numbered(4), { offset: 3, limit: 10 })
    expect(result).toBe('[read_file: lines 3-4 of 4]\nline-3\nline-4')
  })

  it('an offset past EOF is an explicit empty-window notice, not an error', () => {
    const result = windowReadFileText(numbered(4), { offset: 99, limit: 5 })
    expect(result).toBe('[read_file: offset 5 is past the end of the file (4 lines)]')
  })

  it('fractional args truncate to whole lines', () => {
    const result = windowReadFileText(numbered(10), { offset: 2.9, limit: 1.9 })
    expect(result).toBe('[read_file: lines 2-2 of 10]\nline-2')
  })
})
