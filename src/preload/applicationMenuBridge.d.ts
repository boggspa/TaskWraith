import type { ApplicationMenuBridge } from '../shared/applicationMenu'

declare global {
  interface Window {
    applicationMenu: ApplicationMenuBridge
  }
}
