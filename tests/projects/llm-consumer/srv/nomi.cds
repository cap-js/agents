@agent @odata
service nomi {

    // ── Start a new Nomí agent session ──────────────────────────────
    action startSession() returns SessionHandle;

    // ── Send user input to an active session (streaming request) ───
    action sendMessage(sessionId: UUID)
        returns LargeBinary;

    // ── Stream: agent tokens + UI metadata + TTS audio chunks ─────
    // Consumed by the UI via fetch().response.body.getReader()
    // Response is a JSON-lines stream with mixed message types:
    //   { "type": "token",      "text": "Hello" }
    //   { "type": "expression", "expression": "happy", "duration": 3000 }
    //   { "type": "data-point", "text": "Revenue", "x": 0.6, "y": 0.3 }
    //   { "type": "move",       "x": 400, "y": 300 }
    //   { "type": "tts-audio",  "audioData": "<base64>" }
    //   { "type": "flush" }
};

// ── Shared types ──────────────────────────────────────────────────
type SessionHandle {
    ID: UUID;
}
