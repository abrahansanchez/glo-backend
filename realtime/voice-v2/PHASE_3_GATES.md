# Phase 3 product gates

- `VoiceCallRecord` is deliberately separate from the frozen V1 `CallTranscript` model.
- Existing dashboard and analytics readers do not yet include `VoiceCallRecord`; wiring those consumers is a required pre-beta product task.
- Transcript persistence has no Expo push side effect. If notifications are required, a later coordinator must issue an explicit, independently observable effect.
- SMS failures are now structured boundary results. V1 behavior is unchanged because V1 does not call this shared service yet; any future V1 adoption must explicitly review how surfaced `PROVIDER_ERROR` and `DELIVERY_UNKNOWN` results affect logging, alerting, and control flow.
- Transcript finalization treats `outcome`, `appointmentId`, and metadata fields `intent`/`language` as authoritative. Other metadata is diagnostic-only: it is persisted but excluded from `finalizationHash`; volatile timestamps are also excluded.
