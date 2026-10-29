# Local operations and deployment checkpoints

## Local startup

Run PowerShell from the project directory:

```powershell
npm ci
npm run setup
.\scripts\Start-Local.ps1
```

Docker Desktop must be running with the Linux engine. The default app is **http://localhost:3210** and binds to `127.0.0.1`. Start the local media service manually if needed:

```powershell
docker compose -f deploy/compose.local.yml up -d
npm run dev
```

The desktop launcher uses the combined Node server for the frontend, authentication, API routes, SSE and WebSocket policy gateway. Independent frontend hosting uses the separately running API described in [split hosting](split-hosting.md). A production build uses `npm run build`, which selects the verified Webpack compiler without an extra flag. The earlier Turbopack CSS worker IPC failure is avoided by that compiler choice, not marked repaired. Follow the verified package scripts for start mode after deployment configuration is finalized.

## Windows login startup

```powershell
.\scripts\Register-DesktopStartup.ps1
.\scripts\Get-DesktopStartup.ps1
```

Registration installs a hidden, current-user task with Limited rights. It uses the installed system Windows PowerShell, stores no password, and runs when that user signs in. The launcher starts Docker Desktop if needed, waits up to 180 seconds for its Linux engine, then runs the supervised local launcher without opening a browser or room. Startup failures have at most three Task Scheduler retries one minute apart; an individual task attempt is capped at ten minutes. The application supervisor retains its separate three-crash retry limit.

`Start-Desktop.ps1` exercises the same launcher manually. The login task and launcher reject overlapping attempts, and the local supervisor continues to reject duplicate app writers. `Get-DesktopStartup.ps1` verifies the registered XML principal, user-scoped logon trigger and exact project action before reporting status. Windows may shorten a CIM account display name, so that display name alone is never proof of task ownership. The underlying user-scoped trigger follows Microsoft's [LogonTrigger user binding](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger-userid).

`logs\desktop-startup.json` records the last controlled result. `desktop-startup.log` retains up to three 256 KiB files. A successful launcher task finishes with result 0 while the supervised app keeps running. The task depends on this user signing in; a physical reboot/sign-in still needs its own acceptance check.

To remove this project's login startup, run `Unregister-DesktopStartup.ps1`. Registration and removal refuse unrelated task definitions. Check that no startup attempt is running before backup/restore; the stopped-state guard also refuses an active desktop-startup lock. Pause/remove login startup during extended maintenance so a future login or scheduled retry cannot start a writer unexpectedly.

## Stop and health

```powershell
.\scripts\Stop-Local.ps1
Invoke-RestMethod http://localhost:3210/healthz
docker compose -f deploy/compose.local.yml ps
docker compose -f deploy/compose.local.yml logs --tail 100 livekit
```

Run health queries while the application is running; connection refusal after stopping is expected. Authenticated admins can inspect `/api/admin/health`. Public `/healthz` reports app liveness, not Discord verification, usable media, or Internet reachability.

Startup checks the existing health endpoint and listening port before launching. A process lock additionally prevents another instance from reconciling the same database before it can listen. Recovery of a dead lock is serialized. If a lock or recovery claim is unreadable, verify the recorded process is stopped before manually recovering that specific file; never remove an active instance's lock to force a second start. Graceful shutdown drains event streams/media connections before HTTP shutdown.

`Start-Local.ps1` launches a hidden, project-scoped Node supervisor. The supervisor captures both app output streams into bounded logs. An unexpected nonzero exit receives at most three retries, after 1, 2, and 4 seconds. A clean exit stays stopped. Retries do not open a session: the existing startup reconciliation closes the prior instance and gates admission until surviving media cleanup succeeds. After the retry limit, inspect `logs\app.error.log`, repair the cause, and explicitly run Start again. This is process supervision; it does not restart an app that is still running but unhealthy.

`Stop-Local.ps1` verifies the recorded process command path and supervisor ownership before writing a token-bound local stop request. The supervisor cancels any pending retry and asks its child to drain through IPC. It allows 10 seconds, then terminates only that owned child and records a failed shutdown. Stop waits for the supervisor and stops this project's LiveKit container; a shutdown error is reported even after the processes stop. IPC loss when the supervisor exits also asks the application child to shut down. Direct `npm run dev` processes remain manually controlled with Ctrl+C.

`data\supervisor.json` records process IDs, status, retry count, and last update time without credentials. Its lock prevents duplicate supervisors. Backup/restore refuses an active supervisor even between child restarts, and process/control records are excluded from new backups and restores. An unreadable lock or abandoned recovery claim requires operator inspection before recovery; never clear a live lock. Old script-launched instances can be stopped with the legacy app-PID path check.

Always explicitly end a live session before a planned stop. A restart also defaults closed and reconciles old media, but a process crash is not equivalent to an acknowledged session-end action. If cleanup fails, keep new admissions closed, inspect service health, and retry cleanup. Do not mark the previous media room closed just because its database state changed.

## Backup and restoration

```powershell
.\scripts\Stop-Local.ps1
.\scripts\Backup-Local.ps1
.\scripts\Verify-LocalRestore.ps1 -BackupPath 'C:\path\to\a\private-stage-backup'
.\scripts\Restore-Local.ps1 -BackupPath 'C:\path\to\a\private-stage-backup'
.\scripts\Start-Local.ps1
```

Stop all app writers before copying SQLite databases. A consistent backup needs the stage and auth data plus the matching `.env`/encryption keys and generated media configuration. Live filesystem copies of only a main SQLite file can miss WAL transactions. Use the supplied stopped-service backup procedure, inspect its printed destination, and verify a restoration into an isolated local project before relying on it.

Backups contain private account data, moderation records, and credentials. Keep them in access-controlled storage, exclude them from source control, and set an operator retention/deletion policy. Restore to an empty/stopped target using the script's path validation. Restoring is an intentional replacement of local state; preserve a current backup first. Do not send backup archives through chat.

New backups receive a protected ACL granting only the current Windows user, SYSTEM and Administrators before private files are copied. The helper loads the built-in security module matching the running PowerShell version. `Verify-LocalRestore.ps1` restores only into a fresh protected `work\restore-drills\<id>\project` copy. Its low-level verifier enforces that scratch location too. It checks restored bytes, SQLite integrity and foreign keys, matching-key token decryption, retained schedules/admin settings/bans, excluded process-control files and closed-room startup. It makes no Discord or media-service requests and retains the ignored private copy for inspection. A successful rehearsal does not require subsequently running the real `Restore-Local.ps1`; real restore is for an intended replacement of local state.

For an actual recovery, stop the app and run `Restore-Local.ps1 -BackupPath '<selected backup>'`, then start it again. That command creates a pre-restore backup and retains a rollback directory before replacing state. Confirm the room is closed, schedules/admin mappings/bans remain correct, old media credentials do not regain admission, and real accounts can authenticate. Re-authentication may be needed when keys or Discord consent changed.

The supplied Windows scripts were exercised against isolated SQLite fixtures, including stale WAL/SHM sidecars, prebackup and rollback preservation, live locks, occupied ports, mismatched data paths, and source/target overlap. They require `DATA_DIR` inside the local project and outside its backup directory. A stopped-service backup of the real local account data also passed an isolated restore rehearsal. Physical reboot and power-loss drills remain separate acceptance checks. Restore moves the old data directory to a validated rollback location and copies the selected backup into a fresh directory; it does not merge stale sidecars into restored files.

## Logs and resources

- Docker media logs are bounded to three 10 MB files by `deploy/compose.local.yml`.
- Application request logging omits cookie/authorization headers and query strings. OAuth/media tokens and message bodies must not be added to logs.
- Supervised app stdout uses `logs\app.log`; stderr and supervisor diagnostics use `logs\app.error.log`. Each stream retains the current file plus `.1` and `.2`, each at most 10 MiB: up to 60 MiB across the two streams. Rotation handles oversized output chunks and continues across starts. Failure to write logs/control state stops the owned child instead of silently running without supervision.
- `logs\supervisor-startup.error.log` contains launcher failures before normal logging initializes and is replaced on the next launch. Earlier timestamped `app-*.log` files are preserved; archive/delete them manually if desired. Their existing size is outside the new rotating-file limit.
- The inspected PC already had automatic sleep on AC disabled. No Windows power settings were changed by this build. Confirm the setting again before a real session.
- Docker's `unless-stopped` policy can restart the media container after Docker starts. It does not prove the app starts after a Windows reboot or that Docker Desktop starts unattended.
- A current-user Windows login task is supported and must be registered explicitly on each desktop. The real-account backup/restore rehearsal passed using an isolated copy. A full Windows reboot/sign-in trial and fresh Docker Desktop engine launch remain physical acceptance checks; the manual app/container startup rehearsal is recorded separately. No power settings, global execution policy or network exposure were changed.

## Localhost, LAN, and WAN are different tests

| Path | Current boundary |
|---|---|
| Localhost | App `127.0.0.1:3210`; LiveKit signaling/TCP/UDP mapped to loopback |
| LAN | Pending secure origin, real authentication, listener/firewall topology, and media tests |
| Internet | Requires a verified public ingress and media path; home CGNAT can prevent ordinary port forwarding |

Current local-only media mappings are TCP `7880` (internal signaling/API), TCP `7881` (ICE fallback), and UDP `7882` (ICE mux). These are not instructions to open all of them publicly. Raw LiveKit signaling must not become an alternate user-accessible route around the policy gateway. Database and management ports stay private.

For remote deployment, choose the complete public media path first, then configure trusted HTTPS, app/media/TURN hostnames, Discord callbacks, secure cookies, and the minimum necessary TCP/UDP rules. TURN/TLS and website HTTPS can both need external TCP 443; the topology must account for that conflict. An ordinary HTTP tunnel does not automatically carry LiveKit WebRTC media. See [LiveKit deployment](https://docs.livekit.io/transport/self-hosting/deployment/), [ports](https://docs.livekit.io/transport/self-hosting/ports-firewall/), and [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking).

WSL/container localhost success does not prove LAN/WAN UDP delivery. Do not assume a Windows TCP port proxy handles UDP. A later reverse proxy also needs deliberate trusted-proxy/client-IP configuration; never trust arbitrary forwarded headers for authorization or quotas.

## Troubleshooting

| Symptom | Check |
|---|---|
| Missing Discord configuration | Follow `discord-setup.md`; enter secret locally; restart |
| Nonmember or screening message | Confirm membership of the exact configured server and completed screening |
| Verification unavailable | Respect Discord retry timing; new admission stays denied; inspect health without logging tokens |
| Session is closed after restart | Expected; owner/admin must explicitly open a new instance after media cleanup |
| Screen slots remain occupied after failed cleanup | Restore media connectivity; confirm revoke before reuse; do not clear counters alone |
| Mic blocked after “Allow speaking” | Individual blocks and stage-only rules remain separate |
| Local media cannot connect | Docker status, matching generated keys/config, gateway health, and local ICE mappings |
| Remote website loads but no audio/screens | Check the complete UDP/TCP/TURN path; website access is not media proof |
| Port already in use | Identify the conflicting process; do not kill unrelated services |

Record actual browser/OS/device and failure details. Do not disable certificate checks, turn off the firewall, or expose development credentials as a workaround.
