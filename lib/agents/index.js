import cds from '@sap/cds'

export const agents = {
  get langchain() { return import('./langchain.js') },
  get pi() { return import('./pi.js') },
  async for(srv) {
    const harness = cds.env.agents?.harness ?? 'langchain'
    if (!agents[harness]) throw new Error(`Agent harness ${harness} not found`)
    const h = await agents[harness]
    const create = h.default ?? h
    return await create(srv)
  }
}
export default agents
