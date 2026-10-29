# Separate frontend and backend projects

Run the commands below from the cloned repository root.

```text
private-stage/
├── frontend/       Next.js, React Query, shadcn UI, browser media
├── backend/        Fastify, Discord authentication, room policy, media gateway
├── shared/         Common types and room-mode contract
├── scripts/        Desktop setup, supervision, backup and restore
├── deploy/         Self-hosted LiveKit configuration
├── data/           Existing private SQLite databases
├── backups/        Existing protected backups
└── .env           Existing private backend configuration
```

The root npm workspace manages one lockfile. Each project has its own `package.json`, TypeScript configuration and commands. Install with `npm ci` from the root. The root `npm run build` builds the Next.js frontend and the bundled Node backend; the backend bundle includes the shared source needed at runtime. Root tests cover both projects and their integration.

## Existing desktop operation

The normal `scripts/Start-Local.ps1` launcher and root `npm run dev` retain the complete app at `http://localhost:3210/`. Fastify serves the frontend project in this local mode. The registered current-user startup task, root `.env`, database directory, media configuration, backup layout and local Discord callback stay in place. No real account migration or new credentials are required for this reorganization.

## Run the projects separately

Stop the combined desktop app first, then bring its media service back up:

```powershell
.\scripts\Stop-Local.ps1
docker compose -f deploy/compose.local.yml up -d livekit
```

From the project root, start the API in one PowerShell terminal:

```powershell
$env:FRONTEND_URL = 'http://localhost:3211'
npm run dev:backend
```

In another terminal, start the frontend:

```powershell
$env:NEXT_PUBLIC_API_URL = 'http://localhost:3210'
npm run dev:frontend
```

The API-only command uses the backend's `--api-only` mode. Both modes must not run independent writers against the same SQLite files. These commands use the existing backend environment and account configuration. For fictional testing, use isolated data and loopback preview settings instead of modifying the actual databases. To return to the desktop launcher, stop both separate processes and clear the temporary `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` variables in their respective terminals before running `Start-Local.ps1`.

Build one project with `npm run build:frontend` or `npm run build:backend`. After building, `npm start --workspace frontend` serves the standalone frontend on port 3211, while `npm start --workspace backend` runs the compiled API-only backend. `NEXT_PUBLIC_API_URL` is included at frontend build time and must be set before a separately hosted frontend is built.

## Vercel frontend and cloud backend

Use the frontend project as Vercel's Root Directory and install from the npm workspace. Shared files outside that directory must remain available to the build; retain the repository/workspace and enable Vercel's outside-root source support where required. Backend and shared source can stay in the same repository without being deployed as Vercel API routes.

For example, configure the public frontend origin as `https://app.example.com` and the API origin as `https://api.example.com`:

| Location | Setting |
| --- | --- |
| Frontend build | `NEXT_PUBLIC_API_URL=https://api.example.com` |
| Backend | `APP_URL=https://api.example.com` |
| Backend | `FRONTEND_URL=https://app.example.com` |
| Discord developer application | Redirect URI `https://api.example.com/api/auth/discord/callback` |

Only the public API origin belongs in the frontend environment. Discord secrets, cookie/encryption keys, LiveKit API secrets and database paths stay on the backend. Use trusted HTTPS subdomains under the same parent domain with host-only backend cookies; unrelated frontend/backend sites introduce third-party cookie restrictions. The backend permits credentialed API requests only from its configured frontend origin, including explicit preflights and live-event credentials. WebSocket admission still checks the frontend Origin, encrypted session and device admission.

HTML security headers and fresh script nonces belong to the frontend's `proxy.ts`, so they are present on both independently served Next.js pages and the combined local app. The backend retains API/authentication controls. Its Discord callback stays on the API host, then redirects to the configured frontend; media-token responses point to the backend's authenticated WebSocket gateway.

SQLite needs persistent storage and one authoritative backend instance. Self-hosted LiveKit's raw signaling/API endpoint must remain private behind that gateway; its public WebRTC media ports and TURN path require separate network configuration. Frontend hosting does not carry WebRTC media or remove the need for an available backend/media host.

This change prepares the projects and origin handling. Cloud accounts, DNS, HTTPS ingress, external media reachability and real Discord cross-host acceptance still require deployment verification. Physical microphone, reboot and second-user checks remain deferred.
