import cds from "@sap/cds"
import { createAgent, tool } from "langchain"
import z from "zod"

const model = await cds.connect.to("llm-aicore", {
  params: { temperature: 1, thinking: { type: "enabled", budget_tokens: 2000 } },
})
const getWeather = tool(async ({ city }) => `It's always sunny in ${city}!`, {
  name: "get_weather",
  description: "Get weather for a given city.",
  schema: z.object({ city: z.string() }),
})
const agent = createAgent({ model, tools: [getWeather] })

console.log("\n=== invoke (non-streaming) ===")
// const answer = await agent.invoke({ messages: [{ role: "user", content: "What's the weather in Berlin?" }] })
// console.log(answer.messages.at(-1).content)

console.log("\n=== streamEvents (streaming) ===")
const stream = await agent.streamEvents(
  { messages: [{ role: "user", content: "What's the weather in Paris? Then one fun fact." }] },
  { version: "v3" },
)
let got = 0
let thought = 0
let turn = 0
for await (const message of stream.messages) {
  turn++
  console.log(`\n--- turn ${turn} ---`)
  for await (const token of message.reasoning) {
    process.stdout.write(`\x1b[90m${token}\x1b[0m`)
    thought++
  }
  for await (const token of message.text) {
    process.stdout.write(token)
    got++
  }
}
console.log(`\n[${turn} turns, ${thought} reasoning + ${got} text tokens]`)
