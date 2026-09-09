import { describe, expect, it } from 'vitest'
import { customModelPickerSelectionId, withSavedCustomModelRows } from './customModelPickerRows'

const CURATED = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 (3B Param)' },
  { id: 'custom', label: 'Custom model ID' }
]

const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id)

describe('withSavedCustomModelRows', () => {
  it('lists saved ids directly above the entry row', () => {
    const rows = withSavedCustomModelRows({ ollama: ['qwen3-coder:30b'] }, 'ollama', CURATED)
    expect(ids(rows)).toEqual([
      'qwen3:4b-instruct',
      'llama3.2:3b',
      'custom:qwen3-coder:30b',
      'custom'
    ])
  })

  it('labels a saved row with the bare model id', () => {
    const rows = withSavedCustomModelRows({ ollama: ['qwen3-coder:30b'] }, 'ollama', CURATED)
    expect(rows.find((row) => row.id === 'custom:qwen3-coder:30b')?.label).toBe('qwen3-coder:30b')
  })

  it('keeps saved rows in save order', () => {
    const rows = withSavedCustomModelRows({ ollama: ['a:1', 'b:2', 'c:3'] }, 'ollama', CURATED)
    expect(ids(rows).slice(2, 5)).toEqual(['custom:a:1', 'custom:b:2', 'custom:c:3'])
  })

  it('returns the catalogue untouched when the provider has nothing saved', () => {
    expect(withSavedCustomModelRows({ codex: ['x:1'] }, 'ollama', CURATED)).toBe(CURATED)
    expect(withSavedCustomModelRows({}, 'ollama', CURATED)).toBe(CURATED)
    expect(withSavedCustomModelRows(null, 'ollama', CURATED)).toBe(CURATED)
  })

  it("does not leak one provider's saved ids into another", () => {
    const rows = withSavedCustomModelRows(
      { ollama: ['mine:1'], codex: ['theirs:1'] },
      'ollama',
      CURATED
    )
    expect(ids(rows)).toContain('custom:mine:1')
    expect(ids(rows)).not.toContain('custom:theirs:1')
  })

  it('appends when the catalogue has no entry row', () => {
    const noEntry = [{ id: 'llama3.2:3b', label: 'Llama 3.2' }]
    expect(ids(withSavedCustomModelRows({ ollama: ['a:1'] }, 'ollama', noEntry))).toEqual([
      'llama3.2:3b',
      'custom:a:1'
    ])
  })

  it('preserves the extra fields a real picker row carries', () => {
    const rich = [{ id: 'llama3.2:3b', label: 'Llama 3.2', disabled: true }]
    const rows = withSavedCustomModelRows({ ollama: ['a:1'] }, 'ollama', rich)
    expect(rows[0]).toEqual({ id: 'llama3.2:3b', label: 'Llama 3.2', disabled: true })
  })
})

describe('customModelPickerSelectionId', () => {
  const saved = { ollama: ['qwen3-coder:30b'] }

  it('moves the check mark to the saved row when its id is in use', () => {
    expect(customModelPickerSelectionId(saved, 'ollama', 'custom', 'qwen3-coder:30b')).toBe(
      'custom:qwen3-coder:30b'
    )
  })

  it('keeps the entry row checked while an uncommitted id is being typed', () => {
    expect(customModelPickerSelectionId(saved, 'ollama', 'custom', 'qwen3-cod')).toBe('custom')
    expect(customModelPickerSelectionId(saved, 'ollama', 'custom', '')).toBe('custom')
  })

  it('keeps the entry row checked for a saved id belonging to another provider', () => {
    expect(
      customModelPickerSelectionId({ codex: ['theirs:1'] }, 'ollama', 'custom', 'theirs:1')
    ).toBe('custom')
  })

  it('leaves a catalogue selection alone', () => {
    expect(customModelPickerSelectionId(saved, 'ollama', 'llama3.2:3b', 'qwen3-coder:30b')).toBe(
      'llama3.2:3b'
    )
  })
})
