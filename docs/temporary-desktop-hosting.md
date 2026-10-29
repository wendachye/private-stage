# Temporary Docker backend with a Vercel frontend

The backend, SQLite and self-hosted LiveKit can stay on a desktop behind upstream NAT while public HTTP and UDP relays provide a temporary test route. The browser uses the Vercel frontend origin for API calls, Discord callbacks and authenticated signaling. This keeps the existing secure, host-only SameSite=Lax cookie usable without cross-site cookie exceptions.

## Vercel settings

Keep the frontend Root Directory and shared-source configuration described in [deployment](deployment.md). For the same-origin gateway mode, configure these environment variables on the frontend's **Production** environment:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | The frontend HTTPS origin, or an empty value for relative requests |
| `BACKEND_ORIGIN` | The temporary backend tunnel's plain HTTPS origin |
| `BACKEND_PROXY_SECRET` | The private shared gateway credential, at least 32 printable non-space characters |

The last two variables are server-only. Never prefix the proxy secret with `NEXT_PUBLIC_`. Keep Discord client secrets, session/encryption keys and LiveKit API secrets on the desktop backend. Import private environment files locally; do not commit them or paste their contents into chat.

The frontend proxies HTTP API, validation and health paths. The exact `/rtc` path uses a dedicated Node.js Vercel Function with the documented WebSocket upgrade API, because an external HTTP rewrite does not preserve its upgrade. That function opens the authenticated backend connection before accepting the browser, preserves binary/text messages and the original Cookie/Origin, and bounds pending messages and buffers. It requests a reconnect before the function's 300-second deadline. Durable room policy and publication accounting remain on the desktop backend.

The frontend supplies the private gateway header, replaces caller-supplied values and disables HTTP caching. The local gateway verifies that header, removes it before the API and sets the backend's configured public Host. HTML retains its independent request-specific CSP nonce. The gateway credential never belongs in browser code.

With `https://frontend.example.com` as the browser origin, configure backend `APP_URL` and `FRONTEND_URL` to that same origin. Register this Discord OAuth redirect:

```text
https://frontend.example.com/api/auth/discord/callback
```

Use the real frontend hostname. The callback remains stable when a temporary backend tunnel changes. Changes to `BACKEND_ORIGIN` require a new frontend deployment. Unrelated preview deployments are not automatically authorized.

## Media and private storage

The SFU's raw signaling/API port remains Docker-private. One managed backend owns a persistent SQLite volume; its container entrypoint holds an exclusive OS lock. Stop the native writer and take a consistent protected backup before restoring database files into that volume. Exclude desktop process locks/control records, retain matching keys and pause the native login launcher while Docker is authoritative.

A UDP relay can allocate a public port different from its local target. LiveKit must advertise the assigned public relay IP and UDP port. The [UDP forwarder](../deploy/udp-forwarder.mjs) forwards the fixed local tunnel target to that SFU port and preserves each peer's return path. Keep the SFU on an internal Docker network; use a dual-network forwarder so same-PC clients cannot silently bypass the public relay during verification. Configure `UDP_LISTEN_HOST=0.0.0.0` inside its container.

The temporary route was tested with isolated synthetic media: decoded video/audio, matching selected ICE pairs and a pause/resume check that stopped received media bytes while only the UDP relay was paused. This is separate from a real second-member trial, physical microphones, restrictive networks, phones and room capacity.

## Temporary service limits

Pinggy's free HTTP and UDP tunnels expire after about 60 minutes. Their URLs and UDP allocations change on reconnect. The server-side proxy supplies Pinggy's documented screening header; a browser calling the free tunnel directly may receive an interstitial instead of API JSON. Coordinate allocation changes with the LiveKit configuration and Vercel environment, rather than blindly restarting an expired relay.

Every deployment still needs acceptance for authenticated WebSocket Upgrade, sustained SSE and media after reconnect. A public web/media path does not establish TURN connectivity or sustained 10–15-person capacity. Physical microphone, reboot and the final second-user checks retain their separate scope.

Official references: [Pinggy Docker and UDP](https://pinggy.io/docs/docker/), [screening behavior](https://pinggy.io/docs/http_tunnels/screening/), [Vercel rewrites](https://vercel.com/docs/routing/rewrites), [WebSocket lifecycle](https://vercel.com/docs/functions/websockets), [LiveKit ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/).
