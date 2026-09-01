import cds from "@sap/cds"
import { resolveMlflowCredentials } from "../credentials.js"
import { MlflowExporter } from "./MlflowExporter.js"
import { DatabricksExporter } from "./DatabricksExporter.js"

export { MlflowExporter } from "./MlflowExporter.js"
export { DatabricksExporter } from "./DatabricksExporter.js"

let _instance = null

// Returns the singleton exporter for the current credentials, or null when
// MLflow is disabled or credentials are missing.
export function getMlflowExporter() {
  if (!cds.env.agents?.mlflow) return null
  if (_instance) return _instance
  const creds = resolveMlflowCredentials()
  if (!creds) return null
  _instance = creds.uc ? new DatabricksExporter(creds) : new MlflowExporter(creds)
  return _instance
}
