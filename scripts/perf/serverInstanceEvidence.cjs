'use strict'

const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const {
  probeHostBootstrapIdentity,
  readHostDiscovery,
  HOST_BOOT_EPOCH_PATTERN
} = require('./hostWelcomeProbe.cjs')

/** Allowlisted identity only; discovery is re-read after the authenticated handshake. */
async function collectServerInstanceEvidence(options = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (typeof options.userDataPath !== 'string' || !path.isAbsolute(options.userDataPath)) {
    return fail('profile_path_required')
  }
  const userDataPath = path.resolve(options.userDataPath)
  const profileHash = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16)
  let probe
  let reread
  try {
    probe = await (options.probe || probeHostBootstrapIdentity)({
      userDataPath,
      fs: options.fs,
      connect: options.connect,
      timeoutMs: options.timeoutMs,
      maxWaitMs: options.maxWaitMs
    })
    if (!probe || !probe.ok) return fail('authenticated_identity_unavailable')
    reread = (options.readDiscovery || readHostDiscovery)(userDataPath, { fs: options.fs })
  } catch {
    return fail('identity_probe_failed')
  }
  const identity = probe.expectedIdentity
  const discovery = reread && reread.ok && reread.discovery
  if (
    !identity ||
    typeof identity.instanceId !== 'string' ||
    !identity.instanceId ||
    identity.instanceId.length > 512 ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 0 ||
    typeof identity.bootEpoch !== 'string' ||
    !HOST_BOOT_EPOCH_PATTERN.test(identity.bootEpoch)
  ) {
    return fail('complete_host_identity_required')
  }
  if (
    !discovery ||
    !probe.discovery ||
    discovery.pid !== identity.pid ||
    discovery.startedAt !== probe.discovery.startedAt ||
    (discovery.hostId !== undefined && discovery.hostId !== identity.instanceId) ||
    typeof discovery.socketPath !== 'string'
  ) {
    return fail('discovery_identity_changed')
  }
  const socketPath = discovery.socketPath
  const platform = options.platform || process.platform
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  const socketNamespace =
    platform === 'win32'
      ? `\\\\.\\pipe\\taskwraith-host-v2-${profileHash}`
      : path.join(tmpdir(), `twh2-${uid}-${profileHash}`)
  const matches =
    platform === 'win32'
      ? socketPath === socketNamespace
      : socketPath === path.join(socketNamespace, 'taskwraith-host-v2.sock')
  if (!matches) return fail('profile_socket_namespace_mismatch')
  return {
    ok: true,
    evidence: {
      schemaVersion: 1,
      source: 'authenticated_host_welcome',
      profileHash,
      hostId: identity.instanceId,
      hostPid: identity.pid,
      bootEpoch: identity.bootEpoch,
      generation: identity.generation,
      socketNamespace
    }
  }
}

module.exports = { collectServerInstanceEvidence }
