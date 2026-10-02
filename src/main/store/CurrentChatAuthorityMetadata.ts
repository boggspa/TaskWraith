export interface CurrentChatAuthorityMetadata {
  appChatId: string
  workspaceId: string | null
  persistenceRevision: number
}

/** Accepted owner records, checked against exact current source identity. */
export class CurrentChatAuthorityIndex<Record extends object> {
  private readonly entries = new Map<string, { record: Record; source: string }>()

  constructor(private readonly source: (id: string) => string) {}

  remember(id: string, record: Record): void {
    try {
      this.entries.set(id, { record, source: this.source(id) })
    } catch {
      this.entries.delete(id)
    }
  }

  delete(id: string): void {
    this.entries.delete(id)
  }
  clear(): void {
    this.entries.clear()
  }

  read(
    id: string,
    ports: {
      deleted(): boolean
      cached(): Record | undefined
      invalidateClean(): void
      reconcile(): Record | null
    }
  ): Record | null {
    if (ports.deleted()) {
      this.delete(id)
      return null
    }
    const held = this.entries.get(id)
    try {
      const current = this.source(id)
      if (held && held.source === current && ports.cached() === held.record) return held.record
      // A clean cache's mtime/size comparison is weaker than this identity.
      // Pending Host shadows retain their merge/rebase lineage in the caller.
      if (held && held.source !== current) ports.invalidateClean()
    } catch {
      ports.invalidateClean()
    }
    this.delete(id)
    const record = ports.reconcile()
    if (record) this.remember(id, record)
    return record
  }
}
