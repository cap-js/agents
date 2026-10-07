import { guardHitlEdits } from "../../srv/handlers/graph-executor/hitl.js"

// The generic "call" tool fronts every action behind one tool name, with the target
// in args.action; HITL only interrupts when that action is gated. An edit may tune
// the parameters but must not repoint args.action at a different action — otherwise a
// non-gated action could ride in on the approval granted for the gated one. The guard
// is a no-op for per-action tools (name is the action; it can't be swapped via args).
describe("HITL edit escalation guard", () => {
  const genericCall = (action) => ({
    name: "call",
    args: { action, parameters: { book: 201, quantity: 2 } },
  })

  it("allows a parameters-only edit (action omitted)", () => {
    const resume = { decisions: [{ type: "edit", editedAction: { args: { parameters: { quantity: 4 } } } }] }
    expect(() => guardHitlEdits(resume, [genericCall("submitOrder")])).not.toThrow()
    expect(guardHitlEdits(resume, [genericCall("submitOrder")])).toBe(resume)
  })

  it("allows an edit that keeps the same action", () => {
    const resume = {
      decisions: [{ type: "edit", editedAction: { args: { action: "submitOrder", parameters: {} } } }],
    }
    expect(() => guardHitlEdits(resume, [genericCall("submitOrder")])).not.toThrow()
  })

  it("rejects an edit that swaps args.action to a different action", () => {
    const resume = {
      decisions: [{ type: "edit", editedAction: { args: { action: "deleteEverything", parameters: {} } } }],
    }
    expect(() => guardHitlEdits(resume, [genericCall("submitOrder")])).toThrow(
      /must not change the gated action.*submitOrder.*deleteEverything/,
    )
  })

  it("ignores non-edit decisions", () => {
    const resume = { decisions: [{ type: "approve" }, { type: "reject", message: "no" }] }
    const actions = [genericCall("submitOrder"), genericCall("submitOrder")]
    expect(guardHitlEdits(resume, actions)).toBe(resume)
  })

  it("does not touch per-action tool edits (no args.action to guard)", () => {
    const resume = {
      decisions: [{ type: "edit", editedAction: { name: "submitOrder", args: { quantity: 4 } } }],
    }
    const perAction = [{ name: "submitOrder", args: { book: 1, quantity: 2 } }]
    expect(() => guardHitlEdits(resume, perAction)).not.toThrow()
  })

  it("guards each decision against its positionally matched action", () => {
    const resume = {
      decisions: [
        { type: "approve" },
        { type: "edit", editedAction: { args: { action: "wire", parameters: {} } } },
      ],
    }
    const actions = [genericCall("submitOrder"), genericCall("refund")]
    // Decision 1 (edit) pairs with actions[1] = refund, so swapping to "wire" must throw.
    expect(() => guardHitlEdits(resume, actions)).toThrow(/expected "refund", got "wire"/)
  })
})
