import { describe, expect, it } from 'vitest'
import {
  BridgeActionPayloadDecodeError,
  actionIdFromPayload,
  decodeBridgeActionPayload,
  expiresAtFromPayload,
  payloadIsMutating,
  payloadRequiresWorkspaceGating,
  workspaceIdFromPayload,
  type BridgeActionPayload
} from './BridgeActionPayload'

function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')
}

describe('decodeBridgeActionPayload', () => {
  describe('happy paths', () => {
    it('decodes an approvalReply with all fields', () => {
      const wire = encode({
        kind: 'approvalReply',
        workspaceId: 'ws-1',
        threadId: 't-1',
        toolCallId: 'tool-call-99',
        decision: 'accept',
        message: 'approved from iPhone'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('approvalReply')
      if (payload.kind !== 'approvalReply') throw new Error('discriminant')
      expect(payload.workspaceId).toBe('ws-1')
      expect(payload.threadId).toBe('t-1')
      expect(payload.toolCallId).toBe('tool-call-99')
      expect(payload.decision).toBe('accept')
      expect(payload.message).toBe('approved from iPhone')
    })

    it('decodes all approval decisions', () => {
      for (const decision of [
        'accept',
        'acceptForSession',
        'acceptForWorkspace',
        'decline',
        'cancel'
      ] as const) {
        const wire = encode({
          kind: 'approvalReply',
          workspaceId: 'ws-1',
          threadId: 't-1',
          toolCallId: 'tc-1',
          decision
        })
        const { payload } = decodeBridgeActionPayload(wire)
        expect(payload.kind).toBe('approvalReply')
        if (payload.kind === 'approvalReply') {
          expect(payload.decision).toBe(decision)
        }
      }
    })

    it('decodes a questionReply', () => {
      const wire = encode({
        kind: 'questionReply',
        workspaceId: 'ws-1',
        threadId: 't-1',
        runId: 'run-1',
        promptId: 'q-99',
        answer: 'yes, proceed with src/main'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('questionReply')
      if (payload.kind === 'questionReply') {
        expect(payload.runId).toBe('run-1')
        expect(payload.answer).toBe('yes, proceed with src/main')
      }
    })

    it('decodes a questionReject', () => {
      const wire = encode({
        kind: 'questionReject',
        workspaceId: 'ws-1',
        threadId: 't-1',
        runId: 'run-1',
        promptId: 'q-1',
        message: 'cancel this'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('questionReject')
      if (payload.kind === 'questionReject') expect(payload.runId).toBe('run-1')
    })

    it('decodes a proposedPlanDecision (mutating, workspace-gated)', () => {
      const wire = encode({
        kind: 'proposedPlanDecision',
        actionId: 'a-plan-1',
        workspaceId: 'ws-1',
        threadId: 't-1',
        messageId: 'm7',
        decision: 'dismissed'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('proposedPlanDecision')
      if (payload.kind === 'proposedPlanDecision') {
        expect(payload.messageId).toBe('m7')
        expect(payload.decision).toBe('dismissed')
      }
      expect(workspaceIdFromPayload(payload)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
      expect(payloadIsMutating(payload)).toBe(true)
    })

    it('decodes a canvasAction close/reload (mutating, workspace-gated)', () => {
      for (const action of ['close', 'reload'] as const) {
        const { payload } = decodeBridgeActionPayload(
          encode({
            kind: 'canvasAction',
            actionId: 'a-canvas-1',
            workspaceId: 'ws-1',
            threadId: 't-1',
            canvasId: 'cv1',
            action
          })
        )
        expect(payload.kind).toBe('canvasAction')
        if (payload.kind === 'canvasAction') {
          expect(payload.canvasId).toBe('cv1')
          expect(payload.action).toBe(action)
        }
        expect(workspaceIdFromPayload(payload)).toBe('ws-1')
        expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
        expect(payloadIsMutating(payload)).toBe(true)
      }
    })

    it('rejects a canvasAction with an unknown action or a missing canvasId', () => {
      const badAction = decodeBridgeActionPayload(
        encode({
          kind: 'canvasAction',
          actionId: 'a',
          workspaceId: 'ws-1',
          threadId: 't-1',
          canvasId: 'cv1',
          action: 'open'
        })
      )
      expect(badAction.payload.kind).toBe('unknown')
      const noId = decodeBridgeActionPayload(
        encode({
          kind: 'canvasAction',
          actionId: 'a',
          workspaceId: 'ws-1',
          threadId: 't-1',
          action: 'close'
        })
      )
      expect(noId.payload.kind).toBe('unknown')
    })

    it('rejects a proposedPlanDecision whose decision is not dismissed', () => {
      // Approve no longer rides this action (it flips status atomically with the
      // implement run via composerPromptFn), so 'approved' — like 'pending' — is
      // now rejected; only 'dismissed' is a valid decision.
      for (const decision of ['approved', 'pending']) {
        const { payload } = decodeBridgeActionPayload(
          encode({
            kind: 'proposedPlanDecision',
            actionId: 'a-plan-2',
            workspaceId: 'ws-1',
            threadId: 't-1',
            messageId: 'm7',
            decision
          })
        )
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') expect(payload.rawKind).toBe('proposedPlanDecision')
      }
    })

    it('rejects oversized questionReply answers', () => {
      const { payload } = decodeBridgeActionPayload(
        encode({
          kind: 'questionReply',
          workspaceId: 'ws-1',
          threadId: 't-1',
          promptId: 'q-99',
          answer: 'x'.repeat(8001)
        })
      )
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') expect(payload.rawKind).toBe('questionReply')
    })

    it('rejects oversized questionReject messages', () => {
      const { payload } = decodeBridgeActionPayload(
        encode({
          kind: 'questionReject',
          workspaceId: 'ws-1',
          threadId: 't-1',
          promptId: 'q-99',
          message: 'x'.repeat(1001)
        })
      )
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') expect(payload.rawKind).toBe('questionReject')
    })

    it('rejects blank question run ids when present', () => {
      for (const kind of ['questionReply', 'questionReject'] as const) {
        const { payload } = decodeBridgeActionPayload(
          encode({
            kind,
            workspaceId: 'ws-1',
            threadId: 't-1',
            runId: '   ',
            promptId: 'q-99',
            ...(kind === 'questionReply' ? { answer: 'yes' } : {})
          })
        )
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') expect(payload.rawKind).toBe(kind)
      }
    })

	  it('decodes createThread (mutating) and transcript row/media reads', () => {
      const create = decodeBridgeActionPayload(
        encode({
          kind: 'createThread',
          actionId: 'a-create-1',
          workspaceId: 'ws-1',
          variant: 'ensemble',
          title: 'Panel'
        })
      ).payload
      expect(create.kind).toBe('createThread')
      if (create.kind === 'createThread') {
        expect(create.variant).toBe('ensemble')
        expect(create.threadId).toBeUndefined()
      }
      expect(payloadRequiresWorkspaceGating(create)).toBe(true)
      expect(payloadIsMutating(create)).toBe(true)
      const legacySingle = decodeBridgeActionPayload(
        encode({
          kind: 'createThread',
          actionId: 'a-create-legacy',
          workspaceId: 'ws-1',
          variant: 'single'
        })
      ).payload
      expect(legacySingle.kind).toBe('createThread')
      if (legacySingle.kind === 'createThread') {
        expect(legacySingle.variant).toBe('single')
      }
      const workflow = decodeBridgeActionPayload(
        encode({
          kind: 'createThread',
          actionId: 'a-create-workflow',
          workspaceId: 'ws-1',
          variant: 'workflow',
          title: 'New Workflow'
        })
      ).payload
      expect(workflow.kind).toBe('createThread')
      if (workflow.kind === 'createThread') {
        expect(workflow.variant).toBe('workflow')
      }

      const expand = decodeBridgeActionPayload(
        encode({
          kind: 'threadRowExpand',
          actionId: 'a-expand-1',
          workspaceId: 'ws-1',
          threadId: 't-1',
          rowId: 'm7',
          maxChars: 32000
        })
      ).payload
      expect(expand.kind).toBe('threadRowExpand')
      if (expand.kind === 'threadRowExpand') expect(expand.rowId).toBe('m7')
      expect(payloadIsMutating(expand)).toBe(false)

      const media = decodeBridgeActionPayload(
        encode({
          kind: 'threadMediaFetch',
          actionId: 'a-media-1',
          workspaceId: 'ws-1',
          threadId: 't-1',
          rowId: 'm7',
          mediaId: 'media-1',
          variant: 'thumbnail',
          maxBytes: 128000
        })
      ).payload
      expect(media.kind).toBe('threadMediaFetch')
      if (media.kind === 'threadMediaFetch') {
        expect(media.mediaId).toBe('media-1')
        expect(media.variant).toBe('thumbnail')
        expect(media.maxBytes).toBe(128000)
      }
      expect(workspaceIdFromPayload(media)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(media)).toBe(true)
      expect(payloadIsMutating(media)).toBe(false)

      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'threadMediaFetch',
            actionId: 'bad-media-1',
            workspaceId: 'ws-1',
            threadId: 't-1',
            rowId: 'm7',
            mediaId: 'media-1',
            variant: 'raw'
          })
        ).payload.kind
      ).toBe('unknown')
      // Bad variant → unknown (defensive decode).
      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'createThread', actionId: 'x', workspaceId: 'w', variant: 'nope' })
        ).payload.kind
      ).toBe('unknown')
    })

    it('validates threadMediaFetch CHUNKED/RANGE offset+length (both-or-neither, integer, bounds)', () => {
      const base = {
        kind: 'threadMediaFetch' as const,
        actionId: 'a-range',
        workspaceId: 'ws-1',
        threadId: 't-1',
        rowId: 'm7',
        mediaId: 'media-1',
        variant: 'full' as const
      }
      const decodeKind = (extra: Record<string, unknown>): string =>
        decodeBridgeActionPayload(encode({ ...base, ...extra })).payload.kind

      // Both present + valid → accepted, fields preserved.
      const ok = decodeBridgeActionPayload(encode({ ...base, offset: 0, length: 65536 })).payload
      expect(ok.kind).toBe('threadMediaFetch')
      if (ok.kind === 'threadMediaFetch') {
        expect(ok.offset).toBe(0)
        expect(ok.length).toBe(65536)
      }
      expect(decodeKind({ offset: 458752, length: 1 })).toBe('threadMediaFetch')

      // Neither present → whole-file mode, still valid.
      expect(decodeKind({})).toBe('threadMediaFetch')

      // Exactly one present → rejected.
      expect(decodeKind({ offset: 0 })).toBe('unknown')
      expect(decodeKind({ length: 1024 })).toBe('unknown')

      // Out-of-bounds / non-integer → rejected.
      expect(decodeKind({ offset: -1, length: 1024 })).toBe('unknown') // negative offset
      expect(decodeKind({ offset: 0, length: 0 })).toBe('unknown') // length < 1
      expect(decodeKind({ offset: 0, length: -5 })).toBe('unknown') // negative length
      expect(decodeKind({ offset: 1.5, length: 1024 })).toBe('unknown') // non-integer offset
      expect(decodeKind({ offset: 0, length: 1024.5 })).toBe('unknown') // non-integer length
      expect(decodeKind({ offset: '0', length: 1024 })).toBe('unknown') // wrong type
    })

    it('decodes createThread ensemble roster overrides + rejects oversized rosters', () => {
      const withRoster = decodeBridgeActionPayload(
        encode({
          kind: 'createThread',
          actionId: 'a-roster',
          workspaceId: 'ws-1',
          variant: 'ensemble',
          participants: [
            { provider: 'claude', model: 'claude-fable-5' },
            { provider: 'gemini', role: 'Researcher' }
          ]
        })
      ).payload
      expect(withRoster.kind).toBe('createThread')
      if (withRoster.kind === 'createThread') {
        expect(withRoster.participants).toHaveLength(2)
        expect(withRoster.participants?.[0].model).toBe('claude-fable-5')
        expect(withRoster.participants?.[1].role).toBe('Researcher')
      }
      const oversized = decodeBridgeActionPayload(
        encode({
          kind: 'createThread',
          actionId: 'a-big',
          workspaceId: 'ws-1',
          variant: 'ensemble',
          participants: Array.from({ length: 13 }, () => ({ provider: 'claude' }))
        })
      ).payload
      expect(oversized.kind).toBe('unknown')
    })

    it('decodes a threadSnapshotRequest and classifies it read-only', () => {
      const wire = encode({
        kind: 'threadSnapshotRequest',
        actionId: 'a-snap-1',
        workspaceId: 'ws-1',
        threadId: 't-1',
        limit: 40,
        beforeRowId: 'm7'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('threadSnapshotRequest')
      if (payload.kind === 'threadSnapshotRequest') {
        expect(payload.threadId).toBe('t-1')
        expect(payload.limit).toBe(40)
        expect(payload.beforeRowId).toBe('m7')
      }
      expect(workspaceIdFromPayload(payload)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
      expect(payloadIsMutating(payload)).toBe(false)
      // Bad limit → unknown (defensive decode).
      const bad = decodeBridgeActionPayload(
        encode({ kind: 'threadSnapshotRequest', actionId: 'x', workspaceId: 'w', threadId: 't', limit: -2 })
      )
      expect(bad.payload.kind).toBe('unknown')
    })

    it('decodes workspace file actions with correct mutability', () => {
      const list = decodeBridgeActionPayload(
        encode({
          kind: 'workspaceFileList',
          actionId: 'files-list',
          workspaceId: 'ws-1',
          path: 'src',
          query: 'app',
          limit: 120
        })
      ).payload
      expect(list.kind).toBe('workspaceFileList')
      if (list.kind === 'workspaceFileList') {
        expect(list.path).toBe('src')
        expect(list.query).toBe('app')
        expect(list.limit).toBe(120)
      }
      expect(workspaceIdFromPayload(list)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(list)).toBe(true)
      expect(payloadIsMutating(list)).toBe(false)

      const read = decodeBridgeActionPayload(
        encode({
          kind: 'workspaceFileRead',
          actionId: 'files-read',
          workspaceId: 'ws-1',
          path: 'Sources/App.swift'
        })
      ).payload
      expect(read.kind).toBe('workspaceFileRead')
      expect(payloadIsMutating(read)).toBe(false)

      const write = decodeBridgeActionPayload(
        encode({
          kind: 'workspaceFileWrite',
          actionId: 'files-write',
          workspaceId: 'ws-1',
          path: 'Sources/App.swift',
          content: 'print("hi")\n',
          baseEtag: 'sha256:abc'
        })
      ).payload
      expect(write.kind).toBe('workspaceFileWrite')
      expect(payloadIsMutating(write)).toBe(true)

      const del = decodeBridgeActionPayload(
        encode({
          kind: 'workspaceFileDelete',
          actionId: 'files-delete',
          workspaceId: 'ws-1',
          path: 'Sources/App.swift',
          baseEtag: 'sha256:def'
        })
      ).payload
      expect(del.kind).toBe('workspaceFileDelete')
      expect(payloadIsMutating(del)).toBe(true)

      const staleDelete = decodeBridgeActionPayload(
        encode({
          kind: 'workspaceFileDelete',
          actionId: 'files-delete-missing-etag',
          workspaceId: 'ws-1',
          path: 'Sources/App.swift'
        })
      ).payload
      expect(staleDelete.kind).toBe('unknown')
    })

    it('decodes workspaceDiff as a read-only workspace-gated action', () => {
      const diff = decodeBridgeActionPayload(
        encode({ kind: 'workspaceDiff', actionId: 'diff-1', workspaceId: 'ws-1' })
      ).payload
      expect(diff.kind).toBe('workspaceDiff')
      expect(workspaceIdFromPayload(diff)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(diff)).toBe(true)
      expect(payloadIsMutating(diff)).toBe(false)

      // Missing workspaceId → unknown (defensive decode).
      expect(
        decodeBridgeActionPayload(encode({ kind: 'workspaceDiff', actionId: 'diff-2' })).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'workspaceDiff' })
    })

    it('decodes git reads (snapshot/prStatus/prReadiness) as read-only workspace-gated actions', () => {
      for (const kind of ['gitSnapshot', 'githubPrStatus', 'githubPrReadiness'] as const) {
        const payload = decodeBridgeActionPayload(
          encode({ kind, actionId: `${kind}-1`, workspaceId: 'ws-1' })
        ).payload
        expect(payload.kind).toBe(kind)
        expect(workspaceIdFromPayload(payload)).toBe('ws-1')
        expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
        expect(payloadIsMutating(payload)).toBe(false)

        // Missing workspaceId → unknown (defensive decode).
        expect(
          decodeBridgeActionPayload(encode({ kind, actionId: `${kind}-2` })).payload
        ).toMatchObject({ kind: 'unknown', rawKind: kind })
      }

      const quietSnapshot = decodeBridgeActionPayload(
        encode({
          kind: 'gitSnapshot',
          actionId: 'gitSnapshot-quiet',
          workspaceId: 'ws-1',
          publish: false
        })
      ).payload
      expect(quietSnapshot).toMatchObject({
        kind: 'gitSnapshot',
        workspaceId: 'ws-1',
        publish: false
      })
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'gitSnapshot',
            actionId: 'gitSnapshot-bad-publish',
            workspaceId: 'ws-1',
            publish: 'false'
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitSnapshot' })
    })

    it('decodes gitStageAll as a mutating workspace-gated action', () => {
      const stage = decodeBridgeActionPayload(
        encode({ kind: 'gitStageAll', actionId: 'stage-1', workspaceId: 'ws-1' })
      ).payload
      expect(stage.kind).toBe('gitStageAll')
      expect(workspaceIdFromPayload(stage)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(stage)).toBe(true)
      expect(payloadIsMutating(stage)).toBe(true)
    })

    it('decodes selected git stage/unstage paths as mutating workspace-gated actions', () => {
      for (const kind of ['gitStagePaths', 'gitUnstagePaths'] as const) {
        const payload = decodeBridgeActionPayload(
          encode({ kind, actionId: `${kind}-1`, workspaceId: 'ws-1', paths: ['Sources/App.swift'] })
        ).payload
        expect(payload.kind).toBe(kind)
        expect(workspaceIdFromPayload(payload)).toBe('ws-1')
        expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
        expect(payloadIsMutating(payload)).toBe(true)

        expect(
          decodeBridgeActionPayload(
            encode({ kind, actionId: `${kind}-bad`, workspaceId: 'ws-1', paths: [] })
          ).payload
        ).toMatchObject({ kind: 'unknown', rawKind: kind })
      }
    })

    it('decodes gitCommit with an explicit message (+ optional stageAll)', () => {
      const commit = decodeBridgeActionPayload(
        encode({
          kind: 'gitCommit',
          actionId: 'commit-1',
          workspaceId: 'ws-1',
          message: 'fix: phone commit',
          stageAll: true
        })
      ).payload
      expect(commit.kind).toBe('gitCommit')
      expect(commit).toMatchObject({ message: 'fix: phone commit', stageAll: true })
      expect(payloadIsMutating(commit)).toBe(true)

      // stageAll is optional.
      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'gitCommit', actionId: 'commit-2', workspaceId: 'ws-1', message: 'm' })
        ).payload.kind
      ).toBe('gitCommit')
    })

    it('rejects malformed gitCommit payloads', () => {
      // No message at all.
      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'gitCommit', actionId: 'commit-3', workspaceId: 'ws-1' })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitCommit' })
      // Whitespace-only message — a commit message must be user-entered text.
      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'gitCommit', actionId: 'commit-4', workspaceId: 'ws-1', message: '   ' })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitCommit' })
      // Oversized message (> 5000 chars).
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'gitCommit',
            actionId: 'commit-5',
            workspaceId: 'ws-1',
            message: 'x'.repeat(5001)
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitCommit' })
      // Non-boolean stageAll.
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'gitCommit',
            actionId: 'commit-6',
            workspaceId: 'ws-1',
            message: 'm',
            stageAll: 'yes'
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitCommit' })
    })

    it('decodes gitPush with optional setUpstream', () => {
      const push = decodeBridgeActionPayload(
        encode({ kind: 'gitPush', actionId: 'push-1', workspaceId: 'ws-1', setUpstream: true })
      ).payload
      expect(push.kind).toBe('gitPush')
      expect(push).toMatchObject({ setUpstream: true })
      expect(payloadIsMutating(push)).toBe(true)

      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'gitPush', actionId: 'push-2', workspaceId: 'ws-1', setUpstream: 'now' })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'gitPush' })
    })

    it('decodes githubCreatePr with optional title/body/draft', () => {
      const create = decodeBridgeActionPayload(
        encode({
          kind: 'githubCreatePr',
          actionId: 'pr-1',
          workspaceId: 'ws-1',
          title: 'Phone PR',
          body: 'Created from iOS',
          draft: true
        })
      ).payload
      expect(create.kind).toBe('githubCreatePr')
      expect(create).toMatchObject({ title: 'Phone PR', body: 'Created from iOS', draft: true })
      expect(payloadIsMutating(create)).toBe(true)

      // All fields optional — gh falls back to --fill.
      expect(
        decodeBridgeActionPayload(
          encode({ kind: 'githubCreatePr', actionId: 'pr-2', workspaceId: 'ws-1' })
        ).payload.kind
      ).toBe('githubCreatePr')

      // Oversized title → unknown.
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'githubCreatePr',
            actionId: 'pr-3',
            workspaceId: 'ws-1',
            title: 'x'.repeat(301)
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'githubCreatePr' })
    })

    it('rejects malformed workspace file writes', () => {
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'workspaceFileWrite',
            workspaceId: 'ws-1',
            path: 'Sources/App.swift',
            content: 'print("hi")\n'
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'workspaceFileWrite' })
      expect(
        decodeBridgeActionPayload(
          encode({
            kind: 'workspaceFileRead',
            workspaceId: 'ws-1',
            path: 'bad\u0000path'
          })
        ).payload
      ).toMatchObject({ kind: 'unknown', rawKind: 'workspaceFileRead' })
    })

    it('decodes a composerPrompt with optional fields', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'find the auth bug',
        provider: 'gemini',
        approvalMode: 'plan',
        model: 'gemini-2.5-pro',
        contextTurns: 5
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('composerPrompt')
      if (payload.kind === 'composerPrompt') {
        expect(payload.text).toBe('find the auth bug')
        expect(payload.provider).toBe('gemini')
        expect(payload.contextTurns).toBe(5)
      }
    })

    it('decodes a composerPrompt carrying proposedPlanImplementOf (plan implement run)', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'implement the plan',
        provider: 'claude',
        approvalMode: 'default',
        proposedPlanImplementOf: 'm7'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('composerPrompt')
      if (payload.kind === 'composerPrompt') {
        expect(payload.proposedPlanImplementOf).toBe('m7')
      }
    })

    it('rejects a composerPrompt with an empty proposedPlanImplementOf', () => {
      const { payload } = decodeBridgeActionPayload(
        encode({
          kind: 'composerPrompt',
          workspaceId: 'ws-1',
          threadId: 't-1',
          text: 'x',
          provider: 'claude',
          proposedPlanImplementOf: '   '
        })
      )
      expect(payload.kind).toBe('unknown')
    })

    it('decodes a composerPrompt with only required fields', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'hi',
        provider: 'gemini'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('composerPrompt')
    })

    it('decodes composer queue actions', () => {
      const prompt = decodeBridgeActionPayload(
        encode({
          kind: 'composerQueuePrompt',
          workspaceId: 'ws-1',
          threadId: 't-1',
          text: 'run this after the current turn',
          provider: 'codex',
          approvalMode: 'plan'
        })
      ).payload
      expect(prompt.kind).toBe('composerQueuePrompt')
      if (prompt.kind === 'composerQueuePrompt') {
        expect(prompt.provider).toBe('codex')
        expect(prompt.approvalMode).toBe('plan')
      }

      const item = decodeBridgeActionPayload(
        encode({
          kind: 'composerQueueItem',
          workspaceId: 'ws-1',
          threadId: 't-1',
          queueId: 'queue-1',
          textPrefix: 'run this',
          op: 'remove'
        })
      ).payload
      expect(item.kind).toBe('composerQueueItem')
      if (item.kind === 'composerQueueItem') {
        expect(item.queueId).toBe('queue-1')
        expect(item.op).toBe('remove')
      }
    })

    it('treats composerPrompt without provider as unknown', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'hi'
        // provider missing — now required
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('decodes a cancelRun', () => {
      const wire = encode({
        kind: 'cancelRun',
        workspaceId: 'ws-1',
        threadId: 't-1',
        provider: 'gemini',
        runId: 'run-1'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('cancelRun')
      if (payload.kind === 'cancelRun') {
        expect(payload.provider).toBe('gemini')
        expect(payload.runId).toBe('run-1')
      }
    })

    it('decodes setYoloMode', () => {
      const wire = encode({
        kind: 'setYoloMode',
        workspaceId: 'ws-1',
        enabled: true
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload).toEqual({ kind: 'setYoloMode', workspaceId: 'ws-1', enabled: true })
    })

    it('rejects workspace-less setYoloMode payloads', () => {
      const wire = encode({
        kind: 'setYoloMode',
        enabled: true
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('decodes togglePinChat', () => {
      const wire = encode({
        kind: 'togglePinChat',
        workspaceId: 'ws-1',
        appChatId: 'chat-1',
        pinned: true
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload).toEqual({
        kind: 'togglePinChat',
        workspaceId: 'ws-1',
        appChatId: 'chat-1',
        pinned: true
      })
    })

    it('decodes togglePinWorkspace', () => {
      const wire = encode({
        kind: 'togglePinWorkspace',
        workspaceId: 'ws-1',
        pinned: false
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload).toEqual({
        kind: 'togglePinWorkspace',
        workspaceId: 'ws-1',
        pinned: false
      })
    })

    it('decodes a registerApnsToken with production env', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        env: 'production'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('registerApnsToken')
      if (payload.kind === 'registerApnsToken') {
        expect(payload.pairID).toBe('pair-1')
        expect(payload.deviceToken).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
        expect(payload.env).toBe('production')
      }
    })

    it('decodes a registerApnsToken with sandbox env', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        env: 'sandbox'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('registerApnsToken')
    })

    it('decodes ensemble control variants', () => {
      const variants = [
        {
          kind: 'ensembleCancelRound',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          roundId: 'round-1',
          message: 'stop this round'
        },
        {
          kind: 'ensembleSkipActiveParticipant',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          roundId: 'round-1',
          participantId: 'participant-1',
          message: 'skip stalled participant'
        },
        {
          kind: 'ensembleWakeNow',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          wakeupId: 'wakeup-1',
          message: 'wake now'
        },
        {
          kind: 'ensembleCancelWakeup',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          wakeupId: 'wakeup-1',
          message: 'cancel timer'
        },
        {
          kind: 'ensembleQueuePrompt',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          text: 'continue with the next item',
          message: 'queued from iOS'
        },
        {
          kind: 'ensembleSteer',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          text: 'focus on the failing test first',
          message: 'steered from iOS'
        }
      ]

      for (const variant of variants) {
        const { payload } = decodeBridgeActionPayload(encode(variant))
        expect(payload.kind).toBe(variant.kind)
        if (payload.kind === 'unknown') throw new Error('expected known variant')
        expect(workspaceIdFromPayload(payload)).toBe('ws-1')
        expect('threadId' in payload ? payload.threadId : undefined).toBe('thread-1')
      }
    })

    it('decodes optional action metadata on known variants', () => {
      const metadata = { actionId: 'action-1', issuedAt: 1000, expiresAt: 2000 }
      const variants: Array<Record<string, unknown>> = [
        {
          kind: 'approvalReply',
          workspaceId: 'ws-1',
          threadId: 't-1',
          toolCallId: 'tc-1',
          decision: 'accept'
        },
        {
          kind: 'questionReply',
          workspaceId: 'ws-1',
          threadId: 't-1',
          promptId: 'q-1',
          answer: 'yes'
        },
        { kind: 'questionReject', workspaceId: 'ws-1', threadId: 't-1', promptId: 'q-1' },
        {
          kind: 'composerPrompt',
          workspaceId: 'ws-1',
          threadId: 't-1',
          text: 'hi',
          provider: 'gemini'
        },
        {
          kind: 'composerQueuePrompt',
          workspaceId: 'ws-1',
          threadId: 't-1',
          text: 'queue me',
          provider: 'gemini'
        },
        {
          kind: 'composerQueueItem',
          workspaceId: 'ws-1',
          threadId: 't-1',
          queueId: 'queue-1',
          op: 'steerNow'
        },
        {
          kind: 'cancelRun',
          workspaceId: 'ws-1',
          threadId: 't-1',
          provider: 'gemini',
          runId: 'run-1'
        },
        { kind: 'setYoloMode', workspaceId: 'ws-1', enabled: true },
        { kind: 'setThreadTitle', workspaceId: 'ws-1', threadId: 't-1', title: 'Rename me' },
        { kind: 'togglePinChat', workspaceId: 'ws-1', appChatId: 'chat-1', pinned: true },
        { kind: 'togglePinWorkspace', workspaceId: 'ws-1', pinned: true },
        {
          kind: 'registerApnsToken',
          pairID: 'pair-1',
          deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          env: 'production'
        },
        {
          kind: 'ensembleCancelRound',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          roundId: 'round-1'
        },
        {
          kind: 'ensembleSkipActiveParticipant',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          participantId: 'participant-1'
        },
        {
          kind: 'ensembleWakeNow',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          wakeupId: 'wakeup-1'
        },
        {
          kind: 'ensembleCancelWakeup',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          wakeupId: 'wakeup-1'
        },
        {
          kind: 'ensembleQueuePrompt',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          text: 'queued prompt'
        },
        {
          kind: 'ensembleSteer',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          text: 'steering prompt'
        }
      ]

      for (const variant of variants) {
        const { payload } = decodeBridgeActionPayload(encode({ ...variant, ...metadata }))
        expect(payload.kind).toBe(variant.kind)
        if (payload.kind === 'unknown') throw new Error('expected known variant')
        expect(payload.actionId).toBe('action-1')
        expect(payload.issuedAt).toBe(1000)
        expect(payload.expiresAt).toBe(2000)
        expect(actionIdFromPayload(payload)).toBe('action-1')
        expect(expiresAtFromPayload(payload)).toBe(2000)
      }
    })

    it('treats registerApnsToken missing pairID as unknown', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        deviceToken: 'tok',
        env: 'production'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats registerApnsToken missing deviceToken as unknown', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        env: 'production'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats registerApnsToken with invalid env as unknown', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: 'tok',
        env: 'staging' // not in enum
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats registerApnsToken with empty deviceToken as unknown', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: '',
        env: 'production'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats registerApnsToken with a non-64-hex deviceToken as unknown', () => {
      const wire = encode({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: 'not-a-valid-token',
        env: 'production'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats cancelRun missing provider as unknown', () => {
      const wire = encode({
        kind: 'cancelRun',
        workspaceId: 'ws-1',
        threadId: 't-1',
        runId: 'run-1' // no provider
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats ensemble wake actions without wakeupId as unknown', () => {
      for (const kind of ['ensembleWakeNow', 'ensembleCancelWakeup']) {
        const wire = encode({
          kind,
          workspaceId: 'ws-1',
          threadId: 'thread-1'
        })
        const { payload } = decodeBridgeActionPayload(wire)
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') {
          expect(payload.rawKind).toBe(kind)
        }
      }
    })

    it('treats ensemble text actions without text as unknown', () => {
      for (const kind of ['ensembleQueuePrompt', 'ensembleSteer']) {
        const wire = encode({
          kind,
          workspaceId: 'ws-1',
          threadId: 'thread-1'
        })
        const { payload } = decodeBridgeActionPayload(wire)
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') {
          expect(payload.rawKind).toBe(kind)
        }
      }
    })

    it('treats ensemble controls without threadId as unknown', () => {
      const wire = encode({
        kind: 'ensembleCancelRound',
        workspaceId: 'ws-1',
        roundId: 'round-1'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') {
        expect(payload.rawKind).toBe('ensembleCancelRound')
      }
    })

    it('decodes goalUpdate as a workspace-bound chat control', () => {
      const { payload } = decodeBridgeActionPayload(
        encode({
          kind: 'goalUpdate',
          actionId: 'goal-1',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          op: 'set',
          objective: 'Finish the remote goal rail'
        })
      )
      expect(payload.kind).toBe('goalUpdate')
      if (payload.kind !== 'goalUpdate') throw new Error('expected goalUpdate')
      expect(payload.objective).toBe('Finish the remote goal rail')
      expect(workspaceIdFromPayload(payload)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
      expect(payloadIsMutating(payload)).toBe(true)
    })

    it('decodes setThreadTitle as a workspace-bound chat control', () => {
      const { payload } = decodeBridgeActionPayload(
        encode({
          kind: 'setThreadTitle',
          actionId: 'rename-1',
          workspaceId: 'ws-1',
          threadId: 'thread-1',
          title: 'New chat name'
        })
      )
      expect(payload.kind).toBe('setThreadTitle')
      if (payload.kind !== 'setThreadTitle') throw new Error('expected setThreadTitle')
      expect(payload.title).toBe('New chat name')
      expect(workspaceIdFromPayload(payload)).toBe('ws-1')
      expect(payloadRequiresWorkspaceGating(payload)).toBe(true)
      expect(payloadIsMutating(payload)).toBe(true)
    })

    it('rejects malformed setThreadTitle payloads', () => {
      for (const variant of [
        { kind: 'setThreadTitle', workspaceId: 'ws-1', threadId: 't-1', title: '' },
        { kind: 'setThreadTitle', workspaceId: 'ws-1', threadId: 't-1', title: '   ' },
        { kind: 'setThreadTitle', workspaceId: 'ws-1', threadId: 't-1', title: 'x'.repeat(161) },
        { kind: 'setThreadTitle', workspaceId: 'ws-1', title: 'Missing thread' }
      ]) {
        const { payload } = decodeBridgeActionPayload(encode(variant))
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') expect(payload.rawKind).toBe('setThreadTitle')
      }
    })

    it('rejects malformed goalUpdate payloads', () => {
      for (const variant of [
        { kind: 'goalUpdate', workspaceId: 'ws-1', threadId: 't-1', op: 'set' },
        {
          kind: 'goalUpdate',
          workspaceId: 'ws-1',
          threadId: 't-1',
          op: 'edit',
          objective: ' '
        },
        { kind: 'goalUpdate', workspaceId: 'ws-1', threadId: 't-1', op: 'unknown' }
      ]) {
        const { payload } = decodeBridgeActionPayload(encode(variant))
        expect(payload.kind).toBe('unknown')
        if (payload.kind === 'unknown') expect(payload.rawKind).toBe('goalUpdate')
      }
    })
  })

  describe('unknown / forward-compat', () => {
    it('decodes an unrecognized kind as BridgeUnknownAction', () => {
      const wire = encode({
        kind: 'futureFeatureFromV2iOS',
        workspaceId: 'ws-1',
        thingy: true
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') {
        expect(payload.rawKind).toBe('futureFeatureFromV2iOS')
        expect(payload.raw).toEqual({
          kind: 'futureFeatureFromV2iOS',
          workspaceId: 'ws-1',
          thingy: true
        })
      }
    })

    it('treats malformed approvalReply (bad decision enum) as unknown', () => {
      const wire = encode({
        kind: 'approvalReply',
        workspaceId: 'ws-1',
        threadId: 't-1',
        toolCallId: 'tc-1',
        decision: 'maybe' // not in enum
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') {
        expect(payload.rawKind).toBe('approvalReply')
      }
    })

    it('treats approvalReply missing toolCallId as unknown', () => {
      const wire = encode({
        kind: 'approvalReply',
        workspaceId: 'ws-1',
        threadId: 't-1',
        decision: 'accept'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats empty actionId metadata as unknown', () => {
      const wire = encode({
        kind: 'approvalReply',
        workspaceId: 'ws-1',
        threadId: 't-1',
        toolCallId: 'tc-1',
        decision: 'accept',
        actionId: ''
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') {
        expect(payload.rawKind).toBe('approvalReply')
      }
    })

    it('treats non-number expiry metadata as unknown', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'hi',
        provider: 'gemini',
        expiresAt: 'soon'
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
      if (payload.kind === 'unknown') {
        expect(payload.rawKind).toBe('composerPrompt')
      }
    })

    it('treats composerPrompt with negative contextTurns as unknown', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'hi',
        contextTurns: -5
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats composerPrompt with float contextTurns as unknown', () => {
      const wire = encode({
        kind: 'composerPrompt',
        workspaceId: 'ws-1',
        threadId: 't-1',
        text: 'hi',
        contextTurns: 3.7
      })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats a top-level non-object payload as unknown', () => {
      const wire = encode(['this', 'is', 'an', 'array'])
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })

    it('treats a payload with no kind as unknown', () => {
      const wire = encode({ workspaceId: 'ws-1', someField: true })
      const { payload } = decodeBridgeActionPayload(wire)
      expect(payload.kind).toBe('unknown')
    })
  })

  describe('decode errors (BridgeActionPayloadDecodeError)', () => {
    it('throws on empty base64', () => {
      expect(() => decodeBridgeActionPayload('')).toThrow(BridgeActionPayloadDecodeError)
    })

    it('throws on garbage base64', () => {
      try {
        decodeBridgeActionPayload('not===valid===base64!!')
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeActionPayloadDecodeError)
        if (err instanceof BridgeActionPayloadDecodeError) {
          expect(err.stage).toBe('base64')
        }
      }
    })

    it('throws on malformed JSON inside otherwise-valid base64', () => {
      const wire = Buffer.from('not json {', 'utf-8').toString('base64')
      try {
        decodeBridgeActionPayload(wire)
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeActionPayloadDecodeError)
        if (err instanceof BridgeActionPayloadDecodeError) {
          expect(err.stage).toBe('json')
        }
      }
    })
  })
})

describe('workspaceIdFromPayload', () => {
  it('returns workspaceId for each known variant', () => {
    const variants: Array<{ payload: BridgeActionPayload; expected: string }> = [
      {
        payload: {
          kind: 'approvalReply',
          workspaceId: 'ws-a',
          threadId: 't',
          toolCallId: 'tc',
          decision: 'accept'
        },
        expected: 'ws-a'
      },
      {
        payload: {
          kind: 'questionReply',
          workspaceId: 'ws-b',
          threadId: 't',
          promptId: 'p',
          answer: 'y'
        },
        expected: 'ws-b'
      },
      {
        payload: { kind: 'questionReject', workspaceId: 'ws-c', threadId: 't', promptId: 'p' },
        expected: 'ws-c'
      },
      {
        payload: {
          kind: 'composerPrompt',
          workspaceId: 'ws-d',
          threadId: 't',
          provider: 'gemini',
          text: 'hi'
        },
        expected: 'ws-d'
      },
      {
        payload: {
          kind: 'cancelRun',
          workspaceId: 'ws-e',
          threadId: 't',
          provider: 'gemini',
          runId: 'r'
        },
        expected: 'ws-e'
      },
      {
        payload: { kind: 'setYoloMode', workspaceId: 'ws-yolo', enabled: true },
        expected: 'ws-yolo'
      },
      {
        payload: {
          kind: 'setThreadTitle',
          workspaceId: 'ws-title',
          threadId: 't',
          title: 'Rename'
        },
        expected: 'ws-title'
      },
      {
        payload: { kind: 'togglePinChat', workspaceId: 'ws-f', appChatId: 'chat-1', pinned: true },
        expected: 'ws-f'
      },
      {
        payload: { kind: 'togglePinWorkspace', workspaceId: 'ws-g', pinned: false },
        expected: 'ws-g'
      },
      {
        payload: {
          kind: 'ensembleCancelRound',
          workspaceId: 'ws-h',
          threadId: 't',
          roundId: 'r'
        },
        expected: 'ws-h'
      },
      {
        payload: {
          kind: 'ensembleSkipActiveParticipant',
          workspaceId: 'ws-i',
          threadId: 't',
          participantId: 'p'
        },
        expected: 'ws-i'
      },
      {
        payload: {
          kind: 'ensembleWakeNow',
          workspaceId: 'ws-j',
          threadId: 't',
          wakeupId: 'wakeup'
        },
        expected: 'ws-j'
      },
      {
        payload: {
          kind: 'ensembleCancelWakeup',
          workspaceId: 'ws-k',
          threadId: 't',
          wakeupId: 'wakeup'
        },
        expected: 'ws-k'
      },
      {
        payload: {
          kind: 'ensembleQueuePrompt',
          workspaceId: 'ws-l',
          threadId: 't',
          text: 'queue'
        },
        expected: 'ws-l'
      },
      {
        payload: {
          kind: 'ensembleSteer',
          workspaceId: 'ws-m',
          threadId: 't',
          text: 'steer'
        },
        expected: 'ws-m'
      }
    ]
    for (const { payload, expected } of variants) {
      expect(workspaceIdFromPayload(payload)).toBe(expected)
    }
  })

  it('returns null for unknown variant', () => {
    expect(workspaceIdFromPayload({ kind: 'unknown', rawKind: 'something', raw: {} })).toBeNull()
  })

  it('returns null for registerApnsToken (paired-device-level, not workspace-bound)', () => {
    expect(
      workspaceIdFromPayload({
        kind: 'registerApnsToken',
        pairID: 'p',
        deviceToken: 't',
        env: 'production'
      })
    ).toBeNull()
  })
})

describe('payloadRequiresWorkspaceGating', () => {
  it('returns true for workspace-bound variants', () => {
    const variants: BridgeActionPayload[] = [
      {
        kind: 'approvalReply',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'c',
        decision: 'accept'
      },
      { kind: 'questionReply', workspaceId: 'w', threadId: 't', promptId: 'p', answer: 'a' },
      { kind: 'questionReject', workspaceId: 'w', threadId: 't', promptId: 'p' },
      { kind: 'composerPrompt', workspaceId: 'w', threadId: 't', provider: 'gemini', text: 'x' },
      { kind: 'threadMediaFetch', workspaceId: 'w', threadId: 't', rowId: 'm', mediaId: 'img' },
      { kind: 'cancelRun', workspaceId: 'w', threadId: 't', provider: 'gemini', runId: 'r' },
      { kind: 'setYoloMode', workspaceId: 'w', enabled: false },
      { kind: 'setThreadTitle', workspaceId: 'w', threadId: 't', title: 'Rename' },
      { kind: 'goalUpdate', workspaceId: 'w', threadId: 't', op: 'pause' },
      { kind: 'togglePinChat', workspaceId: 'w', appChatId: 'chat', pinned: true },
      { kind: 'togglePinWorkspace', workspaceId: 'w', pinned: true },
      { kind: 'ensembleCancelRound', workspaceId: 'w', threadId: 't', roundId: 'round' },
      {
        kind: 'ensembleSkipActiveParticipant',
        workspaceId: 'w',
        threadId: 't',
        participantId: 'p'
      },
      { kind: 'ensembleWakeNow', workspaceId: 'w', threadId: 't', wakeupId: 'wakeup' },
      { kind: 'ensembleCancelWakeup', workspaceId: 'w', threadId: 't', wakeupId: 'wakeup' },
      { kind: 'ensembleQueuePrompt', workspaceId: 'w', threadId: 't', text: 'queue' },
      { kind: 'ensembleSteer', workspaceId: 'w', threadId: 't', text: 'steer' }
    ]
    for (const v of variants) {
      expect(payloadRequiresWorkspaceGating(v)).toBe(true)
    }
  })

  it('returns false for registerApnsToken (system action)', () => {
    expect(
      payloadRequiresWorkspaceGating({
        kind: 'registerApnsToken',
        pairID: 'p',
        deviceToken: 't',
        env: 'production'
      })
    ).toBe(false)
  })

  it('returns true defensively for unknown variants', () => {
    expect(payloadRequiresWorkspaceGating({ kind: 'unknown', rawKind: 'x', raw: {} })).toBe(true)
  })
})

describe('payloadIsMutating', () => {
  it('classifies composerPrompt as mutating', () => {
    expect(
      payloadIsMutating({
        kind: 'composerPrompt',
        workspaceId: 'w',
        threadId: 't',
        provider: 'gemini',
        text: 'hi'
      })
    ).toBe(true)
  })

  it('classifies cancelRun as mutating', () => {
    expect(
      payloadIsMutating({
        kind: 'cancelRun',
        workspaceId: 'w',
        threadId: 't',
        provider: 'gemini',
        runId: 'r'
      })
    ).toBe(true)
  })

  it('classifies questionReply as mutating (provides typed input to agent)', () => {
    expect(
      payloadIsMutating({
        kind: 'questionReply',
        workspaceId: 'w',
        threadId: 't',
        promptId: 'p',
        answer: 'yes'
      })
    ).toBe(true)
  })

  it('classifies session and pin controls as mutating', () => {
    expect(payloadIsMutating({ kind: 'setYoloMode', workspaceId: 'w', enabled: true })).toBe(true)
    expect(
      payloadIsMutating({
        kind: 'goalUpdate',
        workspaceId: 'w',
        threadId: 't',
        op: 'complete'
      })
    ).toBe(true)
    expect(
      payloadIsMutating({
        kind: 'setThreadTitle',
        workspaceId: 'w',
        threadId: 't',
        title: 'Rename'
      })
    ).toBe(true)
    expect(
      payloadIsMutating({
        kind: 'togglePinChat',
        workspaceId: 'w',
        appChatId: 'chat',
        pinned: true
      })
    ).toBe(true)
    expect(
      payloadIsMutating({
        kind: 'togglePinWorkspace',
        workspaceId: 'w',
        pinned: true
      })
    ).toBe(true)
  })

  it('classifies ensemble remote controls as mutating', () => {
    const variants: BridgeActionPayload[] = [
      { kind: 'ensembleCancelRound', workspaceId: 'w', threadId: 't', roundId: 'round' },
      {
        kind: 'ensembleSkipActiveParticipant',
        workspaceId: 'w',
        threadId: 't',
        participantId: 'p'
      },
      { kind: 'ensembleWakeNow', workspaceId: 'w', threadId: 't', wakeupId: 'wakeup' },
      { kind: 'ensembleCancelWakeup', workspaceId: 'w', threadId: 't', wakeupId: 'wakeup' },
      { kind: 'ensembleQueuePrompt', workspaceId: 'w', threadId: 't', text: 'queue' },
      { kind: 'ensembleSteer', workspaceId: 'w', threadId: 't', text: 'steer' }
    ]

    for (const payload of variants) {
      expect(payloadIsMutating(payload)).toBe(true)
    }
  })

  it('classifies approvalReply as non-mutating (responds to desktop-initiated prompt)', () => {
    expect(
      payloadIsMutating({
        kind: 'approvalReply',
        workspaceId: 'w',
        threadId: 't',
        toolCallId: 'tc',
        decision: 'accept'
      })
    ).toBe(false)
  })

  it('classifies questionReject as non-mutating (declines to provide input)', () => {
    expect(
      payloadIsMutating({
        kind: 'questionReject',
        workspaceId: 'w',
        threadId: 't',
        promptId: 'p'
      })
    ).toBe(false)
  })

  it('classifies transcript media fetch as non-mutating', () => {
    expect(
      payloadIsMutating({
        kind: 'threadMediaFetch',
        workspaceId: 'w',
        threadId: 't',
        rowId: 'm',
        mediaId: 'img'
      })
    ).toBe(false)
  })

  it('classifies registerApnsToken as mutating (replay-guarded; security review)', () => {
    expect(
      payloadIsMutating({
        kind: 'registerApnsToken',
        pairID: 'p',
        deviceToken: 't',
        env: 'production'
      })
    ).toBe(true)
  })

  it('classifies unknown variants as mutating defensively', () => {
    expect(payloadIsMutating({ kind: 'unknown', rawKind: 'futureKind', raw: {} })).toBe(true)
  })
})
