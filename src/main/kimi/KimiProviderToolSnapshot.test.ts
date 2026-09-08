import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseKimiProviderToolSnapshot,
  readKimiProviderToolSnapshot
} from './KimiProviderToolSnapshot'

const snapshot = (time: number, names: string[]) =>
  JSON.stringify({
    type: 'llm.tools_snapshot',
    agentId: 'main',
    time,
    tools: names.map((name) => ({ name, description: 'not returned' }))
  })

describe('Kimi provider tool-snapshot observation', () => {
  it('detects fresh MCP loss and labels old evidence without copying private content', () => {
    const text = [
      snapshot(100, ['Bash', 'mcp__taskwraith__replace']),
      JSON.stringify({ type: 'context.append_loop_event', event: { text: 'PRIVATE REASONING' } }),
      snapshot(200, ['Bash', 'TaskStop', 'EnterPlanMode'])
    ].join('\n')
    const result = parseKimiProviderToolSnapshot(text, 'session_current', 150)
    expect(result).toEqual({
      sessionId: 'session_current',
      observedAt: 200,
      currentRun: true,
      toolNames: ['Bash', 'EnterPlanMode', 'TaskStop']
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(
      parseKimiProviderToolSnapshot(snapshot(100, ['Bash']), 'session_current', 150)?.currentRun
    ).toBe(false)
  })

  it('ignores incomplete catalogues, subagent records and unrelated JSON', () => {
    expect(
      parseKimiProviderToolSnapshot('{"type":"llm.tools_snapshot",', 'session_current', 1)
    ).toBeNull()
    const foreign = JSON.parse(snapshot(200, ['Bash']))
    foreign.agentId = 'agent-0'
    expect(parseKimiProviderToolSnapshot(JSON.stringify(foreign), 'session_current', 1)).toBeNull()
    expect(
      parseKimiProviderToolSnapshot(snapshot(200, ['invalid name']), 'session_current', 1)
    ).toBeNull()
  })

  // Creating a Windows symlink requires host privileges; parser checks remain portable.
  it.skipIf(process.platform === 'win32')(
    'reads only the selected managed session and rejects a wire symlink',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'kimi-tool-snapshot-'))
      try {
        const directory = join(root, 'sessions', 'wd_test', 'session_current', 'agents', 'main')
        await mkdir(directory, { recursive: true })
        const wire = join(directory, 'wire.jsonl')
        await writeFile(wire, `${snapshot(200, ['Read', 'mcp__taskwraith__read_file'])}\n`)
        expect(
          await readKimiProviderToolSnapshot({
            seatHome: root,
            sessionId: 'session_current',
            runStartedAt: 150
          })
        ).toMatchObject({ currentRun: true, toolNames: ['Read', 'mcp__taskwraith__read_file'] })
        expect(
          await readKimiProviderToolSnapshot({
            seatHome: root,
            sessionId: '../other',
            runStartedAt: 150
          })
        ).toBeNull()
        await rm(wire)
        const other = join(root, 'outside.jsonl')
        await writeFile(other, snapshot(200, ['Bash']))
        await symlink(other, wire)
        expect(
          await readKimiProviderToolSnapshot({
            seatHome: root,
            sessionId: 'session_current',
            runStartedAt: 150
          })
        ).toBeNull()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
