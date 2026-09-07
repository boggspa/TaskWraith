import { describe, expect, it } from 'vitest'

import {
  buildCursorPathBBrokerReceipt,
  cursorPathBAllowRulesPermitTool,
  listCursorPathBReceiptTools
} from './CursorPathBBrokerReceipt'

describe('listCursorPathBReceiptTools', () => {
  it('lists capability_search on gateway-v1 but not on taskwraith-full-v1', () => {
    const wildcard = ['Mcp(taskwraith-broker:*)']
    expect(
      listCursorPathBReceiptTools({
        allowRules: wildcard,
        taskWraithMcpProfileId: 'taskwraith-gateway-v1'
      })
    ).toContain('capability_search')
    expect(
      listCursorPathBReceiptTools({
        allowRules: wildcard,
        taskWraithMcpProfileId: 'taskwraith-full-v1'
      })
    ).not.toContain('capability_search')
  })

  it('accepts colon and hyphen allow-rule forms', () => {
    expect(
      cursorPathBAllowRulesPermitTool(
        ['Mcp(taskwraith-broker:ask_user_question)'],
        'ask_user_question'
      )
    ).toBe(true)
    expect(
      cursorPathBAllowRulesPermitTool(
        ['Mcp(taskwraith-broker-ask_user_question)'],
        'ask_user_question'
      )
    ).toBe(true)
    expect(
      cursorPathBAllowRulesPermitTool(['Mcp(taskwraith-broker:read_file)'], 'ask_user_question')
    ).toBe(false)
  })
})

describe('buildCursorPathBBrokerReceipt', () => {
  it('forbids the legacy taskwraith-cursor server id alongside IDE discovery APIs', () => {
    const receipt = buildCursorPathBBrokerReceipt({ listedTools: ['ask_user_question'] })
    expect(receipt).toContain('GetMcpTools')
    expect(receipt).toContain('taskwraith-broker')
    expect(receipt).toContain('GetDynamicTools')
    expect(receipt).toContain('CallDynamicTool')
    expect(receipt).toMatch(/`taskwraith-cursor`/)
    expect(receipt).toContain('ask_user_question')
  })

  it('falls back when the listed set is empty', () => {
    const receipt = buildCursorPathBBrokerReceipt({ listedTools: [] })
    expect(receipt).toContain('none beyond what GetMcpTools returns')
  })
})
