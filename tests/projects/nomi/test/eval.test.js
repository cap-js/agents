import { describe, test } from 'node:test'
import cds from '@sap/cds'
import '@cap-js/cds-test'

describe('evals', () => {
  const { expect } = cds.test()

  test('dashboard of the top 3 most expensive travels (one-shot)', async () => {
    const { Travels } = cds.entities('TravelService')

    // Ask the agent to do the test task
    const task = 'Create a dashboard with the top 3 most expensive travels.'
    const dashboard = await nomi(task)

    // Validate and rate the performance of the agent
    expect(Object.keys(dashboard.cards)).property('length').to.be.greaterThan(0, 'The agent did not display a single card')

    const llm = await cds.connect.to('llm')

    // Ask the llm service to extract all the travel IDs and their shown prices
    const res = await llm.send(`An assistant displayed these data cards:
${JSON.stringify(dashboard.cards)}

Extract every travel it shows. Reply with ONLY a JSON array, no prose, no fences:
[{"ID": <travel id as a number>, "TotalPrice": <the price number shown>}]
If it shows no travels, reply with [].`)

    const travels = JSON.parse(res
      .reduce((s, c) => s + (c.type === 'text' ? c.content : ''), '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '').trim()
    )

    expect(travels).property('length').to.be.greaterThan(0, `Ensure that the agent displays any travels`)

    // Verify that the shown travels their prices are accurate
    const rows = await SELECT.from(Travels)
      .columns`ID, TotalPrice`
      .where({ ID: { in: travels.map(d => d.ID) } })
    const priceById = Object.fromEntries(rows.map(r => [r.ID, Math.round(r.TotalPrice)]))
    for (const travel of travels) {
      expect(Math.round(travel.TotalPrice))
        .to.equal(priceById[travel.ID], `Ensure that the agent shows the real prices for travels (${travel.ID})`)
    }

    // Collect expected result data
    const naiveTop3 = await SELECT.from(Travels)
      .columns`ID, Currency.code as Currency, TotalPrice`
      .orderBy`TotalPrice desc`
      .limit(3)

    const convertedTop3 = await SELECT.from(Travels)
      .columns`
        ID, 'EUR' as Currency,
        round(TotalPrice * case Currency.code
          when 'EUR' then 1.0
          when 'USD' then 0.92
          when 'SGD' then 0.68
          when 'JPY' then 0.0062
          else 1.0 end) as TotalPrice
      `
      .orderBy`TotalPrice desc`
      .limit(3)

    const naiveIds = naiveTop3.map(t => t.ID).join(',')
    const realIds = convertedTop3.map(t => t.ID).join(',')
    expect(naiveIds)
      .not.to.equal(realIds, 'Ensure that the naive and real top 3 are different.')

    // Ask the llm service to judge the performance of the agent
    const judgementRaw = await llm.send(`You are grading an AI data assistant.
Grade ONLY against the definitions below. Do not invent extra requirements.

TASK GIVEN TO THE AGENT:
${task}

THE REAL ANSWER — the correct top 3, after converting every TotalPrice to EUR:
${JSON.stringify(convertedTop3, null, 2)}

THE NAIVE ANSWER — the WRONG top 3 you get by sorting raw TotalPrice and ignoring
currency (a common mistake):
${JSON.stringify(naiveTop3, null, 2)}

WHAT THE AGENT PUT ON SCREEN (cards):
${JSON.stringify(dashboard.cards, null, 2)}

WHAT THE AGENT SAID OUT LOUD:
${dashboard.speech || '(nothing)'}

The travels use different currencies, so a correct ranking must convert to a common
currency first; sorting by raw TotalPrice is the naive mistake.

HOW TO DECIDE THE VERDICT — follow these steps exactly and do not skip any:
1. List the travel IDs the agent actually shows on its cards.
2. Compare that set of IDs to the two answers above. Compare by ID ONLY — ignore
   ordering, labels, formatting, extra columns, and whether a price is written in EUR
   or in its original currency:
     • same three IDs as THE REAL ANSWER   → matched = "real"
     • same three IDs as THE NAIVE ANSWER  → matched = "naive"
     • anything else                       → matched = "neither"
3. Set the verdict PURELY from matched. Nothing else may change it:
     • matched = "real" → verdict = "pass"
     • otherwise        → verdict = "fail"

A correct answer MUST get verdict "pass" even when the card is plain, the wording is
terse, or the price is shown in the original currency instead of EUR — as long as the
three shown travels are THE REAL ANSWER. Never fail a correct answer over presentation
or style. Never pass the naive answer because it "looks nice".

Score each dimension 0-100 and reply with ONLY this JSON object, no prose and no markdown fences:
{"dataAccuracy":<n>,          // do the shown prices match the real travels' prices (exact match → 100)
 "currencyAwareness":<n>,     // did it convert currency (→100) or sort raw values (→0)
 "presentation":<n>,          // answer is on a card with its values shown; terse-but-correct → 100
 "matched":"real"|"naive"|"neither",
 "overall":<n>,"verdict":"pass"|"fail","reasoning":"<one short line>",
 "followup":"<a follow-up message that pushes the agent to fix the currency issue, or empty>"}`)

    const judgement = JSON.parse(judgementRaw
      .reduce((s, c) => s + (c.type === 'text' ? c.content : ''), '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    )

    expect(judgement.dataAccuracy, `dataAccuracy too low — ${judgement.reasoning}`).to.be.at.least(80)
    expect(judgement.presentation, `presentation too low — ${judgement.reasoning}`).to.be.at.least(80)
    expect(judgement.verdict).to.eq('pass')
  })

  async function nomi(message) {
    const srv = await cds.connect.to('nomi')
    const stream = await srv.send('sendMessage', { sessionId: cds.utils.uuid(), message, cards: '[]', auto: false })
    const cards = {}
    let speech = ''
    const all = []
    for await (const part of stream) {
      const p = JSON.parse(part)
      all.push(p)
      if (p.type === 'data-point') cards[p.id] = p
      else if (p.type === 'remove') delete cards[p.id]
      else if (p.type === 'token') speech += p.text
    }
    return { cards, speech }
  }
})
