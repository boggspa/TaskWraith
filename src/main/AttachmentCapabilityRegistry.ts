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
  private readonly unscopedMainPaths = new Set<string>()
  private readonly mainPathsByChat = new Map<string, Set<string>>()
  private readonly mainChatOwnersByPath = new Map<string, Set<string>>()

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

  authorizeMainPath(canonicalPath: string, options: { appChatId?: string } = {}): void {
    if (!canonicalPath) return
    const evicted = this.addBounded(this.mainPaths, canonicalPath)
    if (evicted) this.clearMainPathMetadata(evicted)
    const appChatId = options.appChatId?.trim()
    if (!appChatId) {
      this.unscopedMainPaths.add(canonicalPath)
      return
    }
    let chatPaths = this.mainPathsByChat.get(appChatId)
    if (!chatPaths) {
      chatPaths = new Set()
      this.mainPathsByChat.set(appChatId, chatPaths)
    }
    chatPaths.add(canonicalPath)
    let owners = this.mainChatOwnersByPath.get(canonicalPath)
    if (!owners) {
      owners = new Set()
      this.mainChatOwnersByPath.set(canonicalPath, owners)
    }
    owners.add(appChatId)
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

  /** Revoke only main-authority paths whose last exact chat owner is removed. */
  revokeMainChat(appChatId: string): number {
    const normalized = appChatId.trim()
    if (!normalized) return 0
    const paths = this.mainPathsByChat.get(normalized)
    if (!paths) return 0
    let revoked = 0
    for (const canonicalPath of paths) {
      const owners = this.mainChatOwnersByPath.get(canonicalPath)
      owners?.delete(normalized)
      if (owners && owners.size === 0) this.mainChatOwnersByPath.delete(canonicalPath)
      if (
        !this.unscopedMainPaths.has(canonicalPath) &&
        !this.mainChatOwnersByPath.has(canonicalPath) &&
        this.mainPaths.delete(canonicalPath)
      ) {
        revoked += 1
      }
    }
    this.mainPathsByChat.delete(normalized)
    return revoked
  }

  /** Global history clear must not leave stale main-process path authorities. */
  clearMainAuthority(): number {
    const revoked = this.mainPaths.size
    this.mainPaths.clear()
    this.unscopedMainPaths.clear()
    this.mainPathsByChat.clear()
    this.mainChatOwnersByPath.clear()
    return revoked
  }

  private clearMainPathMetadata(canonicalPath: string): void {
    this.unscopedMainPaths.delete(canonicalPath)
    const owners = this.mainChatOwnersByPath.get(canonicalPath)
    if (owners) {
      for (const appChatId of owners) {
        const paths = this.mainPathsByChat.get(appChatId)
        paths?.delete(canonicalPath)
        if (paths?.size === 0) this.mainPathsByChat.delete(appChatId)
      }
    }
    this.mainChatOwnersByPath.delete(canonicalPath)
  }

  private addBounded(paths: Set<string>, canonicalPath: string): string | undefined {
    let evicted: string | undefined
    if (paths.has(canonicalPath)) {
      paths.delete(canonicalPath)
    } else if (paths.size >= this.maxPathsPerPrincipal) {
      const oldest = paths.values().next().value
      if (oldest !== undefined) {
        paths.delete(oldest)
        evicted = oldest
      }
    }
    paths.add(canonicalPath)
    return evicted
  }
}
