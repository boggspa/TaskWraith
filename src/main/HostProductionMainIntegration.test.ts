import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

describe('production Host main integration', () => {
  it('shares one turn-scoped chat-list view across every chat-derived family', () => {
    expect(source).toContain(
      "import { createHostProductionChatListCoalescer } from './host/HostProductionChatListCoalescer'"
    )

    const hostWiring = between(
      "// Host Arc R4' — production Host ON.",
      '// Construction runs BEFORE `.start()` exists'
    )
    expect(hostWiring).toContain(
      'const hostChatList = createHostProductionChatListCoalescer(AppStore)'
    )
    expect(hostWiring).toContain('chatList: hostChatList')
    expect(hostWiring.match(/hostChatList\.getChatList\(\)/g)).toHaveLength(3)
    expect(hostWiring).not.toContain('AppStore.getChatList()')
  })

  it('projects bounded resolved question metadata with its exact receipt id', () => {
    const questionWiring = between(
      'questions: createHostProductionQuestionShadow({',
      '// Track3 Mixed Wave B — family shadows.'
    )
    expect(questionWiring).toContain('remoteQuestionRegistry.listPending()')
    expect(questionWiring).toContain('remoteQuestionRegistry.listResolved()')
    expect(questionWiring).toContain('status: r.status')
    expect(questionWiring).toContain('resolvedAt: r.resolvedAt')
    expect(questionWiring).toContain('receiptId: r.receiptId')
    expect(questionWiring).not.toContain('answer:')
  })

  it('passes the Host command receipt into both answer and dismiss registry transitions', () => {
    const responder = between(
      'respondQuestionFn: async (action, response) => {',
      'registerApnsTokenFn: async (action) => {'
    )
    expect(responder).toMatch(
      /remoteQuestionRegistry\.answerScoped\([\s\S]*?'remote',\s*action\.receiptId\s*\)/
    )
    expect(responder).toMatch(
      /remoteQuestionRegistry\.rejectScoped\([\s\S]*?response\.reason \|\| 'user-dismissed',\s*action\.receiptId\s*\)/
    )
  })
})
