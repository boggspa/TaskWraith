import { mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brokerRequest, McpBridgeRuntime } from './McpBridgeRuntime'

describe('McpBridgeRuntime broker lifecycle', () => {
  it.skipIf(process.platform === 'win32')(
    'rebinds when the stored server is listening but its Unix socket path disappeared',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'taskwraith-mcp-lifecycle-'))
      const socketPath = join(directory, 'broker.sock')
      const executeGeminiMcpTool = vi.fn(async () => ({ text: 'rebound' }))
      const runtime = new McpBridgeRuntime({
        getGeminiMcpSocketPath: () => socketPath,
        getGeminiMcpBrokerToken: () => 'token-1',
        executeGeminiMcpTool
      } as never)

      try {
        await runtime.startGeminiMcpBroker()
        expect((await stat(socketPath)).isSocket()).toBe(true)

        // Reproduce the production failure: the NetServer still reports itself
        // as listening after another lifecycle path unlinks its pathname.
        await unlink(socketPath)
        await runtime.startGeminiMcpBroker()

        expect((await stat(socketPath)).isSocket()).toBe(true)
        await expect(
          brokerRequest(socketPath, {
            token: 'token-1',
            tool: 'read_file',
            arguments: { path: 'README.md' },
            parentProvider: 'kimi'
          })
        ).resolves.toMatchObject({ ok: true, text: 'rebound' })
        expect(executeGeminiMcpTool).toHaveBeenCalledOnce()
      } finally {
        runtime.closeGeminiMcpBroker()
        await new Promise((resolve) => setImmediate(resolve))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
