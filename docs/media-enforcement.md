# Local media enforcement and evidence boundary

Private Stage uses the open-source LiveKit server. The server SDK and browser SDK are production dependencies. `@livekit/rtc-node` is a development-only synthetic-media test client; the public Node SDK documentation labels it Developer Preview, and the application does not depend on it at runtime.

## Why there is an application signaling gateway

Stock self-hosted LiveKit does not invalidate an already issued JWT when a participant is removed or its permissions change. Its server also refreshes connected participants' credentials. A short initial JWT lifetime therefore does not establish immediate revocation. `canPublishSources` restricts source labels, but does not provide a room-wide count of screen tracks.

The browser connects to the application's same-origin `/rtc` WebSocket gateway. Only the gateway can reach the SFU's signaling endpoint in the supported deployment boundary:

1. The gateway verifies the presented LiveKit JWT signature and validity.
2. The application callback verifies its maintained encrypted session, server-issued device admission, account, live session, membership freshness, and moderation state. The callback must also enforce the configured request Origin policy.
3. The gateway issues a fresh upstream JWT from current server policy. It ignores the presented token's publishing grants, display metadata, and other authorization claims.
4. Every incoming signal message is parsed and canonically encoded using the pinned LiveKit protocol package. Unknown request types and opaque protocol extensions are rejected or stripped. LiveKit data publication and client metadata updates are disabled; application chat uses its authenticated HTTP/SSE path.
5. Before forwarding `AddTrack`, a synchronous ledger requires a current domain permission/reservation and enforces one microphone, screen video, and associated screen-audio publication per account, with at most three screen videos in the room. Screen audio does not consume another video slot. A source/type mismatch is refused. Extra codec requests must reference a known server track SID.
6. Reconnect sync state may reference only known, confirmed publication CID/SID/source tuples. A signal disconnect alone does not release a track slot, because media may survive a signaling interruption.

The application uses distinct opaque media identities per device admission. Account identity remains authoritative for moderation and publication limits; participant names and client metadata are never authority.

Each bridge permits at most 120 non-ICE control messages and 1,000 ICE candidates per 10 seconds. Initial and client-processing queues are bounded to 256 messages and 1 MiB of encoded payload; server responses are bounded to 64 queued processing tasks. Payloads above 512 KiB are rejected, and either forwarding destination exceeding 1 MiB buffered is disconnected. Native WebRTC on multi-interface Windows hosts produces large valid ICE bursts, so a shared low command/ICE budget would cause unnecessary reconnects. A positive ICE-burst check and a negative control-flood check exercise the separate budgets. These limits are separate from media bitrate and application chat limits.

## Revocation, handoff, and cleanup

The domain commits a deny state before it asks the media adapter to remove a source. The adapter serializes effects. It first removes invalid participants and intersects every existing participant's source permissions with the current policy. It queries the SFU to confirm disallowed tracks are gone before broadening any permission for a new publisher. If confirmation fails, the operation remains denied; it does not enable a replacement publisher or silently release a screen slot.

A microphone-only restriction preserves permitted screen sources. A one-time mute invokes `MutePublishedTrack` only for microphone tracks. The adapter never remotely unmutes someone.

An unpublished track is released after an explicit server unpublish response, current SFU metadata confirming its absence, confirmed source revocation, or confirmed participant removal. Each bridge tracks the last accepted self participant SID/version; lower-version snapshots for that SID cannot remove current leases. A self update that omits a published track triggers one deduplicated current-metadata request off the signaling response chain. The observation waits at most one second; failures, timeouts, older metadata, and changed SID/source/reservation matches preserve the current lease. An outstanding request stays deduplicated until it settles. This avoids turning a stale or early participant snapshot into domain-level share revocation while allowing publication acknowledgements and ICE to continue.

A failed pending publication is not silently expired out of the ledger: after 30 seconds the gateway removes the participant from the SFU before releasing its pending entries. When a remove request races with an already disconnected participant and the SFU returns unavailable/not-found, an independent participant listing must confirm absence before cleanup is treated as complete.

The adapter exposes `hasScreen(identity, roomName)` so the HTTP confirmation route can require actual SFU screen presence rather than accepting a client's claim. A stopped-publication callback carries the original share reservation ID; the domain cleanup must match that ID so a delayed old unpublish event cannot clear a new reservation. Domain cleanup is queued without awaiting it inside a serialized media effect.

Ending a room deletes it through the server API and closes its gateway connections. Startup reconciliation belongs to the domain/application and closes prior live instances before admitting anyone. During an application process outage, established WebRTC media may continue on a separately running SFU until that SFU or a supervisor stops it; JWT expiry alone does not disconnect it. This is an explicit operational boundary, not a claim of instantaneous shutdown during an application crash.

The isolated application-only crash test now demonstrates this boundary with real synthetic RTP: media survives the killed fixture app, a failed DeleteRoom leaves cleanup pending and reopening denied, and maintenance disconnects the prior peers before a fresh explicit session can open. See [verification](verification.md). This is proof of the listed loopback test path, not immediate termination during all outages.

## Network and version boundary

The initial desktop configuration binds direct SFU signaling `7880/TCP`, ICE TCP `7881/TCP`, and the configured UDP mux `7882/UDP` to host loopback. Only local development is enabled. WAN exposure is deferred. In a later public deployment, the application gateway must remain the **exclusive** signaling ingress; the direct SFU API/signaling port must remain unreachable by participants. Exposing that endpoint would bypass the application's admission and count enforcement. The media ports need a separately verified path.

The gateway deliberately supports the classic `/rtc` signaling protocol only. `/rtc/v1` and `/rtc/v1/validate` return 404 so the pinned official SDKs use their classic-protocol fallback. This prevents a compressed `join_request` carrying an opaque initial publisher offer from bypassing inspection. Both the native synthetic client and browser client fallback must be checked when SDK versions change. The real local test observed the native client fall back from `/rtc/v1` to `/rtc` successfully.

The publication ledger is intentionally single-process. The supported initial/cloud deployment is one application process and one authoritative domain/database instance. Multiple gateway instances or load-balanced signaling require a shared atomic ledger and equivalent coordination before they are supported. No such distributed guarantee is claimed.

## Tests

Run policy and loopback WebSocket checks:

```powershell
npm run test:media
```

Run the actual local SFU acceptance test after starting the pinned LiveKit container:

```powershell
$env:RUN_LIVEKIT_INTEGRATION = '1'
npx tsx --test tests/media-livekit.test.ts
Remove-Item Env:RUN_LIVEKIT_INTEGRATION
```

The real test creates an isolated random room, uses synthetic 160x90 video and generated audio including a non-silent screen-audio signal, and removes its room afterward. It uses no camera, microphone, screen-capture picker, Discord account, or remote service. Its auth callback is a fixture; production session/device binding and real Discord verification are tested separately by the application. Running it does not establish Discord, WAN, browser capture, mobile, or capacity acceptance.

## Acceptance boundary

See [verification](verification.md) for the current checkpoint. Local synthetic checks cover publication counts, permission changes, restart reconciliation, reconnects and screen-audio cleanup. A regular Chrome trial also exercised native tab capture with audio and Stop sharing. These results do not establish every modified-client sequence or every device/network combination.

Physical microphone, real second-member moderation, three native screen captures, phone support, public HTTPS/ICE/TURN and sustained 10–15-person capacity require separate acceptance. Source declarations describe track permissions, not the semantic content of encoded audio. During an application outage, established media may continue until the SFU or supervisor stops it.

## Official references

- [LiveKit token lifecycle and self-hosted revocation](https://docs.livekit.io/frontends/reference/tokens-grants/)
- [LiveKit signaling protocol](https://github.com/livekit/protocol/blob/main/protobufs/livekit_rtc.proto)
- [Official JavaScript signaling implementation](https://github.com/livekit/client-sdk-js/blob/main/src/api/SignalClient.ts)
- [LiveKit participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/)
- [Node synthetic test SDK](https://docs.livekit.io/reference/client-sdk-node/)
