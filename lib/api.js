import cds from "@sap/cds"
import cds_compile_to_a2a from "./compile.js"

export const registerCompileTargets = () => {
  cds.compile.to.a2a = cds_compile_to_a2a
}
