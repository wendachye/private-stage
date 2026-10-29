# Later features

The current scope intentionally excludes searchable cross-session chat, recording/replays, transcripts, webcams, and push-to-talk. Do not show an active recording/transcript indicator before the corresponding feature exists.

## Searchable chat history

Use stable message/session/account IDs and UTC timestamps already present in the current model. Add an explicitly separate archive/retention policy, deletion semantics, member access checks, and search indexing. Deleted current-session bodies must not quietly become permanent audit content. Estimate durable storage and backup retention, and communicate what is retained before enabling the archive.

## Recording and replays

Evaluate a compatible self-hosted recording/egress service, its additional CPU/RAM, storage, bandwidth, and failure handling. Provide clear recording notices, consent/administrative policy, session-specific recording controls, recording status tied to real recorder health, playback authorization, retention, and deletion. A media-room permission change is not proof that a recording worker stopped; verify the actual recorder lifecycle.

## Live transcripts

Choose a speech-recognition provider or self-hosted model only after reviewing language quality, privacy, pricing, and compute. Plan speaker/account attribution, corrections, timestamps, accessibility, transcript retention, and separate access controls. A cloud transcription provider would introduce external audio processing and requires an explicit decision rather than silently reusing current Discord consent.

## Cloud hosting

The planned migration is infrastructure work, not an automatic feature expansion or a switch to LiveKit Cloud. Keep the same permission/media enforcement boundary and complete a migration rehearsal and remote trial on the chosen host. See [cloud migration](cloud-migration.md).
