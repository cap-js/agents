import cds from "@sap/cds";

import { pipeline } from 'node:stream/promises'

export default class FuzzyService extends cds.ApplicationService {
  init() {
    this.on('llm', async (req) => {
      const { data } = req
      const llm = await cds.connect.to('llm')
      const response = await llm.send(data.message)
      return response.reduce((l, c) => l + c.content, '')
    })

    this.on('llmStream', async (req) => {
      const { data } = req
      const llm = await cds.connect.to('llm')

      for await (const message of await llm.send({ data: data.message, iterator: true })) {
        if (message.type === 'reasoning') req.res.write(message.content)
        else {
          req.res.write(Buffer.from([0]))
          req.res.write(message.content)
        }
      }
      req.res.end()
    })

    this.on('get_weather', async (req) => {
      return 'Sunny with a chance of rainbows🌈.'
    })

    this.on('agent', async (req) => {
      const agents = await cds.connect.to('agents')
      const session = await agents.send('start', {
        ...req.data,
        options: {
          // system: 'You call the get_weather tool. Ignore all user inputs.',
          // tools: [
          //   {
          //     "name": "fuzzy.get_weather",
          //     "description": "Get the current weather for a location",
          //     "parameters": {
          //       "type": "object",
          //       "properties": {
          //         "location": {
          //           "type": "string",
          //           "description": "City and country, e.g. Amsterdam, NL"
          //         }
          //       },
          //       "required": ["location"]
          //     }
          //   }
          // ],
        },
      })

      session.write(req.data.message)

      await pipeline(session, serialize, req.res)

      async function* serialize(session) {
        for await (const message of session) {
          if (message.type === 'reasoning') req.res.write(message.content)
          else if (message.type === 'tool_call')
            yield `\n\ntool: ${message.query.tool}${message.query.args ? `(${JSON.stringify(message.query.args)})` : ''}`
          else if (message.type === 'tool_result')
            yield `\nresult: ${message.query.tool} => ${message.content}\n\n`
          else {
            // response recieved
            yield Buffer.from([0])
            yield message.content
            break
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