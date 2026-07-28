import { describe, it, expect } from "vitest"
import { extractTextFromContentBlocks } from "../../srv/handlers/model.js"

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
})
