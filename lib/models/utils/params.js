export function noTemp0Support(model) {
  if (!model?.startsWith("gpt-")) return false
  switch (model) {
    case "gpt-5.5":
    case "gpt-5.6-sol":
    case "gpt-5.6-luna":
    case "gpt-5.6-terra":
      return true
    default:
      return !["gpt-3", "gpt-4", "gpt-5"].some((prefix) => model.startsWith(prefix))
  }
}
