import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const TOOL = 'mcp__decisions__decisions'
const ROOT = '/tmp/worktree'
const SURFACES = ['terminal', 'desktop'] as const

const decision = (title: string) => ({
  title,
  body: `Why **${title}** matters.\n\n- one\n- two`,
  options: [
    { key: 'a', label: 'Yes' },
    { key: 'b', label: 'No' },
  ],
  recommendation: 'a',
})

test('the pane, the band and the tool row draw on each surface', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'raise', items: [decision('One'), decision('Two')] })

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: 'decisions',
      surface,
      component: 'Pane',
      requestId: 'decisions',
      props: { title: 'Decisions', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
    })
    expect(await pane.find({ key: 'row-D1' })).toBeTruthy()

    const band = await $.ui.mount({
      plugin: 'decisions',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false } as unknown as RenderPropsOf['AbovePrompt'],
    })
    expect(await band.find({ key: 'band-D2' })).toBeTruthy()

    await $.ui.mount({
      plugin: 'decisions',
      surface,
      component: 'ToolUse',
      requestId: 'row-1',
      props: {
        tool_use_id: 'row-1',
        tool: TOOL,
        input: { action: 'raise', items: [decision('One')] },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      } as unknown as RenderPropsOf['ToolUse'],
    })
  }
})

test('the pane hides ruled decisions until the Ruled heading is clicked', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'raise', items: [decision('One'), decision('Two')] })
  await $.tool.call({ tool: TOOL, action: 'rule', items: [{ id: 'D1', ruling: 'D1a' }] })

  const pane = await $.ui.mount({
    plugin: 'decisions',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'decisions',
    props: { title: 'Decisions', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
  })
  expect(await pane.find({ key: 'row-D2' })).toBeTruthy()
  expect(await pane.find({ key: 'row-D1' })).toBeUndefined()

  await pane.press({ key: 'heading-ruled' })
  expect(await pane.find({ key: 'row-D1' })).toBeTruthy()
})

test('the pane closes when the last open decision closes', async ($, on) => {
  const closed: string[] = []
  mock.store(on)
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'decisions', title: 'Decisions', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('ui.close', (_$, e) => {
    closed.push(e.id)

    return { value: undefined }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'raise', items: [decision('One'), decision('Two')] })
  await $.tool.call({ tool: TOOL, action: 'rule', items: [{ id: 'D1', ruling: 'D1a' }] })
  expect(closed).toEqual([])

  await $.tool.call({ tool: TOOL, action: 'withdraw', items: [{ id: 'D2', ruling: 'Not needed' }] })
  expect(closed).toEqual(['decisions'])
})
