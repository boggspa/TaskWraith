export interface RendererResponsivenessIncident {
  incidentId: string
  webContentsId: number
  startedAtMs: number
}

export interface RendererResponsivenessRecovery {
  incident: RendererResponsivenessIncident
  recoveredAtMs: number
  durationMs: number
}

export interface RendererResponsivenessTrackerOptions {
  now?: () => number
  createIncidentId?: () => string
}

/** Pairs Electron's unresponsive/responsive events and suppresses duplicates. */
export class RendererResponsivenessTracker {
  private readonly incidents = new Map<number, RendererResponsivenessIncident>()
  private readonly now: () => number
  private readonly createIncidentId: () => string

  constructor(options: RendererResponsivenessTrackerOptions = {}) {
    this.now = options.now ?? Date.now
    this.createIncidentId =
      options.createIncidentId ?? (() => `renderer-hang-${this.now().toString(36)}`)
  }

  begin(webContentsId: number): RendererResponsivenessIncident | null {
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 0) return null
    if (this.incidents.has(webContentsId)) return null
    const incident = {
      incidentId: this.createIncidentId(),
      webContentsId,
      startedAtMs: this.now()
    }
    this.incidents.set(webContentsId, incident)
    return incident
  }

  recover(webContentsId: number): RendererResponsivenessRecovery | null {
    const incident = this.incidents.get(webContentsId)
    if (!incident) return null
    this.incidents.delete(webContentsId)
    const recoveredAtMs = this.now()
    return {
      incident,
      recoveredAtMs,
      durationMs: Math.max(0, recoveredAtMs - incident.startedAtMs)
    }
  }

  clear(webContentsId: number): void {
    this.incidents.delete(webContentsId)
  }

  activeCount(): number {
    return this.incidents.size
  }
}
