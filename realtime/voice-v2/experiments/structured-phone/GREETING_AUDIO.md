# Structured phone greeting preparation

Only the business-gated structured phone route uses this process-local cache.
The normal driver, conversation decisions, greeting wording, model, voice,
speaking rate, scheduling and confirmation rules are unchanged. No external
storage, pre-generated audio, environment flag or process-startup provider request exists.

## Actual path and waits

1. The production initializer receives a validated Twilio start and resolves the
   called number to the authoritative business. Business identity and language
   must be known before choosing/rendering the greeting; lookup time is unknown.
2. The session establishes/configures the intake connection. Caller audio is
   buffered until configuration acknowledgment. Playback still waits for this
   readiness, preserving transcription and interruption behavior and the existing
   startup watchdog. Connection/configuration latency is unknown, not TTS latency.
3. Previously, intake readiness preceded greeting rendering and TTS dispatch.
   The canonical business-only rendered text does not depend on that network
   acknowledgment. At an accepted stream start the structured path now prepares
   that exact text concurrently. No frames, response ownership or playback marks
   are created by preparation alone.
4. Cold preparation uses the existing Speech adapter: request -> headers ->
   complete WAV body -> existing WAV/PCM24k-to-PCMU8k conversion. Greeting audio
   remains buffered; this change does not add streaming. Provider/header/body
   delays remain unmeasured here; neither their cause nor live improvement is
   established by source inspection.
5. After intake readiness, the existing greeting response/floor/preparation
   lifecycle awaits the prepared artifact, validates the exact application text,
   persists the assistant transcript for this call, and submits Twilio media.
   Persistence remains a required successful per-call gate, including cache hits.
   Its live duration is unknown. The existing final mark/playback registry and
   acknowledgment remain call-specific; greeting playback is not confirmation.

The source-proven removable serialization is **intake acknowledgment then TTS**.
It becomes concurrent preparation with playback gated by both. No business
resolution, intake readiness, transcript persistence or authority check is removed.

## Identity, bounds and cold behavior

SHA-256 identity covers business ID, exact rendered text, EN/ES language, model,
voice, endpoint, requested WAV format, delivered PCMU format and conversion
version. Current Speech requests expose no speed/instruction settings; future
synthesis settings must extend this identity before caching them. Unknown adapter
configuration bypasses this optional path. Only canonical initial introductions
matching ResponsePlanner qualify; caller/proposal details and conversational
sentences cannot be cached. Shared production adapters are not modified.

One cache belongs to each production initializer, shared across its selected
structured sessions. Bounds: 32 entries including in-flight work, 4 MiB converted
audio total, 256 KiB per retained clip, 15-minute TTL and LRU eviction of ready
entries. Oversized complete clips can serve their waiting call but are not retained.
If all 32 slots are in flight, a new distinct preparation fails through the
existing safe speech-failure path without issuing another provider request.
Preparation has a 60-second upper bound; existing per-call startup/preparation
deadlines and request ceilings continue to apply and may end a subscriber sooner.

Identical concurrent preparations share one provider request. Each subscriber
has independent cancellation; the underlying preparation is aborted when its
last waiter cancels. Failure/abort removes the entry immediately. Late completion
cannot overwrite a replacement entry. Each successful reader receives copied
bytes; no caller identity, credentials, provider envelope, playback objects or
old latency/provider-request metadata is retained. HIT/JOIN/MISS events do not
claim an HTTP request occurred or that audio was audible.

Each call reserves its existing greeting speech slot even on a hit; overlapping
preparation and later consumption do not count twice. An early preparation
failure is retained for that call's ordinary failure path, never silently retried.
Interruption, close or termination cancels the subscriber before late output can
play. Completed valid business-only audio may remain warm for another call.

After process restart, expiry, eviction or identity change there is no reusable
artifact: a real cold request is still required. This cache does not eliminate
first-call provider time-to-audio and does not warm itself at startup.

## Controlled evidence (not a live latency prediction)

Same fixtures: intake ready at 300 ms, cold synthesis including WAV conversion
takes 500 ms, successful persistence takes 50 ms. No audible playback measured.

| Mode | Speech provider requests | First Twilio media |
| --- | ---: | ---: |
| Previous serial control | 1 | 850 ms |
| Cold concurrent preparation | 1 | 550 ms |
| Warm reuse | 0 | 350 ms |

Tests cover shared preparation with one call terminating, independent persistence
and marks, late canceled audio, next-call recovery, key changes, TTL/LRU/byte and
pending bounds, invalid audio, preparation deadline, and zero decision/booking/SMS
requests for greeting playback. These fixtures cannot explain remote TTS waits.
