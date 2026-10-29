import { expect, test } from 'claude-code/testing'

const REPLY = [
  'Here is a draft:',
  '',
  '> Hi Sam,',
  '>',
  '> Tap the larger **A** in `Safari`.',
  '',
  'And a second:',
  '',
  '> Thanks again,',
  '> Alex',
  '',
  '```md',
  '> not a quote',
  '```',
].join('\n')

const message = (text: string) =>
  ({
    plugin: 'copy-quote',
    component: 'AssistantMessage',
    requestId: 'msg-1',
    surface: 'terminal',
    props: { text, isFirstOfReply: true },
  }) as const

test('each quote gets a button that copies it without the bars', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount(message(REPLY))

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)

  await ui.press({ key: 'copy-0' })
  await ui.press({ key: 'copy-1' })
  expect(copied).toEqual(['Hi Sam,\n\nTap the larger A in Safari.', 'Thanks again,\nAlex'])
  await ui.unmount()
})

test('a reply with no quote draws as the engine draws it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount(message('No quote here.\n\n```\n> code\n```'))

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})
