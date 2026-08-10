import { describe, it, expect } from "vitest"
import {
  extractTextFromContentBlocks,
  extractReasoningFromChunk,
  normalizeAssistantContent,
  buildStreamBlocks,
} from "../../lib/models/aicore.js"
import { AIMessage, HumanMessage } from "@langchain/core/messages"

/**
 * Unit tests for extractTextFromContentBlocks (Bug 1 fix, cap/agents#120).
 *
 * @sap-ai-sdk/langchain getDeltaContent() only handles string deltas;
 * Anthropic returns Array<{type,text}> content blocks causing empty tokens
 * in streaming chunks. This helper extracts text from those arrays manually.
 *
 * Note: flattenMessages() tests for AIMessage content arrays (Bug 2) are
 * intentionally omitted — cap/agents flattenMessages() currently only handles
 * SystemMessage and ToolMessage. Bug 2 is tracked separately in issue #120.
 */

describe("extractTextFromContentBlocks()", () => {
  it("extracts text from intermediate_results content-block array", () => {
    const chunk = {
      text: "",
      _data: {
        intermediate_results: {
          llm: {
            choices: [{ delta: { content: [{ type: "text", text: "hello world" }] } }],
          },
        },
      },
    }
    expect(extractTextFromContentBlocks(chunk)).toBe("hello world")
  })

  it("extracts text from final_result content-block array", () => {
    const chunk = {
      text: "",
      _data: {
        final_result: {
          choices: [{ delta: { content: [{ type: "text", text: "final answer" }] } }],
        },
      },
    }
    expect(extractTextFromContentBlocks(chunk)).toBe("final answer")
  })

  it("returns empty string when _data is absent", () => {
    expect(extractTextFromContentBlocks({})).toBe("")
  })

  it("returns empty string when content is not an array (plain string delta)", () => {
    const chunk = {
      _data: {
        intermediate_results: {
          llm: { choices: [{ delta: { content: "plain string" } }] },
        },
      },
    }
    expect(extractTextFromContentBlocks(chunk)).toBe("")
  })

  it("joins multiple text blocks", () => {
    const chunk = {
      _data: {
        intermediate_results: {
          llm: {
            choices: [
              {
                delta: {
                  content: [
                    { type: "text", text: "hello" },
                    { type: "text", text: " world" },
                  ],
                },
              },
            ],
          },
        },
      },
    }
    expect(extractTextFromContentBlocks(chunk)).toBe("hello world")
  })

  it("reads intermediate_results from message.additional_kwargs (streaming path, no _data)", () => {
    const chunk = {
      text: "",
      message: {
        additional_kwargs: {
          intermediate_results: {
            llm: { choices: [{ delta: { content: [{ type: "text", text: "streamed" }] } }] },
          },
        },
      },
    }
    expect(extractTextFromContentBlocks(chunk)).toBe("streamed")
  })
})

describe("extractReasoningFromChunk()", () => {
  it("extracts reasoning from message.additional_kwargs (streaming path)", () => {
    const chunk = {
      text: "",
      message: {
        additional_kwargs: {
          intermediate_results: {
            llm: {
              choices: [
                {
                  delta: {
                    content: "",
                    reasoning_content: [{ content: "Let me think", signature: "" }],
                  },
                },
              ],
            },
          },
        },
      },
    }
    expect(extractReasoningFromChunk(chunk)).toBe("Let me think")
  })

  it("joins multiple reasoning_content deltas", () => {
    const chunk = {
      message: {
        additional_kwargs: {
          intermediate_results: {
            llm: {
              choices: [
                {
                  delta: {
                    reasoning_content: [
                      { content: "step ", signature: "" },
                      { content: "by step", signature: "" },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    }
    expect(extractReasoningFromChunk(chunk)).toBe("step by step")
  })

  it("returns empty string when reasoning_content is absent (plain text chunk)", () => {
    const chunk = {
      message: {
        additional_kwargs: {
          intermediate_results: {
            llm: { choices: [{ delta: { content: "just text" } }] },
          },
        },
      },
    }
    expect(extractReasoningFromChunk(chunk)).toBe("")
  })

  it("returns empty string when the chunk carries no delta", () => {
    expect(extractReasoningFromChunk({})).toBe("")
  })
})

describe("normalizeAssistantContent()", () => {
  it("strips a tool_call content block, keeping tool_calls on the message", () => {
    const msg = new AIMessage({
      content: [{ type: "tool_call", id: "t1", name: "get_weather", args: { city: "Berlin" } }],
      tool_calls: [{ id: "t1", name: "get_weather", args: { city: "Berlin" }, type: "tool_call" }],
    })
    const [out] = normalizeAssistantContent([msg])
    expect(out.content).toBe("")
    expect(out.tool_calls).toHaveLength(1)
    expect(out._getType()).toBe("ai")
  })

  it("joins text blocks and drops non-text blocks", () => {
    const msg = new AIMessage({
      content: [
        { type: "text", text: "Let me check. " },
        { type: "tool_call", id: "t1", name: "f", args: {} },
        { type: "text", text: "One moment." },
      ],
      tool_calls: [{ id: "t1", name: "f", args: {}, type: "tool_call" }],
    })
    const [out] = normalizeAssistantContent([msg])
    expect(out.content).toBe("Let me check. One moment.")
  })

  it("leaves string content untouched", () => {
    const msg = new AIMessage({ content: "plain answer" })
    const [out] = normalizeAssistantContent([msg])
    expect(out.content).toBe("plain answer")
  })

  it("leaves non-AI messages untouched", () => {
    const msg = new HumanMessage({ content: [{ type: "text", text: "hi" }] })
    const [out] = normalizeAssistantContent([msg])
    expect(out.content).toEqual([{ type: "text", text: "hi" }])
    expect(out._getType()).toBe("human")
  })
})

describe("buildStreamBlocks()", () => {
  // The empty priming block (`{ text: "", index: 100 }`) was removed:
  // langchain-core's `_mergeLists` (messages/base.js) matches array items by
  // `index`, so the priming block became the merge target for every subsequent
  // delta, orphaning the real first delta at position 1 and scrambling
  // AIMessage.content order. No code path in this repo uses
  // `convertChunksToEvents`/`TextContentStream`, so priming is unnecessary here.
  it("emits one text block for a text chunk", () => {
    expect(buildStreamBlocks("Hello", "")).toEqual([{ type: "text", text: "Hello", index: 100 }])
  })

  it("emits one text block for every text chunk (no priming state)", () => {
    expect(buildStreamBlocks(" world", "")).toEqual([{ type: "text", text: " world", index: 100 }])
  })

  it("routes reasoning to its own high index", () => {
    expect(buildStreamBlocks("", "thinking...")).toEqual([
      { type: "reasoning", reasoning: "thinking...", index: 101 },
    ])
  })

  it("emits reasoning + text together when a chunk carries both", () => {
    expect(buildStreamBlocks("Sure!", "let me check")).toEqual([
      { type: "reasoning", reasoning: "let me check", index: 101 },
      { type: "text", text: "Sure!", index: 100 },
    ])
  })

  it("returns no blocks when the chunk has neither text nor reasoning", () => {
    expect(buildStreamBlocks("", "")).toEqual([])
  })

  // Regression: langchain-core `_mergeLists` (messages/base.js) matches array
  // items by `index`. Every text delta from buildStreamBlocks carries index=100.
  // A prior version emitted a priming `{ text: "", index: 100 }` alongside the
  // first real delta — that priming block became the merge target for every
  // subsequent delta while the real first delta was orphaned at position 1,
  // scrambling the final text (delta 1 stranded at the end after the join in
  // messageText → visible as a trailing preamble fragment on the response).
  // Aggregating chunks via langchain's real .concat() catches this class of bug.
  it("chunks aggregate cleanly via langchain concat (no scramble, preserves order)", async () => {
    const { AIMessageChunk } = await import("@langchain/core/messages")

    const deltas = ["Hello", " world", ". This ", "is a ", "test."]
    const chunks = deltas.map((d) => new AIMessageChunk({ content: buildStreamBlocks(d, "") }))

    // Aggregate exactly like graph.stream("messages") does
    let aggregated = chunks[0]
    for (let i = 1; i < chunks.length; i++) aggregated = aggregated.concat(chunks[i])

    // Text preserved in ORDER — no orphaned first delta at the end.
    const asText = Array.isArray(aggregated.content)
      ? aggregated.content
          .filter((b) => b?.type === "text" && b.text)
          .map((b) => b.text)
          .join("")
      : aggregated.content
    expect(asText).toBe("Hello world. This is a test.")
  })
})
