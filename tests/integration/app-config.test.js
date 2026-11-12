import cds from "@sap/cds"

const { GET } = cds.test(import.meta.dirname + "/../projects/app-config")

describe("Agent application without a custom server", () => {
  it("serves the built UI through CAP's static folder configuration", async () => {
    const response = await GET("/")
    expect(response.data).toContain("<title>Agent application</title>")
  })

  it("exposes application metadata and only HCQL entities", async () => {
    const { data } = await GET("/app-config")
    expect(data.title).toBe("Agent application without a custom server")
    expect(data.agentPath).toBe("/a2a/tasks")
    expect(data.entities).toEqual([
      {
        name: "TasksService.Tasks",
        localName: "Tasks",
        path: "/hcql/tasks",
        dateTimeFields: ["due"],
        compositions: ["notes"],
      },
      {
        name: "TasksService.Notes",
        localName: "Notes",
        path: "/hcql/tasks",
        dateTimeFields: [],
        compositions: [],
      },
    ])
  })

  it("resolves the default AI Core model and credentials from the kind shortcut", () => {
    const env = cds.env.for("cds", cds.root)
    env._add_vcap_services_to({
      aicore: [
        { name: "custom-ai-instance", label: "aicore", credentials: { clientid: "test-client" } },
      ],
    })
    expect(env.requires.llm.kind).toBe("aicore")
    expect(env.requires.llm.model).toBe("anthropic--claude-4.6-sonnet")
    expect(env.requires.llm.credentials.clientid).toBe("test-client")
  })
})
