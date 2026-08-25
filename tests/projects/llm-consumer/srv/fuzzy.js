import cds from "@sap/cds";

import { pipeline } from 'node:stream/promises'
import { Readable } from "node:stream"
import AgentService from "../../../../lib/agentService";

export default class FuzzyService extends AgentService {
  AgentSession = class RAGAgentSession extends AgentSession {
    async *loadSession() {
      yield* super.loadSession()
      // semantic search for last promp
      const books = await SELECT.from(Books).where`embedding like ${prompt}`.limit(10)
      yield { role: 'assistant', type: 'tool_call', query: {} }
      yield { role: 'assistant', type: 'tool_result', content: books.map(...).join('\n') }
    }
  }

  init() {
    // this.on('start', () => {})

    this.on('llm', async (req) => {
      const message = req?.data?.message
      if (!message) cds.error`Required message argument is missing. Please provide an message to send.`
      const llm = await cds.connect.to('llm')
      const response = await llm.send(message)
      return response.reduce((l, c) => l + c.content, '')
    })

    this.on('llmStream', async (req) => {
      const message = req?.data?.message
      if (!message) cds.error`Required message argument is missing. Please provide an message to send.`
      const llm = await cds.connect.to('llm')

      pipeline(
        await llm.send({ data: message, iterator: true }),
        async function* (stream) {
          for await (const message of stream) {
            if (message.type === 'reasoning') yield message.content
            else {
              yield Buffer.from([0])
              yield message.content
            }
          }
        },
        async function* (stream) {
          req.reply(Readable.from(stream))
        }
      ).catch(() => { })
    })

    this.on('get_weather', async (req) => {
      return 'Sunny with a chance of rainbows🌈.'
    })

    this.on('agent', async (req) => {
      const agents = await cds.connect.to('agents')
      const session = await agents.send('start', {
        ...req.data,
        service: this,
        options: {
          system: 'You call the fuzzy.get_weather tool.',
        },
      })

      session.write(req.data.message)

      pipeline(session, serialize, async function* (stream) { req.reply(Readable.from(stream)) })
        .catch(() => { })

      async function* serialize(session) {
        let thinking = true
        for await (const message of session) {
          if (message.role === 'flush') break
          if (message.type === 'reasoning') req.res.write(message.content)
          else if (message.type === 'tool_call')
            yield `\n\ntool: ${message.query.tool}${message.query.args ? `(${JSON.stringify(message.query.args)})` : ''}`
          else if (message.type === 'tool_result')
            yield `\nresult: ${message.query.tool} => ${message.content}\n\n`
          else {
            if (thinking) {
              thinking = false
              yield Buffer.from([0])
            }
            yield message.content
          }
        }
      }
    })
  }
}

/* llm ui stream script
(async function() {
    const res = await fetch(`${this.location.href}odata/v4/fuzzy/llmStream`, {
        method:'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({message:'who are you ?'})
    })

    const output = document.querySelector('footer')
    output.style.width = '100%'
    output.innerHTML = '<div id="thinking" style="max-height:200px;overflow-x:hidden;overflow-y:scroll;white-space:pre-line;"></div><div id="answer" style="color:white;white-space:pre-line;"></div>'
    const thining = output.querySelector('#thinking')
    const answer = output.querySelector('#answer')

    const noll = String.fromCharCode(0)
    let target = thining
    for await(let chunk of res.body.pipeThrough(new TextDecoderStream("utf-8"))) {
        const hasNoll = chunk.indexOf(noll)
        if(hasNoll > -1) {
            target.innerText += chunk.slice(0,hasNoll)
            target.style.height = '0'
            target = answer
            target.innerText += chunk.slice(hasNoll + 1)
        } else {
            target.innerText += chunk
        }
        target.scrollTop = target.scrollHeight;
    }
})()
*/

/* agent ui stream script
(async function() {
    const res = await fetch(`${this.location.href}odata/v4/fuzzy/agent`, {
        method:'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ID:'00000000-0000-0000-0000-000000000001', message:'who are you ?'})
    })

    const output = document.querySelector('footer')
    output.style.width = '100%'
    output.innerHTML = '<div id="thinking" style="max-height:200px;overflow-x:hidden;overflow-y:scroll;white-space:pre-line;"></div><div id="answer" style="color:white;white-space:pre-line;"></div>'
    const thining = output.querySelector('#thinking')
    const answer = output.querySelector('#answer')

    const noll = String.fromCharCode(0)
    let target = thining
    for await(let chunk of res.body.pipeThrough(new TextDecoderStream("utf-8"))) {
        const hasNoll = chunk.indexOf(noll)
        if(hasNoll > -1) {
            target.innerText += chunk.slice(0,hasNoll)
            target.style.height = '0'
            target = answer
            target.innerText += chunk.slice(hasNoll + 1)
        } else {
            target.innerText += chunk
        }
        target.scrollTop = target.scrollHeight;
    }
})()
*/