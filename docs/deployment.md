# Separate frontend and backend deployment

The frontend can run on Vercel while one backend process, persistent SQLite and self-hosted LiveKit run on a Linux host. The same split can use this desktop as the backend after its secure public network path is configured. These templates prepare that deployment; no DNS, router, cloud account, certificates or public listeners have been configured by creating them.

## Addresses and trust boundary

Use HTTPS sibling domains, for example `app.example.com` on Vercel and `api.example.com` on the backend host. Set frontend `NEXT_PUBLIC_API_URL=https://api.example.com`, backend `APP_URL=https://api.example.com`, and backend `FRONTEND_URL=https://app.example.com`. Set `API_DOMAIN=api.example.com` for Caddy. Replace the examples with your own domain.

The frontend sends credentialed HTTP/SSE requests and connects to the authenticated backend `/rtc` WebSocket gateway. The backend keeps secure, HttpOnly, host-only `SameSite=Lax` cookies. Sibling HTTPS domains are different origins but the same site; exact CORS and Origin checks remain necessary. Unrelated `vercel.app` and backend domains introduce cross-site cookie restrictions, so use the configured custom frontend domain for real sign-in. Preview deployments are not automatically allowlisted. Never expose backend credentials through a `NEXT_PUBLIC_` variable. See [browser cookie rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value).

The direct LiveKit signaling/API endpoint **7880 stays private** on a Docker network. Only Fastify may access it. Caddy forwards the allowed application paths to Fastify; it never forwards clients to raw LiveKit. Public media uses ICE TCP 7881 and UDP mux 7882. This preserves the application's admission, moderation and three-screen gateway enforcement. See [media enforcement](media-enforcement.md) and [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

## Vercel frontend setup

Import the GitHub repository into Vercel, select the Next.js framework and set **Root Directory** to `frontend`. Enable **Include source files outside of the Root Directory in the Build Step** so the shared workspace is available. Select **Node.js 24.x**. The committed `frontend/vercel.json` runs the install from the repository root (`cd .. && npm ci`) and builds the frontend workspace with `npm run build`.

Set only the public frontend value `NEXT_PUBLIC_API_URL=https://api.example.com` for the intended deployment environment, then deploy and attach the custom frontend hostname `app.example.com`. Configure the backend's exact `FRONTEND_URL` to that HTTPS origin before testing sign-in. A change to `NEXT_PUBLIC_API_URL` requires a new frontend build. Keep Discord credentials, session keys, encryption keys and LiveKit secrets exclusively on the backend. Random Vercel preview origins are not allowed by the configured backend; test the configured custom hostname or deliberately provision a separate isolated backend and exact frontend origin.

## Files and configuration

Run commands from the repository root. On the intended Linux host, privately copy:

```sh
umask 077
cp deploy/.env.production.example deploy/.env.production
cp deploy/livekit.production.example.yaml deploy/livekit.production.yaml
cp deploy/Caddyfile.example deploy/Caddyfile
```

Fill every `REPLACE_` field in the private copies. Supply the Discord application's client ID/secret, community server ID, owner ID and optional admin-role IDs. Register exactly `https://api.example.com/api/auth/discord/callback` in Discord. OAuth completes at the backend, then returns to the configured frontend.

For a fresh installation, create distinct session/encryption keys as 64 hexadecimal characters and a strong LiveKit API secret of at least 32 characters, privately on the host. The LiveKit key/secret must match in `.env.production` and `livekit.production.yaml`. For an existing-data migration, retain the matching session/encryption keys from the protected backup; replacing the encryption key prevents existing token records from decrypting. Never paste keys into chat or commit the private files.

Compose interpolates only explicit settings into the backend. Caddy receives only its public hostname/contact configuration; LiveKit reads its separate private YAML. Containers do not receive the desktop `.env`. The image builds the API bundle from the repository root and runs `node backend/dist/index.js --api-only` as the non-root `node` user. It includes API dependencies and workspace manifests, not frontend code/assets or private data.

The named `stage_data` volume holds both SQLite databases and process-lock files at `/var/lib/private-stage`. Keep **one backend replica**; the publication ledger and SQLite coordination are single-instance. Do not run a desktop writer and a cloud writer as independent copies of the same logical room. The backend image's health check supplies the configured public Host header through `node:http` to its internal HTTP probe.

The container entrypoint holds a nonblocking Linux `flock` across the Node process for this dedicated managed volume. A second container using the entrypoint exits with code 73 before touching the application lock or SQLite. Once that exclusive guard is held, the entrypoint removes the container's old PID lock/recovery claim; container PID reuse therefore cannot block recovery after a crash. The `container.lock` inode must never be deleted or replaced. Every writer of the volume must use this guard. Do not mount an active desktop data directory, bypass the entrypoint, or use storage without working local advisory locks.

## Validate and launch when ready

The example env can check Compose syntax without using private values:

```sh
docker compose --env-file deploy/.env.production.example -f deploy/compose.production.yml config --quiet
docker build -f deploy/backend.Dockerfile -t private-stage-backend:local .
node deploy/check-backend-container.mjs --run --image private-stage-backend:local
```

`.dockerignore` must exclude `.env` files, local LiveKit keys, databases, backups, logs and work artifacts before a remote build. The example files contain placeholders and must not be launched unchanged. The opt-in container check uses only fictional keys, a fresh labelled volume, no network and no published ports. It checks health, API security headers, concurrent writer refusal, SIGKILL/restart recovery and graceful shutdown, then removes only its own labelled resources.

After completing the private configuration, DNS, firewall and migration checks:

```sh
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --build
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps
```

Backend and Caddy containers have no public management/API port mappings other than Caddy's 80/443. Open only the necessary public web/media ports in both host and provider firewalls. Never add `7880:7880` or a Caddy route to `livekit:7880`. Keep media DNS records direct to the host unless a provider explicitly supports the required WebRTC transports. An ordinary HTTP/CDN proxy is not a UDP media relay. The Caddy image is pinned to the tested v2.11.7 digest; review image updates deliberately before future cutovers.

Caddy preserves the public API Host and incoming Origin/cookie headers, upgrades WebSockets, and immediately flushes SSE responses by content type. No finite stream timeout or negative flush interval is added. Runtime logs filter media tokens, OAuth query values and cookie/authorization headers; access logging is not enabled. See [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [log filters](https://caddyserver.com/docs/caddyfile/directives/log#filter).

The application currently uses `trustProxy:false`. Behind Caddy, anonymous HTTP rate limits therefore share Caddy's upstream IP, while authenticated limits use each signed session ID. Do not enable unrestricted forwarded-header trust as a workaround; any future trusted-proxy configuration needs an explicit proxy boundary and tests.

This baseline has no TURN relay. Restrictive client networks may require TURN/TLS. Caddy already uses TCP 443, so plan a separate address/listener or verified layer-4 topology and certificate before enabling TURN. HTTPS alone does not establish a complete media path. See [LiveKit deployment and TURN](https://docs.livekit.io/transport/self-hosting/deployment/).

## Keeping the backend on this PC

Vercel can host the interface while this PC stays authoritative for API, SQLite and media. The PC then needs to remain awake, maintain its services and have stable public DNS, trusted HTTPS, and reachable media transports. A dynamic public IP can use updated DNS; a domain name does not remove upstream NAT.

If the home connection uses CGNAT, direct router port forwarding alone cannot bypass it. Options include suitable ISP public addressing, a carefully tested complete relay/VPN ingress path that supports the necessary media, or moving the backend/media host to a reachable VM. A web-only tunnel can expose HTTP/WSS without delivering LiveKit UDP. Actual reachability, TLS, router/firewall changes and TURN remain separate setup work.

The current desktop services bind to loopback and are not made public by these templates. Docker Desktop/WSL forwarding must also be verified on Windows. Treat using production containers on this PC as a cutover: the existing local LiveKit uses the same media ports, and both stacks must not be started blindly together. Microphone, physical reboot and second-user acceptance remain deferred according to the current project scope.

## Data migration and acceptance

End the session, stop all SQLite writers, and take a consistent protected backup of the complete data directory plus matching private configuration/keys. Preserve that archive and an isolated rollback copy; do not overwrite the desktop data during preparation. For the new managed container volume, restore the application databases and any required SQLite companion files from that consistent backup, with ownership for container UID 1000. Do not import desktop `app.lock`, recovery claims, `container.lock` or desktop process/control records. A source-code push or container image does not include the private database. The Windows backup helpers target the local project layout; container-volume backup/restore needs its own stopped-writer procedure and rehearsal. See [migration](cloud-migration.md) and [operations](operations.md).

After setup, verify closed-room startup, Discord membership/owner access, credentialed API/SSE, WebSocket reconnection, raw-signaling inaccessibility, media stop/revoke behavior and real external/phone connectivity. Then measure the intended room and three shares. A Docker build or Compose parse does not prove live DNS/TLS, ingress, media capacity, reboot recovery or the final second-user test.
