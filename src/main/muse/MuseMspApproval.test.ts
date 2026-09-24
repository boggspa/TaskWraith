import { describe, expect, it } from 'vitest'
import { describeMuseMspApproval, museMspSubjectToService } from './MuseMspApproval'
import type { MuseMspApprovalRequest } from './MuseMspProtocol'

function request(overrides: Partial<MuseMspApprovalRequest> = {}): MuseMspApprovalRequest {
  return {
    approvalId: 'a-1',
    sessionId: 's-1',
    turnId: 't-1',
    itemId: 'i-1',
    taskId: 'task-1',
    toolCallId: 'call-1',
    toolName: 'run_command',
    rawArgs: '{"command":"ls -la"}',
    subject: { kind: 'shell', command: 'ls -la' },
    availableChoices: [],
    currentRequirementId: { approvalId: 'a-1', sourceIndex: 0 },
    judgeEscalated: false,
    protectedWrite: false,
    ...overrides
  } as MuseMspApprovalRequest
}

describe('museMspSubjectToService', () => {
  it('routes shell, file and network subjects to their gated services', () => {
    expect(museMspSubjectToService({ kind: 'shell' })).toBe('shellCommands')
    expect(museMspSubjectToService({ kind: 'file' })).toBe('fileChanges')
    expect(museMspSubjectToService({ kind: 'fileAccess' })).toBe('fileChanges')
    expect(museMspSubjectToService({ kind: 'network' })).toBe('mcpTools')
  })

  it('maps every kind the MSP schema documents, not just the ones we guessed', () => {
    // `ApprovalSubject.kind` is an OPEN discriminator; these five are the
    // documented values (muse schema generate-json-schema, 1.0.3-R2198.1).
    // None of them may reach the fallthrough.
    expect(museMspSubjectToService({ kind: 'shell' })).toBe('shellCommands')
    expect(museMspSubjectToService({ kind: 'fileAccess' })).toBe('fileChanges')
    expect(museMspSubjectToService({ kind: 'network' })).toBe('mcpTools')
    expect(museMspSubjectToService({ kind: 'process' })).toBe('shellCommands')
    // NOT shellCommands: a session grant on shell commands would otherwise
    // silently cover every native Muse tool call.
    expect(museMspSubjectToService({ kind: 'tool' })).toBe('mcpTools')
  })

  it('gates a file read as a file change, having no read-only service to use', () => {
    // AgenticServiceId has no read service; the orchestrator's own read-only
    // fast path is what keeps genuine reads cheap.
    expect(museMspSubjectToService({ kind: 'file', access: 'read', path: '/ws/a.ts' })).toBe(
      'fileChanges'
    )
  })

  it('over-gates an unknown subject rather than waving it through', () => {
    // A subject kind a future Muse introduces must fail SAFE. shellCommands is
    // the most heavily gated service, matching grokToolKindToService.
    expect(museMspSubjectToService({ kind: 'quantum_teleport' })).toBe('shellCommands')
    expect(museMspSubjectToService(null)).toBe('shellCommands')
    expect(museMspSubjectToService(undefined)).toBe('shellCommands')
  })

  it('uses the tool name before defaulting, so a fetch is not called a shell command', () => {
    expect(museMspSubjectToService({ kind: 'unknown' }, 'fetch')).toBe('mcpTools')
    expect(museMspSubjectToService({ kind: 'unknown', toolName: 'search' })).toBe('mcpTools')
  })
})

describe('describeMuseMspApproval', () => {
  it('parses the model-authored argument string into an object', () => {
    // MSP sends rawArgs as a STRING; every ACP provider hands the orchestrator
    // an already-parsed object, so the preview would be empty without this.
    expect(describeMuseMspApproval(request()).rawToolCall).toEqual({ command: 'ls -la' })
  })

  it('still raises a card when the argument blob is malformed', () => {
    const ask = describeMuseMspApproval(request({ rawArgs: '{not json' }))
    // The blob is rejected as arguments, but the subject still carries the
    // command, and the host's shell classifiers read it from here. Returning
    // null would let a destructive command past every command-text gate purely
    // because Muse sent an unparseable argument string alongside it.
    expect(ask.rawToolCall).toEqual({ command: 'ls -la' })
    expect(ask.service).toBe('shellCommands')
    expect(ask.title).toContain('run_command')
  })

  it('rejects a non-object argument payload', () => {
    // Neither payload is usable as arguments, so neither reaches rawToolCall;
    // the subject command is what survives, for the reason above.
    expect(describeMuseMspApproval(request({ rawArgs: '["ls"]' })).rawToolCall).toEqual({
      command: 'ls -la'
    })
    expect(describeMuseMspApproval(request({ rawArgs: '"ls"' })).rawToolCall).toEqual({
      command: 'ls -la'
    })
  })

  it('puts the concrete subject in the body so the card is not just a tool name', () => {
    const shell = describeMuseMspApproval(request())
    expect(shell.body).toContain('ls -la')
    expect(shell.method).toBe('muse/shell')

    const file = describeMuseMspApproval(
      request({
        toolName: 'write_file',
        subject: { kind: 'file', access: 'write', path: '/ws/a.ts' },
        protectedWrite: true
      })
    )
    expect(file.service).toBe('fileChanges')
    expect(file.body).toContain('/ws/a.ts')
    expect(file.title).toContain('protected write')
  })

  it('surfaces a Muse-escalated request in the card body', () => {
    const ask = describeMuseMspApproval(request({ judgeEscalated: true }))
    expect(ask.body).toContain('escalated by Muse')
  })

  it('names a host and port for a network subject', () => {
    const ask = describeMuseMspApproval(
      request({
        toolName: 'fetch',
        subject: { kind: 'network', host: 'example.com', port: 443 }
      })
    )
    expect(ask.service).toBe('mcpTools')
    expect(ask.body).toContain('example.com:443')
  })
})

describe('describeMuseMspApproval — command text for the host shell classifiers', () => {
  it('falls back to subject.command when rawArgs carries none', () => {
    const ask = describeMuseMspApproval(
      request({
        toolName: 'shell',
        subject: { kind: 'shell', command: 'git reset --hard' },
        rawArgs: ''
      })
    )
    expect(ask.rawToolCall).toEqual({ command: 'git reset --hard' })
  })

  it('keeps rawArgs when it already carries the command', () => {
    const ask = describeMuseMspApproval(
      request({
        toolName: 'shell',
        subject: { kind: 'shell', command: 'ls' },
        rawArgs: JSON.stringify({ command: 'git clean -fdx', cwd: '/repo' })
      })
    )
    expect(ask.rawToolCall).toEqual({ command: 'git clean -fdx', cwd: '/repo' })
  })

  it('grafts the subject command onto parsed args that lack one', () => {
    const ask = describeMuseMspApproval(
      request({
        toolName: 'shell',
        subject: { kind: 'shell', command: 'git stash' },
        rawArgs: JSON.stringify({ cwd: '/repo' })
      })
    )
    expect(ask.rawToolCall).toEqual({ cwd: '/repo', command: 'git stash' })
  })

  it('stays null when neither source has a command', () => {
    const ask = describeMuseMspApproval(
      request({ toolName: 'shell', subject: { kind: 'shell' }, rawArgs: '' })
    )
    expect(ask.rawToolCall).toBeNull()
  })
})
