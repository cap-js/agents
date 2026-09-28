import cds from "@sap/cds"

const { POST, axios } = cds.test(import.meta.dirname + "/../projects/bookshop")
import createHelpers from "../utils/helpers.js"

const { sendMessage } = createHelpers({ POST, axios })

describe.concurrent("AI Core missing credentials handling", () => {
  test.concurrent(
    "fails A2A task when content filter is enabled and AI Core credentials are missing",
    async () => {
      const res = await sendMessage("aicore-missing-credentials-filter-on", "Show books")

      expect(res.status).toBe(200)
      expect(res.data.result?.status?.state).toBe("failed")
      expect(res.data.result?.status?.message.parts[0].text).toMatch(/service credentials/)
    },
    120_000,
  )

  test.concurrent(
    "fails A2A task when content filter is disabled and AI Core credentials are missing",
    async () => {
      const res = await sendMessage("aicore-missing-credentials-filter-off", "Show books")

      expect(res.status).toBe(200)
      expect(res.data.result?.status?.state).toBe("failed")
      expect(res.data.result?.status?.message.parts[0].text).toMatch(/service credentials/)
    },
    120_000,
  )
})
