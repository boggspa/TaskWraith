/**
 * Renderer-local receipts for user-selected attachment paths.
 *
 * A path obtained by one secondary renderer must not become a capability for
 * every other renderer in the process. Main-process producers (remote bridge,
 * scheduled materialization) have a separate authority bucket which is never
 * inherited by a secondary renderer.
 */
export class AttachmentCapabilityRegistry {
  private readonly rendererPaths = new Map<number, Set<string>>()
  private readonly mainPaths = new Set<string>()

  constructor(private readonly maxPathsPerPrincipal = 500) {}

  authorizeRendererPath(webContentsId: number, canonicalPath: string): void {
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 0 || !canonicalPath) return
    let paths = this.rendererPaths.get(webContentsId)
    if (!paths) {
      paths = new Set<string>()
      this.rendererPaths.set(webContentsId, paths)
    }
    this.addBounded(paths, canonicalPath)
  }

  authorizeMainPath(canonicalPath: string): void {
    if (!canonicalPath) return
    this.addBounded(this.mainPaths, canonicalPath)
  }

  isAuthorizedForRenderer(
    webContentsId: number,
    canonicalPath: string,
    options: { includeMainAuthority?: boolean } = {}
  ): boolean {
    if (this.rendererPaths.get(webContentsId)?.has(canonicalPath)) return true
    return options.includeMainAuthority === true && this.mainPaths.has(canonicalPath)
  }

  getAuthorizedPathsForRenderer(
    webContentsId: number,
    options: { includeMainAuthority?: boolean } = {}
  ): string[] {
    const paths = new Set(this.rendererPaths.get(webContentsId) || [])
    if (options.includeMainAuthority === true) {
      for (const path of this.mainPaths) paths.add(path)
    }
    return [...paths]
  }

  getMainAuthorizedPaths(): string[] {
    return [...this.mainPaths]
  }

  revokeRenderer(webContentsId: number): void {
    this.rendererPaths.delete(webContentsId)
  }

  private addBounded(paths: Set<string>, canonicalPath: string): void {
    if (paths.has(canonicalPath)) {
      paths.delete(canonicalPath)
    } else if (paths.size >= this.maxPathsPerPrincipal) {
      const oldest = paths.values().next().value
      if (oldest !== undefined) paths.delete(oldest)
    }
    paths.add(canonicalPath)
  }
}
