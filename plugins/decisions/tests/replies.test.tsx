import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { segments } from '../hooks/replyText'
import { EMPTY_REPLIES, addReply, markRead, nextReply, normaliseReplyId, parseReply, trackRow } from '../hooks/replies'

const REPLY_TOOL = 'mcp__decisions__reply'
const ROOT = '/tmp/worktree'

function engine(on: On) {
  mock.store(on)
  mock.clock(on)
  mock.session(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__decisions__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer, reason: 'answer' }) as never)
  // The engine's own drawing of a site that the plugin passes on.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text key="engine">engine</Text>
  })
}

const appender =
  ($: Engine) =>
  (uuid: string, door: 'prompt' | 'response', content: unknown[], isMeta = false) =>
    $.session.append({
      uuid,
      door,
      origin: door === 'prompt' ? { kind: 'composer' } : { kind: 'model', model: 'test' },
      message: {
        type: door === 'prompt' ? 'user' : 'assistant',
        role: door === 'prompt' ? 'user' : 'assistant',
        ...(isMeta ? { isMeta: true } : {}),
        content,
      },
    } as never)

const band = { plugin: 'decisions', surface: 'terminal', component: 'AbovePrompt' } as const
const bandProps = { hasSurvey: false } as unknown as RenderPropsOf['AbovePrompt']

test('trackRow marks the text that a tool call follows, and not the text that ends a turn', async () => {
  const text = (uuid: string) => ({ uuid, door: 'response', content: [{ type: 'text', text: 'words' }] })
  const toolUse = (uuid: string) => ({ uuid, door: 'response', content: [{ type: 'tool_use' }] })

  let state = trackRow([], { uuid: 'p1', door: 'prompt', content: [] })
  state = trackRow(state.pending, text('t1'))
  expect(state.narration).toEqual([])
  state = trackRow(state.pending, text('t2'))
  state = trackRow(state.pending, toolUse('u1'))
  expect(state.narration).toEqual(['t1', 't2'])
  state = trackRow(state.pending, { uuid: 'r1', door: 'tool-result', content: [] })
  state = trackRow(state.pending, text('t3'))
  expect(state.narration).toEqual([])
  expect(state.pending).toEqual([{ uuid: 't3', text: 'words' }])
  state = trackRow(state.pending, { uuid: 'p2', door: 'prompt', content: [] })
  expect(state.pending).toEqual([])
})

test('parseReply checks the text and the question', async () => {
  expect(parseReply({ text: '  ' })).toEqual({ error: 'reply needs text.' })
  expect(parseReply({ text: 'Yes.', question: 7 })).toEqual({
    error: 'question is a string of at most 200 characters.',
  })
  expect(parseReply({ text: ' Yes. ', question: ' ' })).toEqual({ question: null, text: 'Yes.' })
  expect(normaliseReplyId('r3')).toBe('R3')
  expect(normaliseReplyId('D3')).toBeNull()
})

test('markRead marks one reply or all of them', async () => {
  const one = addReply(EMPTY_REPLIES, { question: null, text: 'a' }, 'call-1', 0).replies
  const two = addReply(one, { question: null, text: 'b' }, 'call-2', 0).replies
  expect(two.items.map(reply => reply.id)).toEqual(['R1', 'R2'])
  expect(markRead(two, 'R1').items.map(reply => reply.isRead)).toEqual([true, false])
  expect(markRead(two).items.every(reply => reply.isRead)).toBe(true)
})

test('a reply shows in the band until the person sends a prompt', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const result = await $.tool.call({ tool: REPLY_TOOL, text: 'Yes, it can.', question: 'Can it?' })
  expect(JSON.stringify(result)).toContain('R1')

  const shown = await $.ui.mount({ ...band, props: bandProps })
  expect(await shown.find({ key: 'band-R1' })).toBeTruthy()

  await $.prompt.submit({ text: 'Thanks', wait: false, origin: { kind: 'composer' } })
  const after = await $.ui.mount({ ...band, props: bandProps })
  expect(await after.find({ key: 'band-R1' })).toBeUndefined()
})

test('a subagent cannot reply', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const result = await $.tool.call({ tool: REPLY_TOOL, text: 'Yes.', agentId: 'a1' })
  expect(JSON.stringify(result)).toContain('Only the session that the person talks to replies')
})

test('the reply row draws the answer in a box, and the pane lists it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: REPLY_TOOL, text: 'Yes, **it can**.', question: 'Can it?' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'decisions',
      surface,
      component: 'ToolUse',
      requestId: 'row-1',
      props: {
        tool_use_id: 'row-1',
        tool: REPLY_TOOL,
        input: { text: 'Yes, **it can**.', question: 'Can it?' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      } as unknown as RenderPropsOf['ToolUse'],
    })
    expect(await row.find({ type: 'Text', text: /Can it\?/ })).toBeTruthy()

    const pane = await $.ui.mount({
      plugin: 'decisions',
      surface,
      component: 'Pane',
      requestId: 'decisions',
      props: { title: 'Decisions', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
    })
    expect(await pane.find({ key: 'row-R1' })).toBeTruthy()
  }
})

test('text that a tool call follows draws dim; the last text of a turn becomes a reply', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const append = appender($)

  await append('p1', 'prompt', [{ type: 'text', text: 'Question?' }])
  await append('t1', 'response', [{ type: 'text', text: 'Let me look.' }])
  await append('u1', 'response', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }])
  await append('t2', 'response', [{ type: 'text', text: 'The answer.' }])

  const draw = (requestId: string, text: string) =>
    $.ui.mount({
      plugin: 'decisions',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId,
      props: { text, isFirstOfReply: true } as unknown as RenderPropsOf['AssistantMessage'],
    })
  const narration = await draw('t1', 'Let me look.')
  expect((await narration.find({ type: 'Markdown' }))?.props).toMatchObject({ dimColor: true })
  const before = await draw('t2', 'The answer.')
  expect(await before.find({ type: 'Markdown' })).toBeUndefined()
  await before.unmount()

  await $.turn.complete({ answer: 'The answer.', durationMs: 1, isAborted: false, turnId: 'turn-1', reason: 'answer' } as never)
  const answer = await draw('t2', 'The answer.')
  expect(await answer.find({ type: 'Text', text: /R1\s+Question\?/ })).toBeTruthy()
  const shown = await $.ui.mount({ ...band, props: bandProps })
  expect(await shown.find({ key: 'band-R1' })).toBeTruthy()
})

test('a turn that a notification starts makes no reply', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const append = appender($)
  await append('p1', 'prompt', [{ type: 'text', text: 'Question?' }])
  await append('t1', 'response', [{ type: 'text', text: 'The answer.' }])
  const complete = (turnId: string) =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as never)
  await complete('turn-1')

  await append('n1', 'prompt', [{ type: 'text', text: '<task-notification>' }], true)
  await append('t2', 'response', [{ type: 'text', text: 'Agent done.' }])
  await append('u1', 'response', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }])
  await append('t3', 'response', [{ type: 'text', text: 'Status.' }])
  await complete('turn-2')

  const pane = await $.ui.mount({
    plugin: 'decisions',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'decisions',
    props: { title: 'Decisions', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
  })
  expect(await pane.find({ key: 'row-R1' })).toBeTruthy()
  expect(await pane.find({ key: 'row-R2' })).toBeUndefined()
})

test('segments keeps code blocks and tables as markdown and splits the prose into bright lines', async () => {
  const parts = segments(
    ['# Title', '', 'Use **this** and `that`, see [docs](https://x.y).', '- item', '', '```ts', 'const a = 1', '```', '| a | b |', '| - | - |'].join('\n'),
  )
  expect(parts).toEqual([
    { kind: 'line', spans: [{ text: 'Title' }], isHeading: true },
    { kind: 'blank' },
    {
      kind: 'line',
      spans: [
        { text: 'Use ' },
        { text: 'this', isBold: true },
        { text: ' and ' },
        { text: 'that', isCode: true },
        { text: ', see ' },
        { text: 'docs' },
        { text: '.' },
      ],
    },
    { kind: 'line', spans: [{ text: '• item' }] },
    { kind: 'blank' },
    { kind: 'markdown', text: '```ts\nconst a = 1\n```' },
    { kind: 'markdown', text: '| a | b |\n| - | - |' },
  ])
})

test('a row drawn under its zeroed message id finds the marks of its stored uuid', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const append = appender($)
  await append('a11649df-aee6-4edd-8792-f0d7602433c3', 'prompt', [{ type: 'text', text: 'Question?' }])
  await append('cf3654ef-4d99-40be-a077-75ff17ca0caa', 'response', [{ type: 'text', text: 'Looking.' }])
  await append('853e4c82-1e5a-42b2-b9c5-52d2ad834bf8', 'response', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }])
  await append('9c2a0ccf-5fa2-4924-818d-ad0a4c0ea650', 'response', [{ type: 'text', text: 'Answer.' }])
  await $.turn.complete({ answer: 'Answer.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

  const draw = (requestId: string, text: string) =>
    $.ui.mount({
      plugin: 'decisions',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId,
      props: { text, isFirstOfReply: true } as unknown as RenderPropsOf['AssistantMessage'],
    })
  const narration = await draw('cf3654ef-4d99-40be-a077-000000000000', 'Looking.')
  expect((await narration.find({ type: 'Markdown' }))?.props).toMatchObject({ dimColor: true })
  const answer = await draw('9c2a0ccf-5fa2-4924-818d-000000000000', 'Answer.')
  expect(await answer.find({ type: 'Text', text: /R1\s+Question\?/ })).toBeTruthy()
})

test('nextReply goes to the oldest unread reply, then from the newest reply back, wrapping round', async () => {
  let value = EMPTY_REPLIES
  for (const text of ['a', 'b', 'c']) value = addReply(value, { question: null, text }, `call-${text}`, 0).replies
  value = markRead(value, 'R1')
  expect(nextReply(value.items, null)?.id).toBe('R2')

  value = markRead(value)
  expect(nextReply(value.items, null)?.id).toBe('R3')
  expect(nextReply(value.items, 'R3')?.id).toBe('R2')
  expect(nextReply(value.items, 'R1')?.id).toBe('R3')
  expect(nextReply([], null)).toBeNull()
})

test('the prompt hint gets a ctrl+x r button once the session has a reply', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const hint = () =>
    $.ui.mount({ plugin: 'decisions', surface: 'terminal', component: 'PromptHint', props: {} as unknown as RenderPropsOf['PromptHint'] })
  const before = await hint()
  expect(await before.find({ key: 'next-reply' })).toBeUndefined()
  await before.unmount()

  await $.tool.call({ tool: REPLY_TOOL, text: 'Yes.' })
  const after = await hint()
  expect((await after.find({ key: 'next-reply' }))?.props).toMatchObject({ action: 'diff:nextFile' })
  expect((await after.find({ type: 'Text', text: /ctrl\+x r/ }))?.props).toMatchObject({ color: 'cyan' })
})
