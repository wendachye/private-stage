# Private Stage

A private, single-room session app for members of one Discord server, with waiting and live phases, chat, moderated microphones and screen sharing with optional audio.

## Projects

| Folder | Responsibility |
| --- | --- |
| `frontend/` | Next.js, React, shadcn/ui and TanStack React Query |
| `backend/` | Fastify, Discord OAuth, SQLite, room policy and authenticated LiveKit signaling |
| `shared/` | Shared types and speaking-mode contract |
| `scripts/` | Windows startup, supervision, backup and restore |
| `deploy/` | Local LiveKit and production deployment templates |
| `tests/` | Domain, authentication, browser-state, media and operations checks |

The npm workspace uses one root lockfile. Clone the complete repository even when deploying only the frontend. The backend requires persistent SQLite storage and one authoritative application instance. Media runs on self-hosted LiveKit.

## Run locally

Install Node.js **24.18.0 or newer within 24.x**, npm and Docker Desktop with its Linux engine running. In PowerShell, from the repository root:

```powershell
npm ci
npm run setup
.\scripts\Start-Local.ps1
```

Open [http://localhost:3210](http://localhost:3210). Setup creates unique keys in an ignored `.env` and writes an ignored matching `deploy/livekit.local.yaml`. Existing configuration is retained. A fresh installation enables fictional preview identities only on loopback; configure [Discord login](docs/discord-setup.md) and disable preview before real use.

The default listeners are local to this computer. Setup does not change router rules, Windows firewall rules or public DNS.

An admin selects **Open session** and joins automatically with the microphone off. The session starts in **Waiting**; choose **Go live** when ready. Everyone can talk is the default. Admins can switch to Stage only or Moderated Q&A in either phase. Each participant chooses when to unmute. Screen sharing requires stage approval. See [session behavior](docs/waiting-room.md).

## Separate hosting

The frontend can run on Vercel while the backend and LiveKit run on a reachable PC or Linux server. A cloud server is optional. The backend needs trusted HTTPS/WSS and a complete public WebRTC media path; a domain or HTTP tunnel alone does not provide that path.

For the current cookie-based login, use related HTTPS hostnames such as `app.example.com` for Vercel and `api.example.com` for the backend. Only `NEXT_PUBLIC_API_URL` belongs in the frontend environment. Discord secrets, session/encryption keys, LiveKit secrets and databases belong on the backend.

See [deployment](docs/deployment.md) for Vercel, the backend Docker image, TLS ingress and persistent storage. [Split hosting](docs/split-hosting.md) covers independent development commands. [Migration](docs/cloud-migration.md) explains moving existing private data without running two writers.

For temporary relays without related frontend/backend domains, see [same-origin desktop hosting](docs/temporary-desktop-hosting.md). This mode uses a server-only gateway credential on Vercel; Discord, session/encryption and SFU secrets stay on the backend.

## Stop, backup and restore

```powershell
.\scripts\Stop-Local.ps1
.\scripts\Backup-Local.ps1
.\scripts\Verify-LocalRestore.ps1 -BackupPath 'C:\path\to\a\private-stage-backup'
.\scripts\Start-Local.ps1
```

The verification command restores into an isolated copy. Real restoration replaces local state and requires the stopped-state procedure in [operations](docs/operations.md). Keep both databases and their matching keys in a protected backup. Backups contain credentials and must remain private.

## Build and verify

```powershell
npm run build
npm run typecheck
npm test
```

Use `npm run build:frontend` or `npm run build:backend` for one project. Root `npm run dev` serves the combined desktop app; workspace start commands support independent hosting.

Production and real-SFU checks are opt-in. See [verification](docs/verification.md) for commands, tested scope and remaining acceptance. Physical microphone and Windows reboot checks remain deferred; the real second-user trial remains last. Local tests do not establish public networking, phone support or 10–15-person capacity.

## Configuration and source control

Commit example configuration only. Private `.env` files, keys, databases, backups, logs, generated LiveKit configuration, dependencies, build outputs and local browser evidence are ignored. Docker builds also exclude private state.

- [Discord setup](docs/discord-setup.md)
- [Permissions and retention](docs/policy.md)
- [Media enforcement](docs/media-enforcement.md)
- [Operations and recovery](docs/operations.md)
- [Later features](docs/roadmap.md)
