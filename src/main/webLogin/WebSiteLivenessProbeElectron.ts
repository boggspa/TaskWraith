import { session as electronSession } from 'electron'

import type { WebSiteLivenessProbe, WebSiteLivenessResponse } from './WebSiteLoginLiveness'

/**
 * The only module that makes a real liveness request, kept apart so the
 * classifier stays pure and Electron-free.
 *
 * The request runs on the SITE'S OWN partition, which is the whole point: it
 * carries exactly the cookies that site's canvases would carry, so it answers
 * the question an agent is about to ask rather than a different one. It never
 * reads the body - only where the request settled and what status came back.
 */
export function createElectronWebSiteLivenessProbe(): WebSiteLivenessProbe {
  return async ({ url, partition }): Promise<WebSiteLivenessResponse> => {
    const response = await electronSession.fromPartition(partition).fetch(url, {
      method: 'GET',
      // Redirects are the signal: being handed to the identity provider is what
      // a dead session looks like from outside.
      redirect: 'follow',
      cache: 'no-store'
    })
    return { finalUrl: response.url || url, status: response.status }
  }
}
