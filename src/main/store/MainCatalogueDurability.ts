import { ThreadCatalogueDurability } from '../../host-shared/thread-catalogue/ThreadCatalogueDurability'
import type { DurabilityFile } from './MainDurabilityFlusher'
import type { DurabilityAttachmentPorts, DurabilityParticipant } from './MainDurabilityRuntime'

/** Allocation-only constructor; all file ownership stays in the shared profile pool. */
export class MainCatalogueDurability implements DurabilityParticipant {
  readonly publication: ThreadCatalogueDurability<DurabilityFile>

  constructor(private readonly ports: DurabilityAttachmentPorts) {
    this.publication = new ThreadCatalogueDurability({
      open: (dev, ino, fd, offset) => ports.flusher.open(dev, ino, fd, offset, 'catalogue'),
      noteWrite: (...args) => ports.flusher.noteWrite(...args),
      awaitDurable: (...args) => ports.flusher.awaitDurable(...args),
      forget: (...args) => ports.flusher.forget(...args),
      acquire: (directory) => ports.directoryLeases.acquire(directory)
    })
  }

  fence(): void {
    this.publication.fence()
  }

  drainSync(): void {
    this.ports.flusher.drainSync()
  }

  retire(): Promise<void> {
    return this.publication.retire()
  }

  snapshot(): ReturnType<ThreadCatalogueDurability<DurabilityFile>['snapshot']> {
    return this.publication.snapshot()
  }
}
