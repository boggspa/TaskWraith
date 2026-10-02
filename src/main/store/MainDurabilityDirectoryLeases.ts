import fs from 'node:fs'
import type {
  MainDurabilityFlusher,
  DurabilityFile,
  DurabilityDependency
} from './MainDurabilityFlusher'

export interface DirectoryLease {
  noteMutation(): DurabilityDependency
  release(): Promise<void>
  releaseSync(): void
}

interface DirectoryState {
  file: DurabilityFile
  extent: number
  refs: number
  retiring: boolean
  retirement?: Promise<void>
  closed: boolean
  failed?: boolean
  releaseFinal?: () => Promise<void>
}

/** One instance per profile's single flusher. Directory dependencies stay flat.
 * Consumers note mutations after creation/rename, then retire their own files
 * before releasing the lease. Final release discards debt only for deletion;
 * shutdown must drain the shared flusher first.
 */
export class MainDurabilityDirectoryLeases {
  private readonly directories = new Map<string, DirectoryState>()
  private fenced = false
  private readonly changed = new Set<() => void>()

  constructor(private readonly flusher: MainDurabilityFlusher) {}

  acquire(directoryPath: string): DirectoryLease {
    if (this.fenced) throw new Error('Directory registry retired')
    // Stat before open avoids acquiring unmanaged extra descriptors on alias
    // lookup. Registration still uses fstat to detect replacement races.
    const observed = fs.statSync(directoryPath, { bigint: true })
    if (!observed.isDirectory()) throw new Error('Directory lease requires a directory')
    const key = `${observed.dev}:${observed.ino}`
    let state = this.directories.get(key)
    if (state?.retiring) throw new Error('Directory retirement must complete before acquisition')
    if (!state) {
      const fd = fs.openSync(directoryPath, 'r')
      try {
        const actual = fs.fstatSync(fd, { bigint: true })
        if (actual.dev !== observed.dev || actual.ino !== observed.ino) {
          throw new Error('Directory identity changed during acquisition')
        }
        // A failed registration never takes descriptor ownership.
        const file = this.flusher.open(Number(actual.dev), Number(actual.ino), fd)
        state = { file, extent: 0, refs: 0, retiring: false, closed: false }
        this.directories.set(key, state)
      } catch (error) {
        fs.closeSync(fd)
        throw error
      }
    }
    state.refs++
    const directory = state
    let released = false
    const beginRelease = (): boolean => {
      if (released) return directory.retiring && !directory.closed
      released = true
      directory.refs--
      if (directory.refs !== 0) return false
      directory.retiring = true
      for (const notify of this.changed) notify()
      return true
    }
    const finished = (): void => {
      directory.closed = true
      // Never remove a later generation's registry entry.
      if (this.directories.get(key) === directory) this.directories.delete(key)
      for (const notify of this.changed) notify()
    }
    const lease: DirectoryLease = {
      noteMutation: () => {
        if (released || directory.retiring || directory.closed)
          throw new Error('Directory lease released')
        // Increment before registration. If noteWrite throws, the unregistered
        // mutation remains debt and the next successful note covers it too.
        directory.extent++
        this.flusher.noteWrite(directory.file, directory.extent, 'soft')
        return { file: directory.file, offset: directory.extent }
      },
      release: () => {
        if (!beginRelease()) return Promise.resolve()
        if (directory.retirement) return directory.retirement
        if (directory.failed) {
          try {
            this.flusher.forgetSync([directory.file])
            finished()
            return Promise.resolve()
          } catch (error) {
            return Promise.reject(error)
          }
        }
        const pending = this.flusher
          .forget([directory.file])
          .then(finished)
          .catch((error) => {
            directory.failed = true
            throw error
          })
          .finally(() => {
            if (directory.retirement === pending) directory.retirement = undefined
          })
        directory.retirement = pending
        return pending
      },
      releaseSync: () => {
        if (!beginRelease()) return
        try {
          this.flusher.forgetSync([directory.file])
        } catch (error) {
          directory.failed = true
          throw error
        }
        finished()
      }
    }
    directory.releaseFinal = lease.release
    return lease
  }

  /** Fence allocation now; wait for live consumers rather than closing their fd. */
  async retire(): Promise<void> {
    this.fenced = true
    while (this.directories.size) {
      const states = [...this.directories.values()]
      const closing = states.filter((state) => state.refs === 0)
      if (closing.length) {
        await Promise.all(closing.map((state) => state.releaseFinal!()))
        continue
      }
      await new Promise<void>((resolve) => {
        const notify = () => {
          this.changed.delete(notify)
          resolve()
        }
        this.changed.add(notify)
      })
    }
  }
}
