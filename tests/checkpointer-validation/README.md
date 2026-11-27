# Checkpointer validation

```sh
npm run test:checkpointer-validation
```

The upstream `validate()` and optional `deltaChannelHistoryTests()` run against `CdsCheckpointSaver` using the bookshop fixture's in-memory SQLite database. They also run with `npm test` and in CI. No tests are skipped or marked as expected failures.

The suite runs with both values of the retired `cds.env.agents.persistAllCheckpointWrites` option to verify that applications still setting it get complete persistence. The saver always stores regular and special writes: recovery and delta history depend on them.

```sh
npm run test:checkpointer-validation -- -t 'persistAllCheckpointWrites=false'
npm run test:checkpointer-validation -- --reporter=json --outputFile=/tmp/checkpointer-validation.json
```

## Results

With `@langchain/langgraph-checkpoint-validation` 1.2.1 and `@langchain/langgraph-checkpoint` 1.2.3, both configurations pass all 754 checks: **1,508 passed, 0 failed, 0 skipped**.

| Suite                    | Tests per configuration |
| ------------------------ | ----------------------: |
| `put`                    |                      22 |
| `putWrites`              |                       6 |
| `getTuple`               |                      41 |
| `list`                   |                     650 |
| `deleteThread`           |                       1 |
| `getDeltaChannelHistory` |                      34 |

The CAP tests additionally cover user isolation with identical storage identifiers, service-scoped threads sharing one A2A context, fresh saver instances, binary serializers, concurrent writes, retry deduplication, transaction rollback, branch ancestry, and retention.

## Storage model

All checkpoint data lives in generic `cap.agent.Messages` rows. `cap.agent.Sessions` holds only an owner, a message sequence counter, managed timestamps, and the message composition. Its `(ID, owner)` key and row lock coordinate writes. Neither entity has LangChain-specific columns.

Messages have generic `scope` (logical collection), `stream` (subcollection), `category`, and `sortKey` fields for portable indexed queries. The adapter maps these to thread, namespace, record kind, and checkpoint ID. CDS unique constraints ending in the already-unique message ID provide portable compound indexes without adding uniqueness requirements to logical checkpoint IDs.

The adapter writes `role: system`, `type: data` records. Their `query` map identifies the versioned adapter format (`langgraph-checkpoint/1`) and adapter attributes. Conversation displays should select the message types they display rather than rendering these internal records.

Five record kinds share this schema:

- **Checkpoint:** serialized checkpoint header and metadata. `prev` links to the parent checkpoint message, including parents whose logical IDs sort later.
- **Value:** an immutable channel value at a particular version, or an empty marker. Unchanged versions are reused. New versions include a random fractional component to separate branches advancing from the same parent.
- **Write:** an intermediate task output. `prev` links to its checkpoint. The payload retains task path, task ID, and numeric index for canonical ordering. Regular writes retain the first value on retry; special writes are replaceable.
- **Chunk:** immutable serialized bytes, addressed by their content hash.
- **Node:** immutable sequence-tree node referring to one chunk and up to two child nodes.

### Sharing growing histories

Small serialized values (up to 512 bytes) stay inline. Larger values are split with content-defined boundaries: a gear hash, a 1 KiB minimum, a 12-bit boundary mask, and a 16 KiB maximum. Boundaries generally realign after an early insertion or edit, allowing later chunks to remain shared. Bytes are stored losslessly as base64; serializer type tags are retained, including for custom binary serializers.

A snapshot stores a constant-size tree-root descriptor, never a growing flat list of message/chunk IDs. Chunks form a canonical Cartesian tree (treap), with priorities derived from chunk hashes and occurrence counts. Occurrence counts prevent repeated identical chunks from degenerating into a chain. Nodes are also content-addressed, so a small edit or append normally adds changed chunks and an expected logarithmic number of tree nodes. Existing subtrees are reused without reading their descendants during persistence. New records are inserted in batches under the session lock.

This applies to ordinary full channel values, delta-channel snapshots, pending writes, and checkpoint metadata. It is independent of LangGraph reducers: normal message channels need no configuration change. `MessagesDeltaValue` and custom `DeltaValue` channels retain their native snapshot/replay semantics. The adapter does not silently convert an application's channel type.

Sharing is scoped to owner and thread, across its namespaces and record kinds. Deterministic UUIDs allow fresh saver instances to reconstruct every checkpoint without process-local state. Normal A2A UUIDs, including service-prefixed thread IDs, retain their context ID in `Messages.session`; other thread IDs map deterministically to UUIDs.

### Reads and concurrency

Latest-checkpoint lookup uses an indexed descending query with `LIMIT 1`. History uses SQL filters and compound keyset pagination on `(sortKey, ID)`, including equal checkpoint IDs across namespaces. Channel value descriptors are fetched in batches. Metadata filtering happens before reconstructing channel values; arbitrary metadata filters, and namespace-only searches across all threads, can still scan checkpoint headers because their payload fields are not portably queryable on every CAP database.

Delta history prefetches bounded windows of 64 headers and batches value-descriptor and write reads. It follows actual parent links, including forks and out-of-order parents, collects only requested channels, and deserializes only their seeds and on-path writes. Boundary checkpoint writes are included; target checkpoint writes are excluded. Legacy checkpoint versions retain the base implementation's pending-send migration behavior.

Session locks serialize mutations across transactions. A transaction-local promise queue also serializes calls sharing a transaction. The persisted counter avoids scanning history to allocate each sequence. Checkpoint headers, values, and shared content commit atomically and join the request transaction when present.

`deleteThread()` deletes the thread's chunks and nodes along with its headers, values, and writes. Other services sharing the session, other users, and ordinary conversation messages survive. Task retention removes a session only when it has expired and no remaining task references it; subsequent cleanup runs revisit orphan sessions. There is no individual-checkpoint pruning: content made unreachable by replacing special writes or checkpoint IDs remains until thread/session deletion.

### Complexity and measurements

For append-oriented histories with stable serialization, storage grows with new/changed chunks plus expected `O(log C)` tree nodes per small update, where `C` is the current chunk count. Retaining `n` small updates therefore has approximately linear payload growth and expected `O(n log n)` reference overhead, rather than duplicating `1 + 2 + ... + n` messages. This is structural sharing, not a promise of linear storage for arbitrary states that change completely on every step.

Ordinary channels still supply the whole value: serializing and inspecting a value of size `S` costs `O(S)` time and temporary memory per save. Delta channels avoid that work between snapshots; their periodic full snapshots share existing content too. Restoring a complete history necessarily materializes `O(S)` bytes. Custom serializers round-trip exactly, but compression, encryption, or nondeterministic serialization that changes most bytes can defeat sharing.

The regression tests in `tests/integration/checkpointer-scaling.test.js` cover growing full histories, real ordinary/delta graphs crossing snapshot boundaries, early insertion/replacement/removal, forks, fresh-instance restores, duplicate binary chunks, large pending writes, retry deduplication, logical-order pagination, and SQLite index selection. Storage measurements are recorded in each test's `meta.storage` in the JSON report. They count serialized database rows, including row metadata and base64 overhead, but exclude physical database pages and index storage.

```sh
npm test -- tests/integration/checkpointer-scaling.test.js --reporter=json --outputFile=/tmp/checkpointer-scaling.json
```

Measured on SQLite with deterministic 1.5 KiB message bodies and all checkpoints retained:

| Workload                                       | History sizes      | Stored rows at first size | Stored rows at doubled size | Growth |
| ---------------------------------------------- | ------------------ | ------------------------: | --------------------------: | -----: |
| Full snapshots via saver API                   | 128 → 256 messages |                   1.60 MB |                     3.28 MB |  2.05× |
| Ordinary message graph                         | 110 → 220 messages |                   2.94 MB |                     6.01 MB |  2.04× |
| Delta message graph (default snapshot cadence) | 110 → 220 messages |                   2.12 MB |                     4.24 MB |  2.00× |

MB denotes 1,000,000 serialized row bytes. Graph workloads retain input/intermediate checkpoints and pending writes as well as final checkpoints. Tests also verify that latest lookup returns one header and that SQLite selects the compound index without a table scan or temporary sort.

## Compatibility and limits

This replaces the old `Checkpoints`/`CheckpointWrites` model. Existing rows are **not automatically migrated**. Persistent installations need a migration before adopting the new schema; in-memory fixtures start empty. Interim message-backed rows also need the generic query fields backfilled and session counters initialized. The content reader accepts the earlier inline envelope, and legacy checkpoints supplied through the API still get pending-send migration; neither feature migrates database rows.

The old `persistAllCheckpointWrites` setting is ignored. Full write persistence is required for recovery and delta replay.

The model compiles for SQLite, PostgreSQL, and HANA. Conformance, concurrency, query-plan, and growth tests run against SQLite; PostgreSQL and HANA still require runtime validation.
