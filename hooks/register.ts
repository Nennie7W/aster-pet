import type { EngineInterface, Register, Timer } from 'claude-code'

// The pet itself is a small Windows app. The first time it's needed, this plugin
// builds it from app/ with the C# compiler Windows ships, into ~/.claude/aster, and
// starts it. After that the plugin is the app's link to Claude: it keeps
// status.json up to date, which the app reads a few times a second. Naps and stale
// moods are the app's to judge.

type Mood = 'idle' | 'thinking' | 'working' | 'waving' | 'happy' | 'oops'
type Prop = 'laptop' | 'book' | 'magnifier' | 'pencil'

const TOOLS_KEY = 'tools'
const BACK_TO_THINKING_MS = 1500
const BUILD_LIMIT_MS = 60_000
const NEEDS_YOU = 'I need you for a sec!'

// Bookkeeping calls Aster doesn't look up for: they'd only make it flicker.
const QUIET_TOOL = /update_plan|wrap_up|mark_chapter|ToolSearch/

let tools = 0
let running = 0
let isTurnOpen = false
let settleTimer: Timer | undefined

function whatItDoes(tool: string): { mood: Mood; prop: Prop; line: string } {
  const working = (prop: Prop, line: string) => ({ mood: 'working' as const, prop, line })

  if (tool === 'AskUserQuestion') return { mood: 'waving', prop: 'laptop', line: NEEDS_YOU }
  if (tool === 'Read') return working('book', 'Reading a file…')
  if (tool === 'Grep' || tool === 'Glob') return working('magnifier', 'Searching…')
  if (/^(Web|mcp__Claude_Browser|mcp__claude-in-chrome)/.test(tool)) {
    return working('magnifier', 'Looking around the web…')
  }
  if (/^(Edit|Write|NotebookEdit)$/.test(tool)) return working('pencil', 'Writing…')
  if (tool === 'Bash' || tool === 'PowerShell') return working('laptop', 'Running a command…')
  if (tool === 'Agent' || tool === 'Workflow') return working('laptop', 'Sending out a helper…')

  return working('laptop', 'Working…')
}

async function folder($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

  return `${home}/.claude/aster`
}

// A pet missing a beat is never worth failing the work, so nothing here throws.
async function tell(
  $: EngineInterface,
  mood: Mood,
  line = '',
  prop: Prop = 'laptop',
): Promise<void> {
  try {
    const at = await $.clock.now()
    await $.fs.write(
      `${await folder($)}/status.json`,
      JSON.stringify({ mood, prop, line, at, tools }),
    )
  } catch {
    // The next status says it all again.
  }
}

function backslashes(path: string): string {
  return path.replaceAll('/', '\\')
}

async function build($: EngineInterface, windir: string, exe: string): Promise<boolean> {
  await tell($, 'idle') // makes the folder the compiler writes into
  const fx = `${windir}\\Microsoft.NET\\Framework64\\v4.0.30319`
  const app = `${backslashes($.plugin.root)}\\app`
  const { exitCode, stdout } = await $.process.run(
    [
      `${fx}\\csc.exe`,
      '/nologo',
      '/optimize',
      '/target:winexe',
      `/out:${backslashes(exe)}`,
      `/lib:${fx}\\WPF`,
      '/r:PresentationFramework.dll',
      '/r:PresentationCore.dll',
      '/r:WindowsBase.dll',
      '/r:System.Xaml.dll',
      '/r:System.Web.Extensions.dll',
      `/resource:${app}\\frames\\sheet.png,sheet.png`,
      `/resource:${app}\\frames\\icons.png,icons.png`,
      `/resource:${app}\\frames\\manifest.json,manifest.json`,
      `${app}\\Aster.cs`,
      `${app}\\Menu.cs`,
    ],
    { timeoutMs: BUILD_LIMIT_MS },
  )
  if (exitCode === 0) return true

  $.ui.log(`the app did not build: ${stdout}`, { to: 'debug' })
  $.ui.toast('Aster could not be built on this PC. Details are in the debug log.')

  return false
}

// Start-Process, not run directly: `$.process.run` waits for what it starts.
// A second Aster leaves at once, and one put away stays away unless summoned.
// Answers whether Aster could be brought out at all: Windows only, for now.
async function bringOut($: EngineInterface, isSummoned: boolean): Promise<boolean> {
  try {
    const windir = await $.env.get('WINDIR')
    if (!windir) return false

    const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    const exe = `${await folder($)}/Aster-${JSON.parse(manifest).version}.exe`
    if (!(await $.fs.exists(exe)) && !(await build($, windir, exe))) return false

    const flag = isSummoned ? " -ArgumentList '--summon'" : ''
    await $.process.run([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${backslashes(exe).replaceAll("'", "''")}'${flag}`,
    ])

    return true
  } catch {
    return false // Claude carries on without its pet.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    tools = Number((await $.store.get(TOOLS_KEY)) ?? 0) || 0
    await $.command.register({
      name: 'aster',
      description: 'Bring Aster, the little desktop pet, back onto your screen',
    })
    void bringOut($, false)

    return next(e)
  })

  on('command.run', { command: 'aster' }, async $ => {
    const isOut = await bringOut($, true)

    return {
      text: isOut
        ? 'Aster is on your desktop.'
        : "Aster couldn't start: its desktop app only runs on Windows for now.",
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnOpen = true
      running = 0
      settleTimer?.cancel()
      await tell($, 'thinking', 'Thinking…')
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (QUIET_TOOL.test(tool)) return next(e)

    running++
    tools++
    settleTimer?.cancel()
    const { mood, prop, line } = whatItDoes(tool)
    await tell($, mood, line, prop)
    void $.store.set(TOOLS_KEY, tools).catch(() => undefined)

    const ran = await next(e)

    running = Math.max(0, running - 1)
    if (ran.deny !== undefined || ran.isError) {
      await tell($, 'oops', 'Oops, that one went wrong.')
    }
    if (running === 0 && isTurnOpen) {
      // Calls usually come in runs: wait before looking up from the work.
      settleTimer = $.clock.after(BACK_TO_THINKING_MS, () => {
        if (running === 0 && isTurnOpen) void tell($, 'thinking')
      })
    }

    return ran
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      await tell($, 'waving', NEEDS_YOU)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnOpen = false
      running = 0
      settleTimer?.cancel()
      if (e.reason === 'answer') await tell($, 'happy', 'All done!')
      else if (e.reason === 'aborted') await tell($, 'idle')
      else await tell($, 'oops', 'Something stopped me there.')
    }

    return next(e)
  })
}
