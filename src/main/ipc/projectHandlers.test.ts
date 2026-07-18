import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerProjectHandlers,
  type ProjectHandlerDeps,
  type ProjectReferenceProposalServiceFacade
} from './projectHandlers'
import type { ProjectOp } from '../../shared/projects'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

const sampleReference = {
  id: 'ref-1',
  projectId: 'project-a',
  kind: 'file' as const,
  locator: '/repo/spec.md',
  title: 'spec.md',
  provenance: { addedBy: 'user' as const, addedAt: 1 },
  contextPolicy: 'available' as const,
  updatedAt: 1
}

const sampleProposal = {
  payload: {
    schemaVersion: 1 as const,
    purpose: 'library-addition-proposal' as const,
    action: 'proposed' as const,
    proposalId: 'proposal-1',
    projectId: 'project-a',
    materializationReferenceId: 'ref-proposed',
    candidate: {
      kind: 'file' as const,
      locator: '/repo/agent-brief.docx',
      title: 'Agent brief'
    },
    reason: 'Useful source for the report',
    proposedAt: 25
  },
  event: {
    runId: 'run-1',
    provider: 'codex' as const,
    // Event internals intentionally must not cross the renderer boundary.
    hash: 'private-run-event-hash'
  }
}

function createDeps() {
  const marker = {
    importedAt: 1,
    sourceHash: 'hash',
    importedCount: 2,
    status: 'imported' as const
  }
  const referenceProposalService = {
    listPending: vi.fn(() => [sampleProposal]),
    review: vi.fn<() => unknown>(() => ({
      created: true,
      proposal: sampleProposal,
      reference: sampleReference
    }))
  }
  const deps: ProjectHandlerDeps = {
    getProjects: vi.fn(() => []),
    getWorkProfiles: vi.fn(() => [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 9 }]),
    getReferences: vi.fn(() => [
      sampleReference,
      { ...sampleReference, id: 'ref-url', kind: 'url' as const, locator: 'https://x.dev' }
    ]),
    applyReferenceOp: vi.fn(() => ({
      projects: [],
      workProfiles: [],
      references: [],
      changed: true
    })),
    probeReferenceLocator: vi.fn(() => 'ok' as const),
    probeConnectorReference: vi.fn(async () => ({ status: 'ok' as const, revision: 'sha-1' })),
    pickReferencePath: vi.fn(async () => '/picked/path'),
    getLegacyImportMarker: vi.fn(() => marker),
    applyProjectOp: vi.fn((op: ProjectOp) => ({
      projects: [],
      workProfiles: [],
      references: [],
      changed: op.kind !== 'delete'
    })),
    setProjectHomeChat: vi.fn(() => ({
      projects: [],
      workProfiles: [],
      references: [],
      changed: true
    })),
    setProjectWorkProfileFields: vi.fn(() => ({
      projects: [],
      workProfiles: [],
      references: [],
      changed: true
    })),
    chatExists: vi.fn((chatId: string) => chatId !== 'chat-missing'),
    workspaceExists: vi.fn((workspaceId: string) => workspaceId !== 'ws-missing'),
    importLegacyProjects: vi.fn((rawJson: string | null) => ({
      status: rawJson === null ? ('nothing-to-import' as const) : ('imported' as const),
      importedCount: 0,
      marker
    })),
    referenceProposalService:
      referenceProposalService as unknown as ProjectReferenceProposalServiceFacade,
    notifyReferenceProposalsChanged: vi.fn(),
    assertSenderCanManageProjects: vi.fn()
  }
  return { deps, marker, referenceProposalService }
}

describe('registerProjectHandlers', () => {
  it('registers the ten project channels', () => {
    registerProjectHandlers(createDeps().deps)
    expect(handlerFor('projects:snapshot')).toBeTypeOf('function')
    expect(handlerFor('projects:apply-op')).toBeTypeOf('function')
    expect(handlerFor('projects:set-home-chat')).toBeTypeOf('function')
    expect(handlerFor('projects:update-work-profile')).toBeTypeOf('function')
    expect(handlerFor('projects:reference-op')).toBeTypeOf('function')
    expect(handlerFor('projects:verify-reference')).toBeTypeOf('function')
    expect(handlerFor('projects:pick-reference-path')).toBeTypeOf('function')
    expect(handlerFor('projects:import-legacy')).toBeTypeOf('function')
    expect(handlerFor('projects:list-reference-proposals')).toBeTypeOf('function')
    expect(handlerFor('projects:review-reference-proposal')).toBeTypeOf('function')
  })

  it('guards every channel with the sender assertion', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    handlerFor('projects:snapshot')({})
    handlerFor('projects:apply-op')({}, { kind: 'delete', projectId: 'p' })
    handlerFor('projects:set-home-chat')({}, 'project-a', 'chat-1')
    handlerFor('projects:update-work-profile')({}, 'project-a', { brief: 'x' })
    handlerFor('projects:reference-op')({}, { kind: 'remove-reference', id: 'ref-1' })
    handlerFor('projects:verify-reference')({}, 'ref-1')
    void handlerFor('projects:pick-reference-path')({}, 'file')
    handlerFor('projects:import-legacy')({}, null)
    handlerFor('projects:list-reference-proposals')({}, 'project-a')
    handlerFor('projects:review-reference-proposal')({}, {
      projectId: 'project-a',
      proposalId: 'proposal-1',
      decision: 'reject'
    })
    expect(deps.assertSenderCanManageProjects).toHaveBeenCalledTimes(10)
  })

  it('returns projects, work profiles, references, and the import marker as the snapshot', () => {
    const { deps, marker } = createDeps()
    registerProjectHandlers(deps)
    expect(handlerFor('projects:snapshot')({})).toEqual({
      projects: [],
      workProfiles: [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 9 }],
      references: deps.getReferences(),
      legacyImportMarker: marker
    })
  })

  it('validates work-profile patches and gates preferred workspaces on registration', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:update-work-profile')

    handler({}, 'project-a', { brief: 'Ship it', preferredWorkspaceId: 'ws-1' })
    expect(deps.setProjectWorkProfileFields).toHaveBeenCalledWith('project-a', {
      brief: 'Ship it',
      preferredWorkspaceId: 'ws-1'
    })
    handler({}, 'project-a', { preferredWorkspaceId: null })
    expect(deps.setProjectWorkProfileFields).toHaveBeenLastCalledWith('project-a', {
      preferredWorkspaceId: null
    })

    expect(() => handler({}, '', { brief: 'x' })).toThrow('Project id is required.')
    expect(() => handler({}, 'project-a', null)).toThrow('Malformed profile patch.')
    expect(() => handler({}, 'project-a', { brief: 42 })).toThrow('Malformed brief.')
    expect(() => handler({}, 'project-a', { preferredWorkspaceId: 42 })).toThrow(
      'Malformed preferred workspace.'
    )
    expect(() => handler({}, 'project-a', { preferredWorkspaceId: 'ws-missing' })).toThrow(
      'Preferred workspace is not registered.'
    )
    expect(deps.setProjectWorkProfileFields).toHaveBeenCalledTimes(2)
  })

  it('applies parsed reference ops but refuses renderer-supplied verification records', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:reference-op')

    handler({}, { kind: 'remove-reference', id: 'ref-1' })
    expect(deps.applyReferenceOp).toHaveBeenCalledWith({ kind: 'remove-reference', id: 'ref-1' })

    expect(() => handler({}, { kind: 'not-an-op' })).toThrow(
      'Malformed project reference operation.'
    )
    expect(() =>
      handler({}, { kind: 'record-reference-verification', id: 'ref-1', status: 'ok', now: 1 })
    ).toThrow('Reference verification is main-initiated.')
    expect(deps.applyReferenceOp).toHaveBeenCalledTimes(1)
  })

  it('verifies local references with a main-side probe and rejects URL kinds', async () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:verify-reference')

    await handler({}, 'ref-1')
    expect(deps.probeReferenceLocator).toHaveBeenCalledWith('file', '/repo/spec.md')
    expect(deps.applyReferenceOp).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'record-reference-verification',
        id: 'ref-1',
        status: 'ok'
      })
    )

    await expect(handler({}, 'ref-url')).rejects.toThrow(
      'URL references cannot be verified automatically.'
    )
    await expect(handler({}, 'ref-missing')).rejects.toThrow('Reference not found.')
    await expect(handler({}, '  ')).rejects.toThrow('Reference id is required.')
  })

  it('verifies connector references through the connector probe and records the revision', async () => {
    const { deps } = createDeps()
    ;(deps.getReferences as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        ...sampleReference,
        id: 'ref-gh',
        kind: 'connector' as const,
        locator: 'github://a/b/docs/spec.md'
      }
    ])
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:verify-reference')

    await handler({}, 'ref-gh')
    expect(deps.probeConnectorReference).toHaveBeenCalledWith('github://a/b/docs/spec.md')
    expect(deps.applyReferenceOp).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'record-reference-verification',
        id: 'ref-gh',
        status: 'ok',
        revision: 'sha-1'
      })
    )
    expect(deps.probeReferenceLocator).not.toHaveBeenCalled()

    ;(deps.probeConnectorReference as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Could not verify with GitHub credentials (gh: HTTP 401); the resource is not publicly visible.')
    )
    await expect(handler({}, 'ref-gh')).rejects.toThrow(/Could not verify with GitHub credentials/)
  })

  it('passes picker modes through and rejects malformed ones', async () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:pick-reference-path')

    await expect(handler({}, 'folder')).resolves.toBe('/picked/path')
    expect(deps.pickReferencePath).toHaveBeenCalledWith('folder')
    await expect(handler({}, 'everything')).rejects.toThrow('Malformed picker mode.')
  })

  it('projects pending proposals without exposing mutable run-event internals', () => {
    const { deps, referenceProposalService } = createDeps()
    registerProjectHandlers(deps)

    expect(handlerFor('projects:list-reference-proposals')({}, '  project-a  ')).toEqual([
      {
        proposalId: 'proposal-1',
        projectId: 'project-a',
        candidate: {
          kind: 'file',
          locator: '/repo/agent-brief.docx',
          title: 'Agent brief'
        },
        reason: 'Useful source for the report',
        proposedAt: 25,
        provider: 'codex',
        runId: 'run-1'
      }
    ])
    expect(referenceProposalService.listPending).toHaveBeenCalledWith('project-a')

    expect(() => handlerFor('projects:list-reference-proposals')({}, '  ')).toThrow(
      'Project id is required.'
    )
    expect(() => handlerFor('projects:list-reference-proposals')({}, 42)).toThrow(
      'Project id is required.'
    )
  })

  it('reviews strictly shaped proposal input and only broadcasts real changes', () => {
    const { deps, referenceProposalService } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:review-reference-proposal')

    expect(
      handler({}, {
        projectId: ' project-a ',
        proposalId: ' proposal-1 ',
        decision: 'approve'
      })
    ).toEqual({ created: true, referenceId: 'ref-1' })
    expect(referenceProposalService.review).toHaveBeenCalledWith({
      projectId: 'project-a',
      proposalId: 'proposal-1',
      decision: 'approve'
    })
    expect(deps.notifyReferenceProposalsChanged).toHaveBeenCalledWith('project-a')

    referenceProposalService.review.mockReturnValueOnce({
      created: false,
      proposal: sampleProposal
    })
    expect(
      handler({}, { projectId: 'project-a', proposalId: 'proposal-1', decision: 'approve' })
    ).toEqual({ created: false })
    expect(deps.notifyReferenceProposalsChanged).toHaveBeenCalledTimes(1)

    expect(() =>
      handler({}, { projectId: 'project-a', proposalId: 'proposal-1', decision: 'maybe' })
    ).toThrow('Project reference proposal decision is invalid.')
    expect(() => handler({}, { projectId: 'project-a', decision: 'reject' })).toThrow(
      'Proposal id is required.'
    )
    expect(() =>
      handler({}, {
        projectId: 'project-a',
        proposalId: 'proposal-1',
        decision: 'reject',
        privateEvent: true
      })
    ).toThrow('Malformed Project reference proposal review.')
  })

  it('validates home-chat claims and gates them on chat existence', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:set-home-chat')

    expect(handler({}, 'project-a', '  chat-1  ')).toEqual({
      projects: [],
      workProfiles: [],
      references: [],
      changed: true
    })
    expect(deps.setProjectHomeChat).toHaveBeenCalledWith('project-a', 'chat-1')

    handler({}, 'project-a', null)
    expect(deps.setProjectHomeChat).toHaveBeenCalledWith('project-a', null)
    handler({}, 'project-a', undefined)
    expect(deps.setProjectHomeChat).toHaveBeenLastCalledWith('project-a', null)

    expect(() => handler({}, '', 'chat-1')).toThrow('Project id is required.')
    expect(() => handler({}, 'project-a', 42)).toThrow('Malformed chat id.')
    expect(() => handler({}, 'project-a', '   ')).toThrow('Chat id is required.')
    expect(() => handler({}, 'project-a', 'chat-missing')).toThrow('Chat not found.')
    expect(deps.setProjectHomeChat).toHaveBeenCalledTimes(3)
  })

  it('parses ops before applying and rejects malformed payloads', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)

    const op: ProjectOp = { kind: 'rename', projectId: 'p', name: 'Next', now: 5 }
    expect(handlerFor('projects:apply-op')({}, op)).toEqual({
      projects: [],
      workProfiles: [],
      references: [],
      changed: true
    })
    expect(deps.applyProjectOp).toHaveBeenCalledWith(op)

    expect(() => handlerFor('projects:apply-op')({}, { kind: 'rename', projectId: 'p' })).toThrow(
      'Malformed project operation.'
    )
    expect(deps.applyProjectOp).toHaveBeenCalledTimes(1)
  })

  it('coerces non-string import payloads to null', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    handlerFor('projects:import-legacy')({}, 42)
    expect(deps.importLegacyProjects).toHaveBeenCalledWith(null)
    handlerFor('projects:import-legacy')({}, '[]')
    expect(deps.importLegacyProjects).toHaveBeenCalledWith('[]')
  })
})
