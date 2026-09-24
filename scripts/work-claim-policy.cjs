'use strict'

const MAX_LEASE_MS = 20 * 60 * 1000
const CONTRIBUTION_PREFIX = '.WORK-IN-PROGRESS-taskwraith-contribution-'

function markerKind(file, agent, derived = false) {
  if (
    derived ||
    file.startsWith('.WORK-IN-PROGRESS-taskwraith-runtime-') ||
    agent === 'taskwraith-runtime'
  )
    return 'runtime'
  if (file.startsWith(CONTRIBUTION_PREFIX) || agent === 'taskwraith-contribution')
    return 'contribution'
  return 'manual'
}

function markerMetadata(text) {
  const block = text.match(/(?:^|\r?\n)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1]
  if (!block) return null
  const values = {}
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9]*):[ \t]*(.*?)\s*$/)
    if (!match) continue
    if (Object.hasOwn(values, match[1])) return null
    let value = match[2]
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        return null
      }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

function contributionExpiry(file, text) {
  if (!/^\.WORK-IN-PROGRESS-taskwraith-contribution-[a-f0-9]{64}\.md$/.test(file)) return null
  const data = markerMetadata(text)
  if (
    !data ||
    markerKind(file, data.agent, data.derived === 'true') !== 'contribution' ||
    data.agent !== 'taskwraith-contribution'
  )
    return null
  const id = file.slice(CONTRIBUTION_PREFIX.length, -3)
  const started = Date.parse(data.started)
  const expires = Date.parse(data.expires)
  if (
    data.session !== id ||
    !data.lockOwnerId ||
    !Number.isFinite(started) ||
    !Number.isFinite(expires) ||
    expires < started
  )
    return null
  return { id, owner: data.lockOwnerId, expires: Math.min(expires, started + MAX_LEASE_MS) }
}

module.exports = {
  MAX_LEASE_MS,
  CONTRIBUTION_PREFIX,
  markerKind,
  markerMetadata,
  contributionExpiry
}
