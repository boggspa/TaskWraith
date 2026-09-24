import { contextBridge, ipcRenderer } from 'electron'
import {
  APPLICATION_MENU_COMMAND,
  APPLICATION_MENU_READY,
  isApplicationMenuCommand,
  type ApplicationMenuBridge
} from '../shared/applicationMenu'

const applicationMenu: ApplicationMenuBridge = {
  onCommand(listener) {
    const handler = (_event: unknown, command: unknown): void => {
      if (isApplicationMenuCommand(command)) listener(command)
    }
    ipcRenderer.on(APPLICATION_MENU_COMMAND, handler)
    // React has installed its handler, including on a newly-created window.
    ipcRenderer.send(APPLICATION_MENU_READY)
    return () => ipcRenderer.removeListener(APPLICATION_MENU_COMMAND, handler)
  }
}

contextBridge.exposeInMainWorld('applicationMenu', applicationMenu)
