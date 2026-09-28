/**
 * Minimal TOML parser supporting:
 *   - bare keys and quoted keys
 *   - string values (single- and double-quoted)
 *   - boolean values
 *   - standard tables ([section]) and dotted tables ([a.b])
 *   - comments (#)
 */

export const toml = {
  parse(src) {
    const lines = src.split(/\r?\n/)
    const root = {}
    let current = root

    for (let raw of lines) {
      const line = raw.replace(/#.*$/, "").trim()
      if (!line) continue

      // table header
      const tableMatch = line.match(/^\[([^\]]+)\]$/)
      if (tableMatch) {
        current = tableMatch[1]
          .trim()
          .split(".")
          .reduce((obj, key) => {
            key = key.trim()
            if (!obj[key] || typeof obj[key] !== "object") obj[key] = {}
            return obj[key]
          }, root)
        continue
      }

      // key = value
      const kvMatch = line.match(/^([A-Za-z0-9_\-."']+)\s*=\s*(.+)$/)
      if (!kvMatch) continue
      const key = kvMatch[1].replace(/^['"]|['"]$/g, "")
      const raw_val = kvMatch[2].trim()

      let value
      if (/^'''[\s\S]*'''$/.test(raw_val) || /^"""[\s\S]*"""$/.test(raw_val)) {
        value = raw_val.slice(3, -3)
      } else if (/^'[^']*'$/.test(raw_val)) {
        value = raw_val.slice(1, -1)
      } else if (/^"[^"]*"$/.test(raw_val)) {
        value = raw_val
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      } else if (raw_val === "true") {
        value = true
      } else if (raw_val === "false") {
        value = false
      } else if (!isNaN(Number(raw_val))) {
        value = Number(raw_val)
      } else {
        value = raw_val
      }

      current[key] = value
    }

    return root
  },
}
