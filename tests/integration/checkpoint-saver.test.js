import assert from "node:assert/strict"
import cds from "@sap/cds"
cds.test(import.meta.dirname + "/../bookshop")
import { CdsCheckpointSaver } from "../../lib/persistence/checkpoint-saver.js"

const CHECKPOINTS = "cap.agent.Checkpoints"
const WRITES = "cap.agent.CheckpointWrites"

function runAs(userId, fn) {
  return cds._with({ user: new cds.User({ id: userId }) }, fn)
}

function makeCheckpoint(id) {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
    channel_values: {},
  }
}

async function seedCheckpoints(userId, threadId, count) {
  const saver = new CdsCheckpointSaver()
  const ids = []
  await runAs(userId, async () => {
    let config = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    for (let i = 0; i < count; i++) {
      const cp = makeCheckpoint(`cp-${userId}-${threadId}-${String(i).padStart(3, "0")}`)
      // eslint-disable-next-line no-await-in-loop
      config = await saver.put(config, cp, { step: i, source: "loop" })
      ids.push(cp.id)
    }
  })
  return ids
}

describe("CdsCheckpointSaver", () => {
  const saver = new CdsCheckpointSaver()

  describe("list()", () => {
    it("returns checkpoints in descending order", async () => {
      const thread = `list-order-${cds.utils.uuid()}`
      const [id0, id1, id2] = await seedCheckpoints("alice", thread, 3)

      const results = []
      await runAs("alice", async () => {
        for await (const t of saver.list({ configurable: { thread_id: thread } })) {
          results.push(t)
        }
      })

      assert.strictEqual(results.length, 3)
      // Descending order: last seeded first
      assert.strictEqual(results[0].config.configurable.checkpoint_id, id2)
      assert.strictEqual(results[1].config.configurable.checkpoint_id, id1)
      assert.strictEqual(results[2].config.configurable.checkpoint_id, id0)
    })

    it("respects options.limit", async () => {
      const thread = `list-limit-${cds.utils.uuid()}`
      await seedCheckpoints("alice", thread, 10)

      const results = []
      await runAs("alice", async () => {
        for await (const t of saver.list({ configurable: { thread_id: thread } }, { limit: 3 })) {
          results.push(t)
        }
      })

      assert.strictEqual(results.length, 3)
    })

    it("respects options.before for cursor pagination", async () => {
      const thread = `list-before-${cds.utils.uuid()}`
      const ids = await seedCheckpoints("alice", thread, 5)

      // ids[2] is the 3rd checkpoint; before it we expect ids[0] and ids[1]
      const beforeId = ids[2]
      const results = []
      await runAs("alice", async () => {
        for await (const t of saver.list(
          { configurable: { thread_id: thread } },
          { before: { configurable: { checkpoint_id: beforeId } } },
        )) {
          results.push(t)
        }
      })

      const returnedIds = results.map((r) => r.config.configurable.checkpoint_id)
      assert.deepStrictEqual(
        returnedIds,
        [ids[1], ids[0]],
        "should return exactly the two checkpoints older than the cursor, newest-first",
      )
    })

    it("isolates checkpoints by user (user B sees nothing from user A)", async () => {
      const thread = `list-isolation-${cds.utils.uuid()}`
      await seedCheckpoints("alice", thread, 3)

      const results = []
      await runAs("bob", async () => {
        for await (const t of saver.list({ configurable: { thread_id: thread } })) {
          results.push(t)
        }
      })

      assert.strictEqual(results.length, 0)
    })

    it("yields checkpoint and parentConfig correctly", async () => {
      const thread = `list-parent-${cds.utils.uuid()}`
      const ids = await seedCheckpoints("alice", thread, 2)

      const results = []
      await runAs("alice", async () => {
        for await (const t of saver.list({ configurable: { thread_id: thread } })) {
          results.push(t)
        }
      })

      // Most recent (ids[1]) has ids[0] as parent
      const latest = results.find((r) => r.config.configurable.checkpoint_id === ids[1])
      assert.ok(latest, "latest checkpoint must be present")
      assert.strictEqual(latest.parentConfig?.configurable?.checkpoint_id, ids[0])
    })

    it("streams beyond a single batch without imposing a default cap", async () => {
      // Seeds more than the internal BATCH_SIZE (100) to exercise cursor-paged
      // batching across multiple SELECTs.
      const thread = `list-unbounded-${cds.utils.uuid()}`
      const seeded = 150
      await seedCheckpoints("alice", thread, seeded)

      let count = 0
      await runAs("alice", async () => {
        for await (const _ of saver.list({ configurable: { thread_id: thread } })) {
          count++
        }
      })

      assert.strictEqual(count, seeded, "should yield every seeded checkpoint")
    })
  })

  describe("deleteThread()", () => {
    it("deletes only the requesting user's checkpoints", async () => {
      const thread = `delete-isolation-${cds.utils.uuid()}`
      await seedCheckpoints("alice", thread, 2)
      await seedCheckpoints("bob", thread, 2)

      // Alice deletes her checkpoints for the thread
      await runAs("alice", () => saver.deleteThread(thread))

      // Alice's checkpoints are gone
      const aliceRows = await runAs("alice", () =>
        SELECT.from(CHECKPOINTS).where({ thread_id: thread, createdBy: "alice" }),
      )
      assert.strictEqual(aliceRows.length, 0)

      // Bob's checkpoints are intact
      const bobRows = await runAs("bob", () =>
        SELECT.from(CHECKPOINTS).where({ thread_id: thread, createdBy: "bob" }),
      )
      assert.strictEqual(bobRows.length, 2)
    })

    it("deletes associated writes for the user", async () => {
      const thread = `delete-writes-${cds.utils.uuid()}`
      await seedCheckpoints("alice", thread, 2)

      await runAs("alice", () => saver.deleteThread(thread))

      const writeRows = await SELECT.from(WRITES).where({ thread_id: thread })
      assert.strictEqual(writeRows.length, 0)
    })
  })
})
