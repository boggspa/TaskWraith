import { BrowserWindow, session } from 'electron'

export async function importMistralWebSession(): Promise<string | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'Sign in to Mistral',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    win.on('closed', () => {
      resolve(null)
    })

    const interval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(interval)
        return
      }
      try {
        const cookies = await win.webContents.session.cookies.get({ domain: '.mistral.ai' })
        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        if (
          cookies.some(
            (c) =>
              c.name.includes('session') || c.name.includes('auth') || c.name.includes('mistral')
          )
        ) {
          if (
            win.webContents.getURL().includes('/subscription') ||
            win.webContents.getURL().includes('admin.mistral.ai')
          ) {
            clearInterval(interval)
            resolve(cookieStr)
            win.close()
          }
        }
      } catch {}
    }, 2000)

    win.loadURL('https://admin.mistral.ai/')
  })
}

export async function importOllamaWebSession(): Promise<string | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'Sign in to Ollama',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    win.on('closed', () => {
      resolve(null)
    })

    const interval = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(interval)
        return
      }
      try {
        const cookies = await win.webContents.session.cookies.get({ domain: '.ollama.com' })
        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        if (cookies.some((c) => c.name.includes('session') || c.name.includes('auth'))) {
          clearInterval(interval)
          resolve(cookieStr)
          win.close()
        }
      } catch {}
    }, 2000)

    win.loadURL('https://ollama.com/login')
  })
}
