# Terminal recovery assets — PRODUCTION_ASSETS_REQUIRED

Both source recordings were explicitly human-approved, then converted offline with FFmpeg 9.0.2 to the production format. The supplied SHA-256 manifest approves the exact converted files. Missing, modified or invalid assets still fail closed with `PRODUCTION_ASSETS_REQUIRED`. Test fixtures are generated in memory and are not production recordings.

Required files in this directory:

- `terminal-recovery.en.wav`: “Sorry, I’m having trouble responding right now. Please call again shortly.”
- `terminal-recovery.es.wav`: “Lo siento, estoy teniendo problemas para responder. Por favor, llama de nuevo en unos minutos.”
- `terminal-recovery.approved.json`: an object with `en` and `es` keys containing the reviewed files’ lowercase SHA-256 hashes.

Format: little-endian RIFF/WAVE, G.711 mu-law (format tag 7), 8000 Hz, mono, 8 bits per sample, byte rate 8000, block alignment 1. Duration must be 20 ms–15 seconds. The `fmt ` chunk must be exactly 16 bytes, or exactly 18 bytes with `cbSize=0`; unsupported extensions and malformed sizes are rejected. Only `fmt `, `data`, and optional four-byte `fact` chunks are permitted; no embedded transcript, credentials, instructions, business data or other metadata. The data chunk is submitted as raw PCMU through the existing Twilio media path. Hash approval verifies the exact reviewed recording; format validation alone cannot verify its spoken wording.

Do not generate recordings with a provider during a call. Obtain and review both recordings offline before deployment. Both files and hashes are validated at session initialization and cached privately before selecting either language. Recovery therefore performs no filesystem reads. Failed initialization remains fail-closed for that adapter. Missing, unapproved, corrupt or incompatible assets cause safe termination without synthesis or another recovery attempt.

`VOICE_V2_SPEECH_PREPARATION_TIMEOUT_MS` has a 5000 ms default. Only integer values from 1000 through 10000 ms are accepted; invalid, empty, infinite or out-of-range values use 5000 ms. This is an initial controlled-test target, not a proven permanent latency budget. Recovery playback uses `Math.min(17000, Math.ceil(submittedAudioBytes / 8) + 2000)` milliseconds: actual submitted PCMU payload duration rounded up, plus a 2000 ms acknowledgement margin, capped at 17000 ms. Valid clips therefore have deadlines from 2020 through 17000 ms. Matching playback acknowledgement cancels the deadline; missing acknowledgement terminates without another recovery. The normal-response playback watchdog is unchanged.
