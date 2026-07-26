import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000
const PRESENCE_INTERVAL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

declare const __TASKWRAITH_ACTIVITY_ENDPOINT__: string

export interface ActivityReportingCheckin {
  schema: 1
  event: 'app_active'
  day: string
  appVersion: string
  platform: 'macos' | 'windows' | 'linux'
  architecture: 'arm64' | 'x64' | 'universal' | 'unknown'
  channel: 'stable' | 'nightly'
}

export interface ActivityPresenceLease {
  schema: 1
  event: 'app_presence'
  lease: string
}

export type ActivityReportingResult =
  | 'sent'
  | 'disabled'
  | 'not_configured'
  | 'invalid_configuration'
  | 'already_reported'
  | 'failed'

export interface ActivityReportingServiceOptions {
  endpoint: string
  statePath: string
  isEnabled: () => boolean
  appVersion: string
  platform?: NodeJS.Platform
  architecture?: string
  channel?: 'stable' | 'nightly'
  request?: typeof fetch
  now?: () => Date
  createPresenceLease?: () => string
}

interface ActivityReportingState {
  schema: 1
  lastReportedDay: string
}

export function bundledActivityReportingEndpoint(): string {
  return typeof __TASKWRAITH_ACTIVITY_ENDPOINT__ === 'string'
    ? __TASKWRAITH_ACTIVITY_ENDPOINT__
    : ''
}

function activityPlatform(platform: NodeJS.Platform): ActivityReportingCheckin['platform'] | null {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return null
}

function activityArchitecture(architecture: string): ActivityReportingCheckin['architecture'] {
  if (architecture === 'arm64' || architecture === 'x64' || architecture === 'universal') {
    return architecture
  }
  return 'unknown'
}

export function normalizeActivityReportingEndpoint(value: string): string | null {
  return normalizeActivityEndpoint(value, '/v1/checkin')
}

export function normalizeActivityPresenceEndpoint(value: string): string | null {
  return normalizeActivityEndpoint(value, '/v1/presence')
}

function normalizeActivityEndpoint(
  value: string,
  destination: '/v1/checkin' | '/v1/presence'
): string | null {
  if (!value.trim()) return null
  try {
    const url = new URL(value)
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }
    const pathname = url.pathname.replace(/\/+$/, '')
    if (pathname && pathname !== '/v1/checkin' && pathname !== '/v1/presence') return null
    url.pathname = destination
    return url.toString()
  } catch {
    return null
  }
}

export function buildActivityReportingCheckin(input: {
  now: Date
  appVersion: string
  platform: NodeJS.Platform
  architecture: string
  channel?: 'stable' | 'nightly'
}): ActivityReportingCheckin | null {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.appVersion)) return null
  const platform = activityPlatform(input.platform)
  if (!platform) return null
  return {
    schema: 1,
    event: 'app_active',
    day: input.now.toISOString().slice(0, 10),
    appVersion: input.appVersion,
    platform,
    architecture: activityArchitecture(input.architecture),
    channel: input.channel ?? (input.appVersion.includes('-') ? 'nightly' : 'stable')
  }
}

export class ActivityReportingService {
  private readonly request: typeof fetch
  private readonly now: () => Date
  private readonly createPresenceLease: () => string
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private reportPending: Promise<ActivityReportingResult> | null = null
  private presencePending: Promise<ActivityReportingResult> | null = null
  private presenceRefreshQueued = false
  private presenceLease: string | null = null

  constructor(private readonly options: ActivityReportingServiceOptions) {
    this.request = options.request ?? fetch
    this.now = options.now ?? (() => new Date())
    this.createPresenceLease =
      options.createPresenceLease ?? (() => randomBytes(16).toString('base64url'))
  }

  start(): void {
    if (this.reportTimer || this.presenceTimer) return
    void this.checkNow()
    void this.refreshPresence()
    this.reportTimer = setInterval(() => {
      void this.checkNow()
    }, REPORT_INTERVAL_MS)
    this.reportTimer.unref?.()
    this.presenceTimer = setInterval(() => {
      void this.refreshPresence()
    }, PRESENCE_INTERVAL_MS)
    this.presenceTimer.unref?.()
  }

  stop(): void {
    if (this.reportTimer) clearInterval(this.reportTimer)
    if (this.presenceTimer) clearInterval(this.presenceTimer)
    this.reportTimer = null
    this.presenceTimer = null
  }

  checkNow(): Promise<ActivityReportingResult> {
    if (this.reportPending) return this.reportPending
    this.reportPending = this.runCheck().finally(() => {
      this.reportPending = null
    })
    return this.reportPending
  }

  refreshPresence(): Promise<ActivityReportingResult> {
    if (this.presencePending) {
      this.presenceRefreshQueued = true
      return this.presencePending
    }
    this.presencePending = this.runPresence().finally(() => {
      this.presencePending = null
      if (this.presenceRefreshQueued) {
        this.presenceRefreshQueued = false
        void this.refreshPresence()
      }
    })
    return this.presencePending
  }

  private async runCheck(): Promise<ActivityReportingResult> {
    if (!this.options.isEnabled()) return 'disabled'
    if (!this.options.endpoint.trim()) return 'not_configured'
    const endpoint = normalizeActivityReportingEndpoint(this.options.endpoint)
    if (!endpoint) return 'invalid_configuration'

    const checkin = buildActivityReportingCheckin({
      now: this.now(),
      appVersion: this.options.appVersion,
      platform: this.options.platform ?? process.platform,
      architecture: this.options.architecture ?? process.arch,
      channel: this.options.channel
    })
    if (!checkin) return 'invalid_configuration'
    if (this.readState()?.lastReportedDay === checkin.day) return 'already_reported'

    try {
      const response = await this.request(endpoint, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TaskWraith-Activity/1'
        },
        body: JSON.stringify(checkin)
      })
      if (!response.ok) return 'failed'
      this.writeState({ schema: 1, lastReportedDay: checkin.day })
      return 'sent'
    } catch {
      return 'failed'
    }
  }

  private async runPresence(): Promise<ActivityReportingResult> {
    const endpoint = normalizeActivityPresenceEndpoint(this.options.endpoint)
    if (!this.options.isEnabled()) {
      const lease = this.presenceLease
      this.presenceLease = null
      if (!lease) return 'disabled'
      if (!this.options.endpoint.trim()) return 'not_configured'
      if (!endpoint) return 'invalid_configuration'
      try {
        await this.request(endpoint, {
          method: 'DELETE',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'TaskWraith-Activity/1'
          },
          body: JSON.stringify({ schema: 1, event: 'app_presence', lease })
        })
      } catch {
        // A volatile receiver lease also expires naturally after its short TTL.
      }
      return 'disabled'
    }
    if (!this.options.endpoint.trim()) return 'not_configured'
    if (!endpoint) return 'invalid_configuration'

    const lease = this.presenceLease ?? this.createPresenceLease()
    if (!/^[A-Za-z0-9_-]{22}$/.test(lease)) return 'invalid_configuration'
    this.presenceLease = lease
    const body: ActivityPresenceLease = {
      schema: 1,
      event: 'app_presence',
      lease
    }
    try {
      const response = await this.request(endpoint, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'TaskWraith-Activity/1'
        },
        body: JSON.stringify(body)
      })
      return response.ok ? 'sent' : 'failed'
    } catch {
      return 'failed'
    }
  }

  private readState(): ActivityReportingState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as ActivityReportingState).schema !== 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(
          String((parsed as ActivityReportingState).lastReportedDay || '')
        )
      ) {
        return null
      }
      return parsed as ActivityReportingState
    } catch {
      return null
    }
  }

  private writeState(state: ActivityReportingState): void {
    fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true })
    const temporaryPath = `${this.options.statePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporaryPath, this.options.statePath)
  }
}
