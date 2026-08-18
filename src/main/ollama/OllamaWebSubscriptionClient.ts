export interface OllamaWebSubscriptionResult {
  sessionSpent?: number
  sessionResetDescription?: string
  weeklySpent?: number
  weeklyResetDescription?: string
}

function extractPercent(chunk: string): number | undefined {
  const match = chunk.match(/(\d+(?:\.\d+)?)%/i)
  if (match) return Number(match[1])
  return undefined
}

function extractResetDesc(chunk: string): string | undefined {
  const match = chunk.match(/Resets? in [^<]+/i)
  if (match) return match[0]
  return undefined
}

export async function fetchOllamaWebSubscription(
  cookieHeader: string
): Promise<OllamaWebSubscriptionResult | null> {
  try {
    const res = await fetch('https://ollama.com/settings', {
      headers: {
        Cookie: cookieHeader,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    })
    if (!res.ok) return null
    const html = await res.text()
    if (html.includes('Sign in to Ollama') || (html.includes('/login') && !html.includes('Session usage') && !html.includes('Weekly usage'))) {
      return null
    }

    const sessionIdx = html.toLowerCase().indexOf('session usage') !== -1 
      ? html.toLowerCase().indexOf('session usage')
      : html.toLowerCase().indexOf('session')
      
    const weeklyIdx = html.toLowerCase().indexOf('weekly usage') !== -1
      ? html.toLowerCase().indexOf('weekly usage')
      : html.toLowerCase().indexOf('weekly')

    let sessionSpent: number | undefined
    let sessionResetDescription: string | undefined
    if (sessionIdx !== -1) {
      const endIdx = weeklyIdx !== -1 && weeklyIdx > sessionIdx ? weeklyIdx : Math.min(html.length, sessionIdx + 1000)
      const chunk = html.slice(sessionIdx, endIdx)
      sessionSpent = extractPercent(chunk)
      sessionResetDescription = extractResetDesc(chunk)
    }

    let weeklySpent: number | undefined
    let weeklyResetDescription: string | undefined
    if (weeklyIdx !== -1) {
      const chunk = html.slice(weeklyIdx, Math.min(html.length, weeklyIdx + 1000))
      weeklySpent = extractPercent(chunk)
      weeklyResetDescription = extractResetDesc(chunk)
    }

    if (sessionSpent === undefined && weeklySpent === undefined) return null

    return {
      sessionSpent,
      sessionResetDescription,
      weeklySpent,
      weeklyResetDescription
    }
  } catch {
    return null
  }
}
