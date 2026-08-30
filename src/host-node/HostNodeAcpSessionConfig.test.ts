import { describe, expect, it, vi } from 'vitest'

import {
  createHostAcpSessionConfigApplicator,
  hostAcpModelAndEffortSelections,
  readHostAcpAdvertisedConfigOptions
} from './HostNodeAcpSessionConfig'

const KIMI_ADVERTISED = {
  sessionId: 'session-1',
  configOptions: [
    {
      id: 'model',
      currentValue: 'kimi-code/kimi-for-coding',
      options: [
        { value: 'kimi-code/kimi-for-coding' },
        { value: 'kimi-code/k3' },
        { value: 'kimi-code/k3-256k' }
      ]
    },
    {
      id: 'thinking',
      currentValue: 'high',
      options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }]
    },
    {
      id: 'mode',
      currentValue: 'default',
      options: [{ value: 'default' }, { value: 'plan' }, { value: 'ask' }]
    }
  ]
}

describe('HostNodeAcpSessionConfig', () => {
  it('reads advertised option ids and values from a session result', () => {
    expect(readHostAcpAdvertisedConfigOptions(KIMI_ADVERTISED).map((option) => option.id)).toEqual([
      'model',
      'thinking',
      'mode'
    ])
  })

  it('selects model plus thinking with a reasoning alternate id', () => {
    expect(
      hostAcpModelAndEffortSelections({ modelValue: 'kimi-code/k3', reasoningId: 'max' })
    ).toEqual([
      { configId: 'model', values: ['kimi-code/k3'] },
      { configId: 'thinking', values: ['max'], alternateIds: ['reasoning'] }
    ])
  })

  it('prompts immediately when the session result advertises no config surface', () => {
    const write = vi.fn()
    const onWarning = vi.fn()
    const onComplete = vi.fn()
    const applicator = createHostAcpSessionConfigApplicator({ write, onWarning, onComplete })
    applicator.begin({
      sessionId: 'session-1',
      result: { sessionId: 'session-1' },
      selections: hostAcpModelAndEffortSelections({
        modelValue: 'kimi-code/k3',
        reasoningId: 'high'
      })
    })
    expect(write).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('re-asserts the picker over a persisted model and maps reasoning onto thinking', () => {
    const write = vi.fn()
    const onWarning = vi.fn()
    const onComplete = vi.fn()
    const applicator = createHostAcpSessionConfigApplicator({ write, onWarning, onComplete })
    applicator.begin({
      sessionId: 'session-1',
      result: KIMI_ADVERTISED,
      selections: hostAcpModelAndEffortSelections({
        modelValue: 'kimi-code/k3',
        reasoningId: 'max'
      })
    })
    expect(onComplete).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]).toEqual([
      1000,
      'session/set_config_option',
      { sessionId: 'session-1', configId: 'model', value: 'kimi-code/k3' }
    ])

    expect(
      applicator.acceptFrame({
        id: 1000,
        result: {
          configOptions: [
            {
              id: 'model',
              currentValue: 'kimi-code/k3',
              options: [{ value: 'kimi-code/k3' }]
            },
            {
              id: 'thinking',
              currentValue: 'high',
              options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }]
            }
          ]
        }
      })
    ).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]).toEqual([
      1001,
      'session/set_config_option',
      { sessionId: 'session-1', configId: 'thinking', value: 'max' }
    ])

    expect(
      applicator.acceptFrame({
        id: 1001,
        result: {
          configOptions: [
            {
              id: 'thinking',
              currentValue: 'max',
              options: [{ value: 'max' }]
            }
          ]
        }
      })
    ).toBe(true)
    expect(onWarning).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('skips a selection that is already current and keeps going', () => {
    const write = vi.fn()
    const onComplete = vi.fn()
    const applicator = createHostAcpSessionConfigApplicator({
      write,
      onWarning: vi.fn(),
      onComplete
    })
    applicator.begin({
      sessionId: 'session-1',
      result: KIMI_ADVERTISED,
      selections: hostAcpModelAndEffortSelections({
        modelValue: 'kimi-code/kimi-for-coding',
        reasoningId: 'high'
      })
    })
    expect(write).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('keeps the persisted thinking value when the picker effort is not offered', () => {
    const write = vi.fn()
    const onWarning = vi.fn()
    const onComplete = vi.fn()
    const applicator = createHostAcpSessionConfigApplicator({ write, onWarning, onComplete })
    applicator.begin({
      sessionId: 'session-1',
      result: KIMI_ADVERTISED,
      selections: hostAcpModelAndEffortSelections({
        modelValue: 'kimi-code/kimi-for-coding',
        reasoningId: 'on'
      })
    })
    expect(write).not.toHaveBeenCalled()
    expect(onWarning).toHaveBeenCalledWith(
      'ACP session does not offer "on" for config option "thinking"; keeping its persisted value.'
    )
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('continues the prompt when a config update is rejected', () => {
    const write = vi.fn()
    const onWarning = vi.fn()
    const onComplete = vi.fn()
    const applicator = createHostAcpSessionConfigApplicator({ write, onWarning, onComplete })
    applicator.begin({
      sessionId: 'session-1',
      result: KIMI_ADVERTISED,
      selections: hostAcpModelAndEffortSelections({ modelValue: 'kimi-code/k3' })
    })
    expect(
      applicator.acceptFrame({
        id: 1000,
        error: { code: -32000, message: 'unknown model' }
      })
    ).toBe(true)
    expect(onWarning).toHaveBeenCalledWith(
      'ACP session config "model" was not applied: unknown model'
    )
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
