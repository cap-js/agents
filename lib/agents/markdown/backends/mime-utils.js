export function isTextMime(mimeType) {
  if (!mimeType) return false
  if (mimeType.startsWith("text/")) return true
  return [
    "application/json",
    "application/xml",
    "application/csv",
    "application/x-ndjson",
    "application/ld+json",
    "application/graphql",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/ecmascript",
    "application/sql",
  ].includes(mimeType)
}

export function globToRegex(pattern) {
  let re = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      const close = pattern.indexOf("]", i)
      if (close === -1) re += "\\["
      else {
        re += pattern.slice(i, close + 1)
        i = close
      }
    } else if (".+^${}()|\\".includes(c)) re += "\\" + c
    else re += c
  }
  return new RegExp(re + "$")
}
