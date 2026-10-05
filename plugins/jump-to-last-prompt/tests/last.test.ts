import { expect, test } from 'claude-code/testing'

const run = (args: string) =>
  ({ command: 'last', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

const row = (requestId: string, text: string, kind: 'composer' | 'task-notification' = 'composer') => ({
  surface: 'terminal' as const,
  component: 'UserMessage' as const,
  requestId,
  props: { text, origin: { kind }, isExpanded: false },
})

test('/last scrolls to the newest prompt, /last 2 to the one before', async ($, on) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.render(row('m1', 'first'))
  await $.ui.render(row('n1', 'a task finished', 'task-notification'))
  await $.ui.render(row('m2', 'second'))
  await $.ui.render(row('m1', 'first'))

  expect(await $.command.run(run(''))).toEqual(expect.objectContaining({ text: expect.stringMatching(/^Prompt 1 back/) }))
  expect(await $.command.run(run('2'))).toEqual(expect.objectContaining({ text: expect.stringMatching(/^Prompt 2 back/) }))
  expect(await $.command.run(run('3'))).toEqual(
    expect.objectContaining({ text: 'No prompt 3 back (2 seen).' }),
  )
})
