# Desktop first, cloud later

The application can run first on a Windows desktop. A later cloud host is intended, but no provider, paid account, public relay, or cloud resource has been selected or provisioned. Public ingress is deferred until the user is ready for remote testing.

The [free-hosting research dated 29 October 2026](free-cloud-research-2026-10-29.md) compares current ongoing allowances, trial credits and deployment fit. Oracle Always Free A1 is the leading full-stack candidate to evaluate; availability, exact account entitlement and representative media capacity remain unverified. The research does not select or provision a provider.

## Portable boundaries

- `APP_URL`, app binding/port, media endpoint, API keys, Discord IDs/secrets, and membership policy settings are environment configuration.
- SQLite files live under `DATA_DIR`; generated keys and `.env` must accompany a protected backup.
- The frontend and backend are separate npm projects. The desktop launcher combines them in one Node process; independent frontend hosting uses a configured backend API origin. Fastify's SSE/WebSocket and local coordination still require a long-lived VM/container service. See [split hosting](split-hosting.md).
- SQLite coordination currently supports one API instance. Scaling to multiple app instances requires a shared transactional/coordination design and new race/failover tests, rather than simply increasing replica count.
- Self-hosted LiveKit remains the default. Moving to a cloud VM does not imply adopting the separately operated LiveKit Cloud service.

## Before selecting a host

Measure the representative room workload first: three screen tracks, actual subscription/preview settings, audio, encryption/packet processing, and 10–15 participants. Select the region and resources using measured sustained CPU, memory, bandwidth, and participant network paths. Do not infer capacity from the desktop's brief speed sample or generic benchmark hardware.

Check current provider bandwidth allowance/egress charges, public IPv4 availability, UDP/TCP/TURN support, persistent disk and backup facilities, process supervision, and TLS/DNS support. Present verified costs and obtain authorization before using paid infrastructure. No cost or capacity guarantee is established in this document.

## Closed-session cutover

1. Complete and verify a stopped-state backup/restore rehearsal locally.
2. Prepare the new host with pinned compatible app/media versions and persistent storage. Keep raw media signaling/management/database access private behind the required policy boundary.
3. Configure trusted HTTPS and the complete ICE/TURN media path, accounting for port 443 conflicts and UDP routing.
4. Explicitly end the desktop session and stop app writers. Back up both databases and matching configuration/keys.
5. Restore the data to the new host. Keep preview disabled, retain the owner identity and role mapping, and check schedules, bans, and audit retention.
6. Update app/media/TURN origins, DNS, secure-cookie expectations, and exact Discord callback registration. Use a maintenance window; active calls are not migrated invisibly.
7. Start closed, reconcile any old media identity, verify health and real Discord membership, and test fresh authorized admission. Old links and stale credentials must not reopen a prior instance.
8. Run real external and phone trials, then the target room/capacity test. Inspect the policy gateway bypass cases again under the new proxy/network topology.
9. Retire desktop public ingress only after the cloud verification succeeds. Preserve an agreed rollback backup; do not run two writable copies of the same logical room.

Rollback means closing the cloud session and restoring the chosen consistent state, not allowing both environments to accept independent writes. Any signing-key rotation or database divergence needs an explicit plan.

## Current home-network constraint

Home Internet may place the router behind upstream IPv4 NAT/CGNAT. A domain alone does not create a media path through it. A reachable public IPv4 or a suitable complete relay/ingress design may be required. IPv6 assignment does not prove accessibility for every participant.

Official references: [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/), [firewall ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [benchmarks and load testing](https://docs.livekit.io/transport/self-hosting/benchmark/), and [Windows/WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking).
