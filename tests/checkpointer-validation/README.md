# Checkpointer validation

Run LangGraph's upstream validation suite against `CdsCheckpointSaver`:

```sh
npm run test:checkpointer-validation
```

The harness uses the bookshop test fixture's in-memory SQLite database and a fixed CDS user. It clears checkpoint tables between saver instances, as required by the upstream suite. It runs `validate()` and the optional `deltaChannelHistoryTests()` with both values of `cds.env.agents.persistAllCheckpointWrites`: `false` (the production default) and `true` (full persistence).

This is a separate diagnostic suite, outside `npm test` and the current CI workflow, because the saver does not yet satisfy the full upstream contract. Failures are reported normally and the command exits nonzero; there are no local skips or expected-failure annotations. The existing CAP checkpoint integration tests remain part of `npm test`.

To select one persistence mode or write a machine-readable report:

```sh
npm run test:checkpointer-validation -- -t 'persistAllCheckpointWrites=true'
npm run test:checkpointer-validation -- --reporter=json --outputFile=/tmp/checkpointer-validation.json
```

## Baseline

Recorded on 2026-11-26 using `@langchain/langgraph-checkpoint-validation` 1.2.1 and `@langchain/langgraph-checkpoint` 1.2.2. Each mode runs 754 tests, including 34 delta-history tests.

| Suite                    | Tests per mode | Failures, default (`false`) | Failures, full persistence (`true`) |
| ------------------------ | -------------: | --------------------------: | ----------------------------------: |
| `put`                    |             22 |                           1 |                                   1 |
| `putWrites`              |              6 |                           2 |                                   0 |
| `getTuple`               |             41 |                           9 |                                   3 |
| `list`                   |            650 |                         296 |                                 296 |
| `deleteThread`           |              1 |                           0 |                                   0 |
| `getDeltaChannelHistory` |             34 |                          32 |                                   4 |
| **Total**                |        **754** |                     **340** |                             **304** |

Across both modes: **864 passed, 644 failed, 0 skipped**. Counts reflect parameterized assertions, not independent bugs, and can change with upstream package updates.

## Contract gaps

- **Regular pending writes:** With the default setting, `putWrites()` discards nonnegative-index writes and `getTuple()` excludes them. Upstream expects these writes to survive so execution can recover completed tasks and reconstruct delta channels. Full persistence resolves the basic write round-trip failures.
- **Write ordering:** `putWrites()` does not store the upstream `taskPath` argument, and `getTuple()` loads writes without a defined order. Upstream requires `writesSortKey` ordering, including task paths, pathless legacy writes, and numeric write indices. Full persistence still fails the `getTuple()` ordering test and two delta-history ordering scenarios in each namespace.
- **Listing across threads and namespaces:** `list()` returns nothing without a `thread_id`, and an omitted namespace selects only the root namespace. Upstream treats omitted fields as unrestricted filters. Any future change must retain CAP's current-user isolation.
- **Metadata filtering and list tuples:** `list()` ignores `options.filter` and omits `pendingWrites` from returned tuples. Upstream checks metadata filters and expects list tuples to match the corresponding `getTuple()` results. These gaps account for many combinations in the list suite.
- **Incremental channel values:** `put()` stores a complete checkpoint and ignores `newVersions`. Upstream's incremental-storage test expects only changed channel values to be stored. The upstream suite explicitly skips this test for its Memory, SQLite, and MongoDB savers; it remains active for `CdsCheckpointSaver`, so this is a known storage-design difference to assess.
- **Legacy pending sends:** Neither `getTuple()` nor `list()` migrates pending sends from parent writes into the `__pregel_tasks` channel for checkpoints with version below 4. Upstream tests this backward-compatibility behavior in both namespaces.

Saver behavior is unchanged by this harness. Passing this suite would cover the upstream contract against SQLite; CAP-specific user isolation, other database backends, and application behavior still need their own tests.
