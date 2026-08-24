import type { HostNodeManualAuthHandoff } from './HostNodeDomainPorts'

export interface HostNodeMuseTerminalLauncher {
  launch(input: { readonly argv: readonly [string, 'login'] }): void | Promise<void>
}

/** Narrow user-terminal handoff. It proves launch only, never authentication or cancellation. */
export class HostNodeMuseAuthHandoff implements HostNodeManualAuthHandoff {
  private readonly operations = new Set<string>()

  constructor(
    private readonly binaryPath: string,
    private readonly launcher: HostNodeMuseTerminalLauncher
  ) {
    if (!canonical(binaryPath) || !launcher || typeof launcher.launch !== 'function')
      throw new Error('Muse auth handoff requires binary and launcher')
  }

  async begin(input: { readonly providerId: string; readonly operationId: string }): Promise<void> {
    if (
      input.providerId !== 'muse' ||
      !canonical(input.operationId) ||
      this.operations.has(input.operationId)
    ) {
      throw new Error('Muse auth handoff cannot begin')
    }
    await this.launcher.launch({ argv: [this.binaryPath, 'login'] })
    this.operations.add(input.operationId)
  }

  async cancel(): Promise<boolean> {
    // A user-owned terminal cannot be cancelled/proven by this Host process.
    return false
  }
}

function canonical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- operation IDs reject terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
