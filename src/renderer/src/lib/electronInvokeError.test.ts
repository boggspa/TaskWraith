import { describe, expect, it } from 'vitest'
import { stripElectronInvokeErrorFraming } from './electronInvokeError'

describe('stripElectronInvokeErrorFraming', () => {
  it('removes Electron invoke framing and its nested Error prefix', () => {
    expect(
      stripElectronInvokeErrorFraming(
        new Error(
          "Error invoking remote method 'execution-runs:formalize': Error: Graph is unavailable."
        )
      )
    ).toBe('Graph is unavailable.')
  })

  it('preserves errors that do not carry Electron invoke framing', () => {
    expect(stripElectronInvokeErrorFraming(new Error('Graph is unavailable.'))).toBe(
      'Graph is unavailable.'
    )
  })
})
