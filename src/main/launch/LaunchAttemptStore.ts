import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LaunchAttempt, LaunchAttemptStatus } from './types'

const ACTIVE_STATUSES = new Set<LaunchAttemptStatus>(['starting', 'running', 'stopping'])

export class LaunchAttemptStore {
  constructor(private readonly storagePath: string) {}

  list(): LaunchAttempt[] {
    const parsed = this.read()
    return parsed
      .filter(isLaunchAttempt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): LaunchAttempt | null {
    return this.list().find((attempt) => attempt.id === id) || null
  }

  save(attempt: LaunchAttempt): LaunchAttempt {
    const attempts = this.list()
    const index = attempts.findIndex((item) => item.id === attempt.id)
    if (index >= 0) attempts[index] = attempt
    else attempts.push(attempt)
    this.write(attempts)
    return attempt
  }

  update(id: string, partial: Partial<LaunchAttempt>): LaunchAttempt | null {
    const current = this.get(id)
    if (!current) return null
    const updated = {
      ...current,
      ...partial,
      id: current.id,
      schemaVersion: 1 as const
    }
    return this.save(updated)
  }

  recoverInterrupted(now = new Date().toISOString()): LaunchAttempt[] {
    const attempts = this.list()
    const recovered: LaunchAttempt[] = []
    const next = attempts.map((attempt) => {
      if (!ACTIVE_STATUSES.has(attempt.status)) return attempt
      const updated: LaunchAttempt = {
        ...attempt,
        status: 'interrupted',
        endedAt: now,
        updatedAt: now,
        lastError: attempt.lastError || 'TaskWraith restarted before this launch finished.'
      }
      recovered.push(updated)
      return updated
    })
    if (recovered.length > 0) this.write(next)
    return recovered
  }

  createId(): string {
    return `launch-attempt-${randomUUID()}`
  }

  private read(): unknown[] {
    try {
      const text = fs.readFileSync(this.storagePath, 'utf8')
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private write(attempts: LaunchAttempt[]): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(attempts, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, this.storagePath)
  }
}

function isLaunchAttempt(value: unknown): value is LaunchAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as Partial<LaunchAttempt>
  return (
    attempt.schemaVersion === 1 &&
    typeof attempt.id === 'string' &&
    typeof attempt.targetId === 'string' &&
    typeof attempt.targetSnapshotHash === 'string' &&
    typeof attempt.workspacePath === 'string' &&
    typeof attempt.cwd === 'string' &&
    typeof attempt.commandRaw === 'string' &&
    Array.isArray(attempt.argv) &&
    typeof attempt.status === 'string' &&
    typeof attempt.startedAt === 'string' &&
    typeof attempt.updatedAt === 'string' &&
    typeof attempt.outputTail === 'string' &&
    typeof attempt.outputTailBytes === 'number' &&
    typeof attempt.outputTruncated === 'boolean'
  )
}
