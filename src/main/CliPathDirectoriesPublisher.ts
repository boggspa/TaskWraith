import { __resetHostToolResolverCache } from './HostToolResolver'
import { setUserCliSearchDirs } from './providers/CliSearchDirs'

/**
 * The one place that pushes `AppSettings.cliPathDirectories` into CLI resolution.
 *
 * Two things have to happen together, and forgetting the second is the bug that
 * makes the setting look broken: publish the directories, and — only when they
 * actually changed — drop the host-tool resolution cache. `HostToolResolver`
 * caches a "missing" answer for the process lifetime, so a user who adds the
 * directory that finally contains `gh` would otherwise still be told gh is not
 * installed until they relaunch the app, which is exactly the friction this
 * setting exists to remove.
 *
 * Kept out of the store module so the coupling is one explicit call rather than
 * a store that reaches into the resolver.
 */
export function publishCliPathDirectories(dirs: readonly string[] | null | undefined): boolean {
  const changed = setUserCliSearchDirs(dirs)
  if (changed) __resetHostToolResolverCache()
  return changed
}
