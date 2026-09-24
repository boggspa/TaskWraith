import type {
  TaskWraithControlThreadFindParams,
  TaskWraithControlThreadFindResult,
  TaskWraithControlThreadSnapshot,
  TaskWraithControlThreadSummary
} from '../shared/taskWraithControlProtocol'
import type { OutsideCommand, OutsideSocketCommand } from './outsideCommand'
import type { SenderIdentity } from './senderIdentity'

/**
 * The slice of the control client this runner needs. Narrow on purpose: the
 * runner never asks for a snapshot or a transcript, because a client that
 * advertises those puts the host back on a per-tick projection poll.
 */
export interface OutsideClientPort {
  connect(): Promise<unknown>
  findThreads(params: TaskWraithControlThreadFindParams): Promise<TaskWraithControlThreadFindResult>
  sendPrompt(threadId: string, text: string): Promise<{ dispatched: boolean; message: string }>
  selectThread(threadId: string, limit?: number): Promise<TaskWraithControlThreadSnapshot>
  close(): void
}

export interface OutsideCommandIo {
  /** Who the host should name on the row; presented at hello. */
  identity: SenderIdentity
  openClient: (identity: SenderIdentity) => Promise<OutsideClientPort>
  write: (line: string) => void
  writeError: (line: string) => void
  readStdin: () => Promise<string>
}

const EXIT_OK = 0
const EXIT_REFUSED = 1
const EXIT_USAGE = 2

function scopeParams(cwd: string | undefined): TaskWraithControlThreadFindParams {
  return cwd ? { workspacePath: cwd } : {}
}

function describe(candidate: TaskWraithControlThreadSummary): string {
  const kind = candidate.chatKind === 'ensemble' ? 'ensemble' : candidate.provider.displayProvider
  return `${candidate.id}  ${candidate.status.padEnd(8)}  ${kind.padEnd(10)}  ${candidate.title}`
}

async function withClient<T>(
  io: OutsideCommandIo,
  body: (client: OutsideClientPort) => Promise<T>
): Promise<T> {
  const client = await io.openClient(io.identity)
  try {
    await client.connect()
    return await body(client)
  } finally {
    // A client left connected costs the host work on every tick, and a
    // throwing send must not be the reason one is stranded.
    client.close()
  }
}

async function runThreads(
  command: Extract<OutsideCommand, { kind: 'threads' }>,
  io: OutsideCommandIo
): Promise<number> {
  return withClient(io, async (client) => {
    const found = await client.findThreads({
      ...(command.query ? { query: command.query } : {}),
      ...scopeParams(command.cwd)
    })
    if (command.json) {
      io.write(JSON.stringify({ threads: found.threads, total: found.total }, null, 2))
      return EXIT_OK
    }
    if (!found.threads.length) {
      io.write(
        command.cwd
          ? `No threads in ${command.cwd}. Use --all to search every workspace.`
          : 'No threads match.'
      )
      return EXIT_OK
    }
    for (const candidate of found.threads) io.write(describe(candidate))
    return EXIT_OK
  })
}

/**
 * One selector rule for every verb that names a thread: an exact id wins, a
 * title may match one thread and no more. Returns the refusal text instead of
 * a thread when it cannot land on exactly one, so both callers refuse alike.
 */
async function resolveThread(
  client: OutsideClientPort,
  selector: string,
  cwd: string | undefined
): Promise<TaskWraithControlThreadSummary | { refusal: string[] }> {
  const found = await client.findThreads({ query: selector, ...scopeParams(cwd) })
  const exact = found.threads.find((candidate) => candidate.id === selector)
  const matches = exact ? [exact] : found.threads
  if (!matches.length) {
    return {
      refusal: [
        cwd
          ? `No thread matching "${selector}" in ${cwd}. Use --all to search every workspace.`
          : `No thread matching "${selector}".`
      ]
    }
  }
  if (matches.length > 1) {
    return {
      refusal: [
        `"${selector}" matches ${matches.length} threads. Use an id:`,
        ...matches.map(describe)
      ]
    }
  }
  return matches[0]
}

async function runRead(
  command: Extract<OutsideSocketCommand, { kind: 'read' }>,
  io: OutsideCommandIo
): Promise<number> {
  return withClient(io, async (client) => {
    const target = await resolveThread(client, command.selector, command.cwd)
    if ('refusal' in target) {
      for (const line of target.refusal) io.writeError(line)
      return EXIT_REFUSED
    }
    const snapshot = await client.selectThread(target.id, command.limit)
    if (command.json) {
      io.write(
        JSON.stringify(
          {
            threadId: target.id,
            title: target.title,
            totalRows: snapshot.totalRows,
            hasMoreAbove: snapshot.hasMoreAbove,
            rows: snapshot.rows
          },
          null,
          2
        )
      )
      return EXIT_OK
    }
    if (!snapshot.rows.length) {
      io.write(`${target.title}: no messages yet.`)
      return EXIT_OK
    }
    for (const row of snapshot.rows) {
      io.write(`${row.speaker} · ${row.timestamp}`)
      io.write(row.text + (row.truncated ? ' …' : ''))
      io.write('')
    }
    return EXIT_OK
  })
}

async function runSend(
  command: Extract<OutsideCommand, { kind: 'send' }>,
  io: OutsideCommandIo
): Promise<number> {
  const text = (command.text ?? (await io.readStdin())).trim()
  if (!text) {
    io.writeError('Nothing to send: pass the prompt after the thread, or pipe it on stdin.')
    return EXIT_USAGE
  }
  return withClient(io, async (client) => {
    const target = await resolveThread(client, command.selector, command.cwd)
    if ('refusal' in target) {
      for (const line of target.refusal) io.writeError(line)
      return EXIT_REFUSED
    }
    const result = await client.sendPrompt(target.id, text)
    if (command.json) {
      io.write(
        JSON.stringify(
          { threadId: target.id, dispatched: result.dispatched, message: result.message },
          null,
          2
        )
      )
      return result.dispatched ? EXIT_OK : EXIT_REFUSED
    }
    if (!result.dispatched) {
      io.writeError(result.message)
      return EXIT_REFUSED
    }
    io.write(`${target.title}: ${result.message}`)
    return EXIT_OK
  })
}

/** Run one non-interactive `tw` verb. Returns the process exit code. */
export async function runOutsideCommand(
  command: OutsideSocketCommand,
  io: OutsideCommandIo
): Promise<number> {
  if (command.kind === 'threads') return runThreads(command, io)
  if (command.kind === 'read') return runRead(command, io)
  return runSend(command, io)
}
