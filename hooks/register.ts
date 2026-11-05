import type { EngineInterface, Register, Timer } from 'claude-code'

// The pet itself is a small Windows app. The first time it's needed, this plugin
// builds it from app/ with the C# compiler Windows ships, into ~/.claude/aster, and
// starts it. After that the plugin is the app's link to Claude: it keeps
// status.json up to date, which the app reads a few times a second. Naps and stale
// moods are the app's to judge. A session waiting on you also keeps a file of its
// own in waiting/, saying where and what it asked, so one busy session can't hide
// another that needs you. The app clears the files it's done with.

type Mood = 'idle' | 'thinking' | 'working' | 'happy' | 'oops'
type Prop = 'laptop' | 'book' | 'magnifier' | 'pencil'

const TOOLS_KEY = 'tools'
const BACK_TO_THINKING_MS = 1500
const BUILD_LIMIT_MS = 60_000
const QUESTION_LIMIT = 140
const NEEDS_YOU = 'Claude needs your input.'
const NEEDS_PERMISSION = 'Claude needs your permission.'

// Bookkeeping calls Aster doesn't look up for: they'd only make it flicker.
const QUIET_TOOL = /update_plan|wrap_up|mark_chapter|ToolSearch/
// The desktop app's way of ending a turn that can't go on without you.
const CLOSING_TOOL = /wrap_up$/
// A turn whose last words are a question is waiting too, closing marks aside.
const ENDS_ASKING = /\?[\s*_`"')\]]*$/

let tools = 0
let running = 0
let isTurnOpen = false
let blockedQuestion: string | undefined
let isAsking = false
let askingSince = 0
let settleTimer: Timer | undefined

function whatItDoes(tool: string): { mood: Mood; prop: Prop; line: string } {
  const working = (prop: Prop, line: string) => ({ mood: 'working' as const, prop, line })

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

function placeOf(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root
}

// One line of what was asked: markdown marks off, and short enough for the menu.
function shortened(question: string): string {
  const line = question.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim()

  return line.length > QUESTION_LIMIT ? `${line.slice(0, QUESTION_LIMIT - 1).trimEnd()}…` : line
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
}

async function waitingFile($: EngineInterface): Promise<string> {
  const id = (await $.session.id()).replace(/[^\w-]/g, '_')

  return `${await folder($)}/waiting/${id}.json`
}

// `since` is when Claude started waiting, however many times it says so after:
// the app gets mad by how long that's been.
async function askFor($: EngineInterface, question: string): Promise<void> {
  try {
    if (!isAsking) askingSince = await $.clock.now()
    isAsking = true
    await $.fs.write(
      await waitingFile($),
      JSON.stringify({
        isWaiting: true,
        project: placeOf(await $.session.root()),
        question: shortened(question),
        since: askingSince,
      }),
    )
  } catch {
    // Claude still gets its answer; Aster just won't be the one to say so.
  }
}

async function stopAsking($: EngineInterface): Promise<void> {
  if (!isAsking) return
  isAsking = false
  try {
    await $.fs.write(await waitingFile($), JSON.stringify({ isWaiting: false }))
  } catch {
    // The app gives up on an old wait by itself.
  }
}

// A pet missing a beat is never worth failing the work, so nothing here throws.
async function tell(
  $: EngineInterface,
  mood: Mood,
  line = '',
  prop: Prop = 'laptop',
): Promise<void> {
  await stopAsking($)
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
      blockedQuestion = undefined
      running = 0
      settleTimer?.cancel()
      await tell($, 'thinking', 'Thinking…')
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (CLOSING_TOOL.test(tool)) {
      const { blocked, ask } = e as unknown as { blocked?: boolean; ask?: string }
      if (blocked === true) blockedQuestion = ask || NEEDS_YOU
    }
    if (QUIET_TOOL.test(tool)) return next(e)

    running++
    tools++
    settleTimer?.cancel()
    if (tool === 'AskUserQuestion') {
      const { questions } = e as unknown as { questions?: { question?: string }[] }
      await askFor($, questions?.[0]?.question || NEEDS_YOU)
    } else {
      const { mood, prop, line } = whatItDoes(tool)
      await tell($, mood, line, prop)
    }
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
    if (e.notification_type === 'permission_prompt') await askFor($, e.message || NEEDS_PERMISSION)
    else if (e.notification_type === 'elicitation_dialog') await askFor($, e.message || NEEDS_YOU)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnOpen = false
      running = 0
      settleTimer?.cancel()
      if (e.reason === 'answer') {
        if (blockedQuestion) await askFor($, blockedQuestion)
        else if (ENDS_ASKING.test(e.answer)) await askFor($, lastLine(e.answer))
        else await tell($, 'happy', 'All done!')
      } else if (e.reason === 'aborted') {
        await tell($, 'idle')
      } else {
        await tell($, 'oops', 'Something stopped me there.')
      }
    }

    return next(e)
  })

  // Nobody's left to answer a closed session, so Aster stops waiting for one.
  on('session.end', async ($, e, next) => {
    await stopAsking($)

    return next(e)
  })
}
