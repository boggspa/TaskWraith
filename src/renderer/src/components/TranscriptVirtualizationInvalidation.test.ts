import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')

function geometryEffectDependencies(): string[] {
  const effectStart = panelSource.indexOf(
    '// Pre-paint: anchor correction (Phase 1) + slot measurement (Phase 2).'
  )
  const effectEnd = panelSource.indexOf('\n\n  const blockRef = useCallback', effectStart)
  const effectSource = panelSource.slice(effectStart, effectEnd)
  const dependencyStart = effectSource.lastIndexOf('}, [')

  expect(effectStart).toBeGreaterThanOrEqual(0)
  expect(effectEnd).toBeGreaterThan(effectStart)
  expect(dependencyStart).toBeGreaterThanOrEqual(0)

  return effectSource
    .slice(dependencyStart + 4)
    .replace(/\]\)\s*$/, '')
    .split(',')
    .map((dependency) => dependency.trim())
    .filter(Boolean)
}

describe('transcript virtualizer geometry invalidation', () => {
  it('does not force a synchronous layout pass after unrelated parent commits', () => {
    const dependencies = geometryEffectDependencies()

    expect(dependencies).toEqual(
      expect.arrayContaining([
        'measureTick',
        'scrollTick',
        'rowsStructuralKey',
        'expandedRowIds',
        'activeLiveRowKeys',
        'hiddenRowKeys',
        'virtualWindow.startIndex',
        'virtualWindow.endIndex'
      ])
    )
  })

  it('lets ResizeObserver invalidate live content growth instead of raw row projection churn', () => {
    const dependencies = geometryEffectDependencies()

    expect(dependencies).not.toContain('rows')
    expect(panelSource).toContain('const ro = new ResizeObserver(() => {')
    expect(panelSource).toContain('bumpMeasure()')
  })
})
