import { describe, expect, it } from 'vitest'
import { normalizeEnsembleMcpToolArguments } from '../../shared/taskWraithMcpCatalog'
import { normalizeMcpToolArguments } from './McpResultHelpers'
import { FIRST_CALL_SUCCESS_CORPUS } from './McpFirstCallSuccessCorpus'

describe('first-call-success corpus', () => {
  for (const testCase of FIRST_CALL_SUCCESS_CORPUS) {
    it(testCase.name, () => {
      const transported = testCase.jsonStringTransport
        ? normalizeMcpToolArguments(testCase.input)
        : testCase.input
      expect(normalizeEnsembleMcpToolArguments(testCase.toolName, transported)).toEqual(
        testCase.expected
      )
    })
  }
})
