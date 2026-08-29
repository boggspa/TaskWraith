import {
  CanvasBrowserProfile,
  type CanvasBrowserProfileController
} from '../canvas/CanvasBrowserProfile'
import { partitionForWebSiteLogin } from '../../shared/webSiteLogin'

/**
 * One Canvas browser profile per authorized site.
 *
 * `CanvasBrowserProfile` binds to exactly ONE Electron session and throws if a
 * second one shows up (`bindSession`), so the per-site split has to be one
 * profile INSTANCE per site rather than one profile spanning many partitions.
 * That is also the shape we want: each site keeps its own request routing,
 * permission denial and cookie jar, and nothing an agent does on one site can
 * see another's.
 *
 * The app-wide `persist:taskwraith-canvas-browser-v1` profile is deliberately
 * NOT owned here. It stays exactly as it is for unbound canvases, so this
 * registry adds a capability without changing the behaviour of any surface that
 * has not opted into a site.
 */
export interface WebSiteProfileRegistryDeps {
  /** Injectable so the registry is testable without Electron. */
  createProfile?: (partition: string) => CanvasBrowserProfileController
}

export class WebSiteProfileRegistry {
  private readonly profiles = new Map<string, CanvasBrowserProfileController>()
  private readonly createProfile: (partition: string) => CanvasBrowserProfileController

  constructor(deps: WebSiteProfileRegistryDeps = {}) {
    this.createProfile =
      deps.createProfile ?? ((partition) => new CanvasBrowserProfile({ partition }))
  }

  /** Stable per site: repeated calls return the same profile, so a site's jar
   *  survives closing and reopening its canvases. */
  profileFor(siteId: string): CanvasBrowserProfileController {
    const existing = this.profiles.get(siteId)
    if (existing) return existing
    // Throws on an id that could escape the partition namespace.
    const profile = this.createProfile(partitionForWebSiteLogin(siteId))
    this.profiles.set(siteId, profile)
    return profile
  }

  /** True once a profile has been materialized for this site. */
  has(siteId: string): boolean {
    return this.profiles.has(siteId)
  }

  /** Sign out: drop the site's cookies and cache, keep the catalogue row.
   *  Rejects while the site still has open surfaces — clearing under a live
   *  page leaves the page authenticated in memory and the jar empty, which
   *  reads to the user as "sign out did nothing". */
  async clearSite(siteId: string): Promise<void> {
    // MATERIALIZE rather than `profiles.get`. The map is populated only when a
    // canvas binds, so after a restart it is empty — and a `get`-and-return-early
    // made "Sign out" resolve successfully while clearing nothing, leaving the
    // persisted cookies intact. That is the same "sign out did nothing" failure
    // the open-surface check below guards against, reached by another route.
    await this.profileFor(siteId).clearBrowsingData()
  }

  /** Forget: clear, then drop the profile so a later sign-in starts clean. */
  async forgetSite(siteId: string): Promise<void> {
    await this.clearSite(siteId)
    this.profiles.delete(siteId)
  }

  /** Sites with at least one live surface, so a caller can explain a refusal
   *  by naming them instead of failing anonymously. */
  activeSiteIds(): string[] {
    const out: string[] = []
    for (const [siteId, profile] of this.profiles) {
      if (profile.activeSurfaceCount > 0) out.push(siteId)
    }
    return out
  }
}
