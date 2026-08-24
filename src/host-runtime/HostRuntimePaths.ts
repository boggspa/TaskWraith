import { join } from 'node:path'

/** Durable Host state directory under an injected profile/userData root. */
export const HOST_RUNTIME_DATA_DIR_NAME = 'host-runtime'

/** Absolute Host data directory for an injected userData path. Pure. */
export function hostRuntimeDataDir(userDataPath: string): string {
  return join(userDataPath, HOST_RUNTIME_DATA_DIR_NAME)
}
