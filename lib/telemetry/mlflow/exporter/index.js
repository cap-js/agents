import cds from "@sap/cds"
import { resolveMlflowCredentials } from "../credentials.js"
import { MlflowExporter } from "./MlflowExporter.js"
import { DatabricksExporter } from "./DatabricksExporter.js"

export { MlflowExporter } from "./MlflowExporter.js"
export { DatabricksExporter } from "./DatabricksExporter.js"

let _instance = null
let _instanceHost = null // track which host the singleton was built for

// Returns the singleton exporter, rebuilding it when credentials change.
// Returns null when MLflow is disabled or credentials are missing.
export function getMlflowExporter() {
  if (!cds.env.agents?.mlflow) return null
  const creds = resolveMlflowCredentials()
  if (!creds) return null
  // Rebuild if the host changed (e.g. between tests or env reloads)
  if (_instance && _instanceHost === creds.host) return _instance
  _instance = creds.uc ? new DatabricksExporter(creds) : new MlflowExporter(creds)
  _instanceHost = creds.host
  return _instance
}
