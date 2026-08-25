#!/usr/bin/env node
// Creates (or reuses) an SAP AI Core orchestration deployment and waits until RUNNING.
// Usage: node tests/utils/orchestration-deployment.js [--resource-group <rg>]

import { DeploymentApi, ConfigurationApi } from "@sap-ai-sdk/ai-api"

const SCENARIO_ID = "orchestration"
const EXECUTABLE_ID = "orchestration"

export async function createOrchestrationDeployment(opts = {}) {
  const {
    name = "orchestration",
    resourceGroup = "default",
    pollInterval = 5000,
    timeout = 300_000,
  } = opts

  const headers = { "AI-Resource-Group": resourceGroup }

  // 1. Upsert configuration — reuse existing one with same name/scenario/executable
  const existingConfigs = await ConfigurationApi.configurationQuery(
    { scenarioId: SCENARIO_ID, executableId: EXECUTABLE_ID },
    headers,
  ).execute()

  const existingConfig = existingConfigs.resources?.find((c) => c.name === name)

  let configurationId
  if (existingConfig) {
    configurationId = existingConfig.id
  } else {
    const configResponse = await ConfigurationApi.configurationCreate(
      { name, executableId: EXECUTABLE_ID, scenarioId: SCENARIO_ID },
      headers,
    ).execute()
    configurationId = configResponse.id
    if (!configurationId)
      throw new Error(`Configuration creation failed: ${JSON.stringify(configResponse)}`)
  }

  // 2. Upsert deployment — reuse existing RUNNING or PENDING deployment for this configuration
  const existingDeployments = await DeploymentApi.deploymentQuery(
    { configurationId, scenarioId: SCENARIO_ID },
    headers,
  ).execute()

  const reuseDeployment = existingDeployments.resources?.find(
    (d) => d.status === "RUNNING" || d.status === "PENDING",
  )

  let deploymentId, deployStatus
  if (reuseDeployment) {
    deploymentId = reuseDeployment.id
    deployStatus = reuseDeployment.status
  } else {
    const deployResponse = await DeploymentApi.deploymentCreate(
      { configurationId },
      headers,
    ).execute()
    deploymentId = deployResponse.id
    deployStatus = deployResponse.status
    if (!deploymentId)
      throw new Error(`Deployment creation failed: ${JSON.stringify(deployResponse)}`)
  }

  if (deployStatus === "RUNNING") {
    return { configurationId, deploymentId, status: deployStatus }
  }

  // 3. Poll until RUNNING (or terminal failure)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await sleep(pollInterval)

    const d = await DeploymentApi.deploymentGet(deploymentId, {}, headers).execute()
    const status = d.status

    if (status === "RUNNING") {
      return { configurationId, deploymentId, status }
    }
    if (status === "DEAD" || status === "ERROR" || status === "STOPPED") {
      throw new Error(`Deployment ${deploymentId} reached terminal status: ${status}`)
    }
  }

  throw new Error(`Deployment ${deploymentId} did not reach RUNNING within ${timeout}ms`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resource-group") opts.resourceGroup = args[++i]
    else {
      console.error(`Unknown option: ${args[i]}`)
      process.exit(1)
    }
  }
  createOrchestrationDeployment(opts)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
}
