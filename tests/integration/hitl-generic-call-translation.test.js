import { extractInterruptData, rewrapResumeDecisions } from "../../srv/handlers/graph-executor/hitl.js"

// With per_action_tool off (the default), the LLM invokes every action through one
// generic "call" tool: name = "call", args = { action, parameters }. HITL is defined
// over tool calls, so the raw interrupt and the resume Command both speak "call".
// These tests pin the two-way translation that lets clients see — and edit — the
// real action instead: unwrap outbound (extractInterruptData), re-wrap the edit back
// onto the call shape inbound (rewrapResumeDecisions).
describe("generic 'call' tool HITL translation", () => {
  const genericInterrupt = (overrides = {}) => ({
    __interrupt__: [
      {
        value: {
          actionRequests: [
            {
              name: "call",
              args: { action: "submitOrder", parameters: { book: 201, quantity: 2 } },
              ...overrides,
            },
          ],
        },
      },
    ],
  })

  describe("outbound: extractInterruptData unwraps the call tool", () => {
    it("surfaces the fronted action as the request name, with its own params as args", () => {
      const data = extractInterruptData(genericInterrupt())
      expect(data.actionRequests[0].name).toBe("submitOrder")
      expect(data.actionRequests[0].args).toEqual({ book: 201, quantity: 2 })
    })

    it("keeps a parameterless action's args as an empty object", () => {
      const data = extractInterruptData({
        __interrupt__: [{ value: { actionRequests: [{ name: "call", args: { action: "ping" } }] } }],
      })
      expect(data.actionRequests[0]).toEqual({ name: "ping", args: {} })
    })

    it("leaves per-action requests untouched (and returns the payload opaquely)", () => {
      const payload = { actionRequests: [{ name: "submitOrder", args: { book: 1 } }] }
      // Reference equality proves nothing was rewritten for the per-action path.
      expect(extractInterruptData({ __interrupt__: [{ value: payload }] })).toBe(payload)
    })
  })

  describe("inbound: rewrapResumeDecisions re-wraps edits onto the call shape", () => {
    const genericCall = [
      {
        id: "tc1",
        name: "call",
        args: { action: "submitOrder", parameters: { book: 201, quantity: 2 } },
      },
    ]

    it("maps an action-level edit back to { action, parameters } for the call tool", () => {
      const resume = {
        decisions: [
          { type: "edit", editedAction: { name: "submitOrder", args: { book: 201, quantity: 4 } } },
        ],
      }
      const out = rewrapResumeDecisions(resume, genericCall)
      expect(out.decisions[0].editedAction).toEqual({
        name: "call",
        args: { action: "submitOrder", parameters: { book: 201, quantity: 4 } },
      })
    })

    it("defaults a nameless edit to the originally gated action", () => {
      const resume = { decisions: [{ type: "edit", editedAction: { args: { quantity: 9 } } }] }
      const out = rewrapResumeDecisions(resume, genericCall)
      expect(out.decisions[0].editedAction).toEqual({
        name: "call",
        args: { action: "submitOrder", parameters: { quantity: 9 } },
      })
    })

    it("rejects an edit that tries to swap the gated action (escalation guard)", () => {
      const resume = {
        decisions: [{ type: "edit", editedAction: { name: "deleteEverything", args: {} } }],
      }
      expect(() => rewrapResumeDecisions(resume, genericCall)).toThrow(
        /must not change the gated action/,
      )
    })

    it("passes per-action edits through unchanged", () => {
      const resume = {
        decisions: [{ type: "edit", editedAction: { name: "submitOrder", args: { quantity: 4 } } }],
      }
      const toolCalls = [{ id: "tc1", name: "submitOrder", args: { book: 1, quantity: 2 } }]
      const out = rewrapResumeDecisions(resume, toolCalls)
      expect(out).toBe(resume)
      expect(out.decisions[0].editedAction).toEqual({ name: "submitOrder", args: { quantity: 4 } })
    })

    it("leaves approve and reject decisions untouched", () => {
      const resume = { decisions: [{ type: "approve" }, { type: "reject", message: "no" }] }
      expect(rewrapResumeDecisions(resume, [...genericCall, ...genericCall])).toBe(resume)
    })
  })

  it("round-trips: the action unwrapped outbound re-wraps to the same tool call inbound", () => {
    const interrupt = genericInterrupt()
    const surfaced = extractInterruptData(interrupt).actionRequests[0]
    expect(surfaced.name).toBe("submitOrder")

    // A client edits the surfaced action's own params, echoing its name back.
    const resume = {
      decisions: [
        {
          type: "edit",
          editedAction: { name: surfaced.name, args: { ...surfaced.args, quantity: 7 } },
        },
      ],
    }
    const toolCalls = interrupt.__interrupt__[0].value.actionRequests.map((r) => ({
      name: r.name,
      args: r.args,
    }))
    const out = rewrapResumeDecisions(resume, toolCalls)
    expect(out.decisions[0].editedAction).toEqual({
      name: "call",
      args: { action: "submitOrder", parameters: { book: 201, quantity: 7 } },
    })
  })
})
