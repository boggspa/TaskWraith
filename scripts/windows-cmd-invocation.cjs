const UNSAFE_CMD_TOKEN = /[\0\r\n"%!^&|<>]/

function quoteWindowsCmdToken(value, label = 'command argument') {
  const token = String(value)
  if (!token || UNSAFE_CMD_TOKEN.test(token)) {
    throw new Error(
      `Refusing unsafe ${label} for cmd.exe invocation; contains a shell metacharacter`
    )
  }
  return `"${token}"`
}

function createWindowsCmdInvocation(scriptPath, args = [], env = process.env) {
  const command = String(env.ComSpec || env.COMSPEC || 'cmd.exe')
  const commandLine = [
    'call',
    quoteWindowsCmdToken(scriptPath, 'script path'),
    ...args.map((arg) => quoteWindowsCmdToken(arg))
  ].join(' ')
  return {
    command,
    arguments: ['/d', '/s', '/c', commandLine],
    // Node's default Windows argv quoting targets the C runtime. cmd.exe uses
    // different parsing rules, so the embedded quotes otherwise arrive as
    // literal backslash-quote sequences (\"path\") and the batch file cannot
    // be found. Every caller must merge these options into spawn/spawnSync.
    spawnOptions: { windowsVerbatimArguments: true }
  }
}

function resolvePlatformCommandInvocation(
  command,
  args = [],
  platform = process.platform,
  env = process.env
) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return createWindowsCmdInvocation(command, args, env)
  }
  return { command, arguments: args, spawnOptions: {} }
}

module.exports = {
  createWindowsCmdInvocation,
  quoteWindowsCmdToken,
  resolvePlatformCommandInvocation
}
