import { describe, test } from 'node:test'
import cds from '@sap/cds'
import '@cap-js/cds-test'

describe('evals', () => {
  const { expect } = cds.test()

  test('example', async () => {
    const llm = await cds.connect.to('llm')
    const nomi = await cds.connect.to('nomi')

    // const res = await llm.send('who are you ?')
    // const reasoning = res.reduce((l, c) => l + (c.type === 'reasoning' ? c.content : ''), '')
    // const message = res.reduce((l, c) => l + (c.type === 'text' ? c.content : ''), '')

    const oneshot = await nomi.send('sendMessage', {
      sessionId: cds.utils.uuid(),
      message: 'Create a dashboard with the top 3 most expensive travels.',
      cards: '[]',
      auto: false
    })
    const collected = { parts: [] }
    let reasoning = ''
    let responses = ''
    let cards = ''
    for await (const part of oneshot) {
      const p = JSON.parse(part)
      collected.parts.push(p)
      collected[p.type] ??= ''
      collected[p.type] += p.text ?? JSON.stringify(p) + '\n\n'
    }
    debugger
  })
})
