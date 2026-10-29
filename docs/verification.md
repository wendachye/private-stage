# Verification status

The last desktop validation checkpoint on 2026-10-29 used Node.js 24.18.0 on Windows: **238 tests passed, with no failures or skips**, with both production and LiveKit integration checks enabled against a disposable local SFU with fictional keys. Frontend and backend production builds and all three TypeScript checks also passed. This records the tested scope; it does not replace the pending checks below.

## What has been checked

- Session scheduling, waiting-room admission, automatic admin admission, Go live, speaking modes, moderation policies, chat, reactions, screen reservations and permission enforcement have automated coverage.
- Authentication tests cover local session handling, Discord membership caching and rate-limit recovery using controlled provider responses. A desktop browser login and owner access were checked separately; the automated suite does not log into a real Discord account.
- Split hosting tests cover exact-origin credentialed CORS, preflight rejection, cookie-authenticated commands, event streams, rate-limit cooldown visibility, OAuth redirect configuration and authenticated signaling. An isolated browser exercise also checked login, reload, event updates and sign-out with separate frontend and backend processes using fictional users.
- Same-origin frontend proxy checks exercise Next's actual production configuration loader, bounded server-only settings, exact routing, replacement of caller gateway headers and disabled caching. UDP regressions cover byte transparency, independent peers, idle expiry and bounded peer counts. An isolated public media trial additionally verified decoded audio/video through a temporary relay, matching selected ICE routes and a pause/resume check with flat received bytes while the UDP relay was paused. This does not establish real Vercel forwarding or real-member acceptance.
- Fresh production frontend HTML was checked both through the combined desktop server and a standalone Next.js server. Tests verify request-specific CSP nonces on hydration scripts and the configured API connection allowlist. The compiled backend was started from its own folder with temporary data and provider integrations disabled, then shut down through its IPC contract.
- Native LiveKit integration checks exercise synthetic video and audio, decoded playback, publication cleanup, restrictive speaking policies, reconnects, three concurrent synthetic screen publications and recovery after an isolated application crash. Browser tab sharing with audio has also been checked on the desktop. Synthetic media is separate from physical microphone and multi-person acceptance testing.
- SQLite recovery, backup/restore isolation, process ownership, bounded shutdown, supervisor behavior and Windows startup scripts have automated checks. Restore rehearsals use scratch projects and synthetic data.

## Repository CI

[The CI workflow](../.github/workflows/ci.yml) uses an Ubuntu 24.04 runner, exact Node.js 24.18.0 and `npm ci` with the root workspace lockfile. It runs typechecking, both production builds and the test suite with `RUN_PRODUCTION_CHECK=1`. The production checks start isolated loopback servers with temporary databases and fixture keys; they do not need Discord credentials or an existing application instance.

The default Ubuntu job deliberately skips the 21 Windows-only desktop/PowerShell checks and the three LiveKit integration checks. Its result must be read separately from the Windows checkpoint above. The [first Ubuntu job](https://github.com/wendachye/private-stage/actions/runs/40880895490), at commit `a7cd2a9`, passed the locked install, typechecks, both builds and portable production tests. The optional native-media job was not selected for that push.

A separate clean-copy typecheck also passed without `.env`, `.next` or cached TypeScript outputs. It used an isolated source archive and local dependency links; the GitHub run above independently verified installation on Ubuntu.

For a portable local run from the repository root:

```sh
npm ci
npm run typecheck
npm run build
RUN_PRODUCTION_CHECK=1 npm test
```

The last line uses POSIX shell syntax. In PowerShell, set `$env:RUN_PRODUCTION_CHECK = '1'` before running `npm test`.

For media CI, manually run the workflow with **livekit** enabled. That separate job creates random disposable keys and a loopback-only LiveKit `v1.13.11` container, then runs `npm run test:media` with `RUN_LIVEKIT_INTEGRATION=1`. The job masks its keys and removes the container and temporary configuration afterward. It uses no repository secrets, saved `.env`, deployment configuration or physical devices. This optional Linux native-SDK job also needs its first successful Actions run before being considered verified on that platform.

## Backend container checks

The production API image built from the private-state-excluding Docker context, and the Compose examples and pinned Caddy configuration passed syntax validation. An isolated, non-root image check used fictional keys, a fresh managed volume, no network and no published ports. Health, exact-origin CORS, secure host-only cookies and rejection of untrusted Host/Origin passed.

The container check also reproduced a stale PID-lock failure after SIGKILL, then verified the container entrypoint's exclusive OS lock: a concurrent writer was refused without changing the active lock; SIGKILL followed by restart recovered the same volume; graceful shutdown exited zero and removed the application lock. The OS-lock inode remains in place. See [deployment](deployment.md) for the opt-in regression command and managed-volume boundary. Public TLS, ingress and real media connectivity still need deployment acceptance.

## Pending acceptance checks

- **Physical microphone:** real device selection, capture, saved browser permission recovery and device reconnection remain deferred until a microphone is available.
- **Windows reboot:** startup registration and isolated startup rehearsals passed; a real reboot, login and cold Docker Desktop recovery remain deferred.
- **Second Discord member:** real membership admission, waiting/live speaking transitions, moderation, screen/audio reception and restrictions across devices remain pending. Keep this as the final user acceptance test.
- **Public deployment:** trusted HTTPS, public DNS, external OAuth callbacks, the WAN path and any required TURN connectivity remain unverified. Publishing source code does not deploy the application or make the desktop publicly reachable.
- **Real-world media and capacity:** three simultaneous native browser screen captures, mobile/background behavior, network changes and sustained 10–15 participant load have not been accepted. Synthetic reconnect and concurrency checks do not establish those limits.

Keep live credentials, databases, backups, logs and machine-specific media configuration outside the published source. CI intentionally produces no artifact bundle containing those files.
