/**
 * Which way round the terminal is.
 *
 * A theme picked by name is a preference; a theme picked by `auto` is a
 * *measurement*, and the thing worth measuring is the terminal, not the OS. A
 * user in macOS light mode running a dark terminal profile is common, and
 * asking the OS gets that user a light theme on a black background.
 *
 * So the ladder below asks progressively less trustworthy sources, and every
 * rung is allowed to answer "I don't know" rather than guess:
 *
 *   1. `TASKWRAITH_APPEARANCE` / `LC_TASKWRAITH_APPEARANCE` — an explicit
 *      answer, and the only rung that survives SSH. `LC_*` is the form to
 *      export: OpenSSH's default `AcceptEnv LC_*` forwards it, where a bare
 *      name is dropped at the hop.
 *   2. `COLORFGBG` — set by a minority of terminals, but free and synchronous.
 *   3. An OSC 11 query — asks the terminal for its own background colour. The
 *      only rung that is actually correct, and the only one that costs a
 *      round trip on the tty.
 *   4. OS appearance — a guess about the terminal, made from its surroundings.
 *
 * The whole ladder is skippable: `--theme <name>` never reaches this file.
 */

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** Ask the terminal to report its background colour. */
export const OSC11_QUERY = `${ESC}]11;?${BEL}`

export type TuiAppearance = 'dark' | 'light'

/**
 * Luminance below which a background counts as dark.
 *
 * 0.5 in *relative luminance*, not in raw channel average — the same threshold
 * Vibe uses, and a much better midpoint than `#808080` because it accounts for
 * green dominating perceived brightness.
 */
const DARK_LUMINANCE_THRESHOLD = 0.5

/* -------------------------------------------------------------------------
 * Rung 1 + 2: environment
 * ---------------------------------------------------------------------- */

function normaliseAppearance(value: string): TuiAppearance | undefined {
  const wanted = value.trim().toLowerCase()
  if (wanted === 'dark') return 'dark'
  if (wanted === 'light') return 'light'
  return undefined
}

/**
 * `COLORFGBG` is `<foreground>;<background>` in terminal palette indices, and
 * some terminals emit a three-field form with the cursor colour in the middle.
 * The background is always the last field.
 *
 * Index 0-6 and 8 are the dark half of the ANSI palette; 7 and 9-15 are the
 * light half. `default` appears in the wild and means exactly what it says,
 * which is not an answer.
 */
export function appearanceFromColorFgBg(value: string | undefined): TuiAppearance | undefined {
  if (!value) return undefined
  const background = value.split(';').pop()?.trim()
  if (!background || !/^\d+$/.test(background)) return undefined
  const index = Number(background)
  if (index > 15) return undefined
  return index === 7 || index >= 9 ? 'light' : 'dark'
}

export function appearanceFromEnv(env: NodeJS.ProcessEnv): TuiAppearance | undefined {
  const declared =
    normaliseAppearance(String(env.TASKWRAITH_APPEARANCE || '')) ??
    normaliseAppearance(String(env.LC_TASKWRAITH_APPEARANCE || ''))
  if (declared) return declared
  return appearanceFromColorFgBg(env.COLORFGBG)
}

/* -------------------------------------------------------------------------
 * Rung 3: the terminal itself
 * ---------------------------------------------------------------------- */

/**
 * Terminal multiplexers must not be probed.
 *
 * tmux and screen answer for themselves rather than passing the query to the
 * outer terminal, and the reply — when there is one — describes the
 * multiplexer's idea of a background rather than the pane the user is looking
 * at. Worse, a swallowed query leaves the probe waiting out its whole budget
 * on every launch. Skipping is both more correct and faster.
 */
export function isInsideMultiplexer(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TMUX || env.STY || env.ZELLIJ)
}

/**
 * Classify an OSC 11 reply.
 *
 * The reply is `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` with a BEL or ST terminator, and
 * the components are variable width — 1 to 4 hex digits each — so each is
 * scaled by its own maximum rather than assumed to be 16-bit.
 */
export function appearanceFromOsc11Reply(reply: string): TuiAppearance | undefined {
  const match = /\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply)
  if (!match) return undefined
  const [red, green, blue] = match.slice(1, 4).map((raw) => {
    const maximum = 16 ** raw.length - 1
    return maximum > 0 ? Number.parseInt(raw, 16) / maximum : 0
  })
  const linearize = (channel: number): number =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  const luminance = 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
  return luminance < DARK_LUMINANCE_THRESHOLD ? 'dark' : 'light'
}

/** The terminal I/O an OSC 11 probe needs, narrowed so it can be faked. */
export interface TuiAppearanceProbeIo {
  isTty: boolean
  /** True when input is already queued: someone is typing, so do not steal it. */
  hasPendingInput(): boolean
  setRawMode(raw: boolean): void
  write(data: string): void
  read(timeoutMs: number): Promise<string>
}

/** How long to wait for a reply before giving up and moving down the ladder. */
export const OSC11_TIMEOUT_MS = 250

/**
 * Ask the terminal for its background colour.
 *
 * This briefly takes ownership of terminal input, which is why it is guarded so
 * heavily and why callers must run it exactly once at startup. A terminal that
 * does not implement OSC 11 simply never replies, and the budget above is the
 * entire cost of finding that out.
 */
export async function probeTerminalAppearance(
  io: TuiAppearanceProbeIo,
  env: NodeJS.ProcessEnv
): Promise<TuiAppearance | undefined> {
  if (!io.isTty || isInsideMultiplexer(env)) return undefined
  // Anything already queued is the user's keystrokes. Reading here would eat
  // them, and a probe is never worth a swallowed keypress.
  if (io.hasPendingInput()) return undefined
  try {
    io.setRawMode(true)
    io.write(OSC11_QUERY)
    return appearanceFromOsc11Reply(await io.read(OSC11_TIMEOUT_MS))
  } catch {
    return undefined
  } finally {
    try {
      io.setRawMode(false)
    } catch {
      // Restoring cooked mode is best-effort: the tty may already be gone.
    }
  }
}

/* -------------------------------------------------------------------------
 * Rung 4: the surrounding OS
 * ---------------------------------------------------------------------- */

/** Runs a command and returns its stdout, or undefined if it could not run. */
export type TuiCommandRunner = (command: string, args: string[]) => string | undefined

export function appearanceFromSystem(
  platform: NodeJS.Platform,
  run: TuiCommandRunner
): TuiAppearance | undefined {
  if (platform === 'darwin') {
    // The key is absent in light mode, so "the command failed" and "the user is
    // in light mode" are the same observation. Absent means light.
    const style = run('defaults', ['read', '-g', 'AppleInterfaceStyle'])
    return style === undefined ? 'light' : style.includes('Dark') ? 'dark' : 'light'
  }
  if (platform === 'linux') {
    const scheme = run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])
    if (scheme === undefined) return undefined
    if (scheme.includes('prefer-dark')) return 'dark'
    if (scheme.includes('prefer-light')) return 'light'
    return undefined
  }
  return undefined
}

/* -------------------------------------------------------------------------
 * The ladder
 * ---------------------------------------------------------------------- */

export interface TuiAppearanceSources {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  run: TuiCommandRunner
  probe?: TuiAppearanceProbeIo
}

/**
 * Walk the ladder and commit to an answer.
 *
 * Dark is the floor rather than a fifth guess: every terminal that has never
 * been configured ships dark, and a wrong dark theme stays readable on a light
 * terminal in a way a wrong light theme does not on a dark one.
 */
/**
 * The ladder without the tty probe.
 *
 * The probe takes ownership of terminal input, which is safe exactly once at
 * startup and never safe again: the interactive TUI has its own reader attached
 * from then on, and a second probe would race it for keystrokes. The `/theme`
 * picker therefore previews `auto` from the synchronous rungs alone, and is
 * honest about answering from the OS rather than the terminal.
 */
export function resolveTuiAppearanceWithoutProbe(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: TuiCommandRunner
): TuiAppearance {
  return appearanceFromEnv(env) ?? appearanceFromSystem(platform, run) ?? 'dark'
}

export async function resolveTuiAppearance(sources: TuiAppearanceSources): Promise<TuiAppearance> {
  const declared = appearanceFromEnv(sources.env)
  if (declared) return declared
  if (sources.probe) {
    const probed = await probeTerminalAppearance(sources.probe, sources.env)
    if (probed) return probed
  }
  return appearanceFromSystem(sources.platform, sources.run) ?? 'dark'
}
