import cds from '@sap/cds'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

// Text-to-speech for Nomí. Two backends, selected by NOMI_TTS_BACKEND:
//   kokoro (default) — Kokoro-82M local neural model (downloads ~90 MB on first use)
//   sapi             — Windows SAPI via PowerShell (WSL2, no download needed)
//
// The only export is synthesizeSpeech(text) → WAV Buffer (or null for empty input).

const TTS_BACKEND = (process.env.NOMI_TTS_BACKEND || 'kokoro').toLowerCase()

export async function synthesizeSpeech(text) {
  const clean = stripForTTS(text ?? '')
  if (!clean) return null
  return TTS_BACKEND === 'sapi' ? sapiToWav(clean) : kokoroToWav(clean)
}

// ── Strip markdown / emojis / noise so the voice reads naturally ──────
function stripForTTS(text) {
  return text
    .replace(/^\|.*\|$/gm, '')                              // markdown table rows
    .replace(/^\s*[-|: ]+\s*$/gm, '')                       // table separator lines
    .replace(/#{1,6}\s+/gm, '')                             // # headings
    .replace(/(\*\*|__)(.*?)\1/gs, '$2')                    // **bold**
    .replace(/(\*|_)(.*?)\1/gs, '$2')                       // *italic*
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')                   // `code`
    .replace(/^\s*[-*+]\s+/gm, '')                          // - list items
    .replace(/^\s*\d+\.\s+/gm, '')                          // 1. ordered list
    .replace(/^\s*>\s*/gm, '')                              // > blockquote
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                // [link](url) → link text
    .replace(/\p{Extended_Pictographic}/gu, '')             // emojis
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '') // UUIDs
    .replace(/\b(\d+)\.(\d{3,})\b/g, (_, int, dec) => {     // long decimals → 2 places
      const trimmed = dec.replace(/0+$/, '')
      return trimmed ? `${int}.${dec.slice(0, 2)}` : int
    })
    .replace(/\b(\d+)\.(\d{1,2})0+\b/g, (_, int, dec) => `${int}.${dec}`) // 1.50000 → 1.5
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── Kokoro (default) ──────────────────────────────────────────────────
let _kokoro = null

async function kokoroToWav(text) {
  _kokoro ??= (async () => {
    const { KokoroTTS } = await import('kokoro-js')
    cds.log('nomi').info('Loading Kokoro-82M TTS (first use — downloads ~90 MB)…')
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
    cds.log('nomi').info('Kokoro TTS ready')
    return tts
  })()
  const tts = await _kokoro
  const { audio, sampling_rate } = await tts.generate(text, { voice: 'af_heart' })
  return float32ToWav(audio, sampling_rate ?? 24000)
}

function float32ToWav(samples, sampleRate = 24000) {
  const n = samples.length
  const buf = Buffer.allocUnsafe(44 + n * 2)
  buf.write('RIFF', 0);  buf.writeUInt32LE(36 + n * 2, 4);  buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);          buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32);          buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7FFF, 44 + i * 2)
  }
  return buf
}

// ── Windows SAPI fallback (NOMI_TTS_BACKEND=sapi) ─────────────────────
const execFileP = promisify(execFile)

async function sapiToWav(text) {
  const id      = randomBytes(6).toString('hex')
  const linText = `/tmp/nomi_${id}.txt`
  const linWav  = `/tmp/nomi_${id}.wav`
  const linPs   = `/tmp/nomi_${id}.ps1`

  const [{ stdout: winText }, { stdout: winWav }, { stdout: winPs }] = await Promise.all([
    execFileP('wslpath', ['-w', linText]),
    execFileP('wslpath', ['-w', linWav]),
    execFileP('wslpath', ['-w', linPs]),
  ])

  await Promise.all([
    writeFile(linText, text, 'utf8'),
    writeFile(linPs, [
      'Add-Type -AssemblyName System.Speech',
      `$text = [System.IO.File]::ReadAllText('${winText.trim()}', [System.Text.Encoding]::UTF8)`,
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female)',
      '$s.Rate = 2; $s.Volume = 100',
      `$s.SetOutputToWaveFile('${winWav.trim()}')`,
      '$s.Speak($text)',
      '$s.Dispose()',
    ].join('\n'), 'utf8'),
  ])

  await execFileP('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winPs.trim(),
  ], { timeout: 20000 })

  const wav = await readFile(linWav)
  await Promise.all([linText, linWav, linPs].map(f => unlink(f).catch(() => {})))
  return wav
}
