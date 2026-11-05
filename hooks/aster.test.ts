import { expect, mock, test } from 'claude-code/testing'

type Seat = {
  entries?: Record<string, unknown>
  isBuilt?: boolean
  isDiskFull?: boolean
  doesBuildFail?: boolean
  env?: Record<string, string>
}

const WINDOWS = { USERPROFILE: 'C:/Users/me', WINDIR: 'C:\\Windows' }

const seat = (on: any, options: Seat = {}) => {
  const { entries, isBuilt = true, isDiskFull = false, doesBuildFail = false, env = WINDOWS } = options
  const said: { mood: string; prop: string; line: string; tools: number }[] = []
  const waits: { isWaiting: boolean; project?: string; question?: string; since?: number }[] = []
  const paths: string[] = []
  const commands: string[][] = []
  on('command.register', () => ({ value: { command: 'aster' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: JSON.stringify({ version: '9.9.9' }) }))
  on('fs.exists', () => ({ value: isBuilt }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    if (isDiskFull) throw new Error('disk full')
    const path = e.path.replaceAll('\\', '/')
    paths.push(path)
    ;(path.includes('/waiting/') ? waits : said).push(JSON.parse(e.text))

    return { value: undefined }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    commands.push(e.argv)
    const isCompiler = e.argv[0].endsWith('csc.exe')

    return {
      value: { exitCode: isCompiler && doesBuildFail ? 1 : 0, stdout: 'nope', stderr: '' },
    }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: 'C:\\work\\my-app' }))
  mock.env(on, env)
  mock.store(on, entries)

  return { said, waits, paths, commands, clock: mock.clock(on) }
}

const start = ($: any) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('a session starts the app it already built, without summoning one put away', async ($, on) => {
  const { commands, clock } = seat(on)
  await start($)
  await clock.settle?.()

  expect(commands).toHaveLength(1)
  expect(commands[0].join(' ')).toContain('C:\\Users\\me\\.claude\\aster\\Aster-9.9.9.exe')
  expect(commands[0].join(' ')).not.toContain('--summon')
})

test('the first session builds the app with Windows own compiler, then starts it', async ($, on) => {
  const { commands, clock } = seat(on, { isBuilt: false })
  await start($)
  await clock.settle?.()

  expect(commands).toHaveLength(2)
  expect(commands[0][0]).toBe('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
  expect(commands[0]).toContain('/out:C:\\Users\\me\\.claude\\aster\\Aster-9.9.9.exe')
  expect(commands[1].join(' ')).toContain('Start-Process')
})

test('a failed build starts nothing and says so', async ($, on) => {
  const { commands, clock } = seat(on, { isBuilt: false, doesBuildFail: true })
  await start($)
  await clock.settle?.()

  expect(commands).toHaveLength(1)
})

test('off Windows nothing is built or started, and /aster says why', async ($, on) => {
  const { commands, clock } = seat(on, { isBuilt: false, env: { HOME: '/home/me' } })
  await start($)
  await clock.settle?.()

  expect(commands).toHaveLength(0)

  const ran = await $.command.run({ command: 'aster', args: '' } as any)

  expect(JSON.stringify(ran)).toContain('only runs on Windows')
})

test('/aster summons it', async ($, on) => {
  const { commands, clock } = seat(on)
  on('command.run', () => ({ text: 'unanswered' }))
  await start($)
  await clock.settle?.()

  const ran = await $.command.run({ command: 'aster', args: '' } as any)

  expect(JSON.stringify(ran)).toContain('Aster is on your desktop.')
  expect(commands.at(-1)?.join(' ')).toContain('--summon')
})

test('a tool shows its prop, and the count carries across sessions', async ($, on) => {
  const { said, paths } = seat(on, { entries: { tools: 40 } })
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)

  expect(paths[0]).toBe('C:/Users/me/.claude/aster/status.json')
  expect(said[0]).toMatchObject({ mood: 'working', prop: 'magnifier', tools: 41 })
})

test('bookkeeping calls do not move Aster', async ($, on) => {
  const { said } = seat(on)
  on('tool.call', () => ({ result: {} }))
  await start($)
  await $.tool.call({ tool: 'ToolSearch', query: 'x', max_results: 1 } as any)

  expect(said).toHaveLength(0)
})

test('a failed tool is an oops, and a question says where and what', async ($, on) => {
  const { said, waits, paths } = seat(on)
  on('tool.call', (_: unknown, e: { tool: string }) =>
    e.tool === 'Bash' ? { result: {}, isError: true, text: 'no' } : { result: {} },
  )
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'false' } as any)

  expect(said.map(s => s.mood)).toEqual(['working', 'oops'])

  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Ship **it**?' }] } as any)

  expect(paths.at(-1)).toBe('C:/Users/me/.claude/aster/waiting/session-1.json')
  expect(waits.at(-1)).toMatchObject({ isWaiting: true, project: 'my-app', question: 'Ship it?' })
})

const inTurn = (on: any) => {
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
}

const finish = ($: any, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

test('a finished turn is happy, and one ending on a question is waiting on you', async ($, on) => {
  const { said, waits } = seat(on)
  inTurn(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't' })
  await finish($, 'All sorted.')

  expect(said.at(-1)?.mood).toBe('happy')

  await $.turn.start({ text: 'hi', turnId: 't' })
  await finish($, 'Here is what I found.\n\nWant me to push it?**')

  expect(waits.at(-1)).toMatchObject({ isWaiting: true, question: 'Want me to push it?' })
})

test('a turn the desktop app closes as blocked is waiting on you, until the next prompt', async ($, on) => {
  const { said, waits } = seat(on)
  inTurn(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x', ask: 'y', blocked: true } as any)
  await finish($, 'No question mark here.')

  expect(waits.at(-1)).toMatchObject({ isWaiting: true, question: 'y' })

  await $.turn.start({ text: 'answered', turnId: 't' })

  expect(waits.at(-1)).toEqual({ isWaiting: false })

  await finish($, 'Done.')

  expect(said.at(-1)?.mood).toBe('happy')
})

test('a wrap-up that asks nothing is not waiting on you', async ($, on) => {
  const { said, waits } = seat(on)
  inTurn(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'x' } as any)
  await finish($, 'Done.')

  expect(said.at(-1)?.mood).toBe('happy')
  expect(waits).toHaveLength(0)
})

test('the wait is timed from when Claude first asked, not from the latest reminder', async ($, on) => {
  const { waits, clock } = seat(on)
  inTurn(on)
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
  const first = waits.at(-1)?.since
  await clock.advance(5 * 60 * 1000)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)

  expect(waits.at(-1)?.since).toBe(first)
})

test('a long question is cut to fit, and a closed session stops waiting', async ($, on) => {
  const { waits } = seat(on)
  inTurn(on)
  on('session.end', () => ({ sessionId: 'session-1' }))
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'x'.repeat(500) }] } as any)

  expect(waits.at(-1)?.question).toHaveLength(140)
  expect(waits.at(-1)?.question?.endsWith('…')).toBe(true)

  await $.session.end({ reason: 'clear' } as any)

  expect(waits.at(-1)).toEqual({ isWaiting: false })
})

test('the pet not being there never stops a tool', async ($, on) => {
  seat(on, { isDiskFull: true })
  on('tool.call', () => ({ result: { fine: true } }))
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)

  expect(ran).toMatchObject({ result: { fine: true } })
})
