/** Model the updates stream and checkpoint state consumed by GraphExecutor. */
export function createMockGraph(run, checkpointer = {}) {
  let state
  return {
    checkpointer: {
      getTuple: async () => ({ checkpoint: { channel_values: state } }),
      ...checkpointer,
    },
    async *stream(input, config) {
      const { __interrupt__, ...values } = await run(input, config)
      state = values
      yield ["updates", { test: values }]
      if (__interrupt__ !== undefined) yield ["updates", { __interrupt__ }]
    },
  }
}
