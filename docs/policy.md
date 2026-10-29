# Room policy and defaults

`server/domain/stage-service.ts` is the authoritative application policy. Server authentication supplies the principal; request bodies, display names, client metadata, and UI badges are not authority. One long-running API process owns one room and one SQLite state database. Horizontal API replicas are not supported by this single-process coordination design.

## Authority and permission precedence

| Operation | Member | Admin | Owner |
|---|---|---|---|
| View verified waiting page and schedules | Yes | Yes | Yes |
| Open/end a session, change modes/lock, manage schedules | No | Yes | Yes |
| Join locked room as a new admission | No | Yes | Yes |
| Join while account-banned/session-blocked | No | No | Owner can explicitly restore access first |
| Approve stage/hand requests, moderate chat, manage pins/spotlight | No | Yes | Yes |
| Kick/session-block/ban an ordinary member | No | Yes | Yes |
| Remove or restore another app admin | No | No | Yes |
| Remove, ban, or demote the owner | No | No | Owner protection applies against other admins |
| Change admin-role mapping or explicit admin assignments | No | No | Yes |
| Change owner identity | No | No | Local environment configuration only |

The user approved owner-only cross-admin removal, account-wide restrictions, current-role audience mute, and preserving individual blocks when allowing speaking. Numeric limits below are engineering defaults and remain configurable where exposed.

Microphone eligibility requires a current admission, applicable room-mode permission, no individual block, no applicable group restriction, and ownership of the account's single microphone permission. Granting permission never activates another person's microphone.

| Control | Semantics |
|---|---|
| Stage only / moderated Q&A | Approved stage members may request microphone ownership; audience starts muted |
| Open discussion | Eligible audience may request microphone ownership; stage/share permission is unchanged |
| One-time mute | Mutes the current track; creates no persistent deny |
| Individual block | Account-wide enforced microphone deny; screen permissions are preserved |
| Mute audience | Dynamic rule on current audience roles, including later joins; stage speakers remain eligible |
| Mute everyone except me | Account-wide rule exempting the initiating account, still limited to one microphone device |
| Allow speaking | Clears group restrictions; preserves individual blocks and room-mode limits |
| Individual allow | Clears that account's individual block; preserves active group restrictions |
| Demotion from stage | Removes screen eligibility and ends active/reserved sharing; microphone follows the room mode |
| Microphone handoff | Deny old publisher, confirm media reconciliation, then grant the next device; failure leaves the next device muted |

An owner whose microphone is blocked can explicitly clear the relevant group/individual restriction and promote themselves onto stage. Other admins cannot remove the owner's underlying authority.

## Identity, admission, and removal

Stage status, microphone restrictions, microphone ownership, screen-slot limits, session blocks, and bans are keyed by Discord account. Each device receives its own server-issued identity/admission; another device does not reset account policy. A user-supplied device identifier is not a reconnect credential.

Kick disconnects all active devices for the account and revokes their admissions. Re-entry requires a new authorized admission and obeys the current lock. Session block denies the account across devices for the current session instance. Persistent ban survives later sessions until restored. `member.restore` clears session/persistent entry restrictions, but never revives revoked admissions automatically.

The room lock preserves current admissions. A disconnected device has a **90-second** reconnect grace tied to its existing admission and account. New devices, kicked/blocked accounts, and expired grants do not qualify. An admin can obtain a fresh authorized admission after that grace. Credentials alone do not bypass the authenticated signaling gateway.

## Lifecycle and schedules

Only an explicit admin action opens a session. Scheduled times and expected end times do not start or stop media. Concurrent opens serialize to one live instance. Each new instance receives a new session ID and media-room identity; ended instances and cancelled/completed reservations are terminal.

On end, admissions, hands, microphone/share ownership, chat, pins, reactions, and reaction retry IDs are cleared/revoked. Schedules, bans, administrator configuration, and audit records have separate lifetimes. On application startup, any previously live instance closes in application state and surviving media is reconciled before new admissions. Failed media cleanup keeps the room closed with cleanup pending; it is not reported as successful media shutdown.

Media policy changes persist a pending reconciliation marker before contacting the SFU. A failed restrictive update remains pending and maintenance retries it every two seconds after service recovery. Admins see a pending-enforcement notice. A failed handoff never enables the replacement publisher. Existing media cannot be promised to stop immediately while the SFU control API is unavailable; an acknowledged successful reconciliation is the enforcement boundary.

Schedules store UTC instants, require explicit timezone input, reject overlapping reservations, and display/edit as **KL time (UTC+08:00)**. Expected end is informational. Copying a prior schedule does not reuse its session credentials.

## Operational values

| Policy | Default | Source / behavior |
|---|---|---|
| Successful membership/admin proof age | 60 seconds | `MEMBERSHIP_CACHE_SECONDS`; shared per account across ordinary reads, new admissions, sensitive admin actions, current target-role checks, and media-token issuance. Rechecking the policy does not require another provider HTTP request while successful proof is current |
| Active membership recheck | 60 seconds | `MEMBERSHIP_RECHECK_SECONDS`; only accounts with an active event stream or connected, unrevoked media admission. Recent successful proof is reused; dormant login sessions alone do not spend provider quota |
| Existing-session maximum verification staleness | 300 seconds | `MEMBERSHIP_MAX_STALE_SECONDS`; temporary failure only, never new admission proof |
| New admission and sensitive admin action | Successful proof younger than 60 seconds; no stale fallback | If proof has expired and Discord cannot verify it, the new action is denied. A rate limit, timeout, or token failure is never proof of membership or admin authority |
| Admitted self-media commands | Ordinary bounded verification | `mic.acquire`, `share.reserve`, and `share.confirm` reuse current successful proof; temporary provider failure may use existing-session verification only within the 300-second maximum. Current admission, stage/microphone restrictions, share quota, and SFU publication confirmation still apply |
| Provider quota/cooldown | Provider-supplied deadline | Membership responses with zero remaining quota and provider 429 responses preserve reset/retry deadlines, including token-refresh limits and global scope. Suppressed requests do not spend additional quota; restarting or signing in again does not clear a persisted cooldown |
| App authentication session | 8 hours | Server record plus protected cookie |
| OAuth state / PKCE attempt | 10 minutes, single use | Bound to the browser device admission |
| Initial media token | 10 minutes | Requires active matching account/device admission and current policy; reuses successful membership/admin proof younger than 60 seconds, with no stale fallback. Server-refresh behavior is separate; see media-enforcement document |
| Lock reconnect grace | 90 seconds | `DEFAULT_POLICY.reconnectGraceSeconds` |
| Screen reservation | 30 seconds until confirmed/released | Expiry denies publishing; slot reuse waits for confirmed cleanup |
| Screen slots | 3 room-wide; 1 per account | Microphone and associated screen audio do not add screen-video slots |
| Pins | 5 | Current session only |
| Chat text | 2,000 characters | Safe text rendering; no HTML execution |
| Chat rate | 5 messages / 10 seconds / account | Shared across devices |
| Reactions | 10 actions / 10 seconds / account | Available emoji only; message retry IDs deduplicate for 60 seconds |
| Live chat retained | Up to 1,000 messages | Old unpinned messages are evicted first; no cross-session archive |
| Visible floating reactions | 10 seconds | Removed from session state on end/restart |
| Audit retention | 90 days | Purged during persisted state updates/startup; inspect operational maintenance policy before strict retention use |
| API request limit | 1,200 requests / minute / app session; 180 / minute / connection IP without a session | Separate from Discord's provider quota. Deployment proxy/IP handling must be validated before WAN use |

Room policy values are exposed in the authenticated snapshot. Authentication settings live in `.env`; domain defaults are in `DEFAULT_POLICY` and constructor policy options. A future configuration UI must preserve server validation.

Each new admission, sensitive action, current target-role check, and media-token request may rely on successful membership/admin proof up to 60 seconds old. For an otherwise idle active session, a 60-second periodic tick can reuse nearly expired proof and perform its next provider check on the following tick, so passive membership/role-change detection can approach 120 seconds in normal operation. On temporary provider failure, only existing access may use the separate 300-second maximum age of the last successful proof; strict operations cannot use that grace. Once nonmembership, screening requirements, or revoked authorization is observed, cached/stale success cannot override the denial and affected access is invalidated.

Concurrent callers for one account share a strict provider attempt, then apply their own allowed proof age and stale policy. A relaxed caller's fallback never becomes a strict caller's proof. The interface shows provider-derived retry time and avoids suggesting another login as a cooldown bypass. The observed local quota header pattern showed capacity five with growing reset durations; it must not be interpreted as a fixed five-requests-per-minute allowance. Provider headers, rather than a hardcoded quota assumption, govern each wait.

Configuration validation requires `MEMBERSHIP_CACHE_SECONDS` to be no greater than `MEMBERSHIP_MAX_STALE_SECONDS`, so current cached proof cannot outlive the configured existing-access limit. See [verification](verification.md) for the current tested scope and remaining real-account acceptance.

Audit events retain actor, action, target ID, session, timestamp, and outcome. Message bodies, OAuth tokens, cookies, and secrets are excluded. Pins reference original message IDs; deleting a message removes its pin. Deleted or expired bodies are not copied into permanent audit history. Filesystem backups remain private copies and have their own retention policy.

## Admin configuration precedence

1. `DISCORD_OWNER_ID` is the authoritative owner, subject to verified membership for real room access. The local preview uses a distinct fictional owner.
2. `DISCORD_ADMIN_ROLE_IDS` initializes and updates the initial mapping, including when a prior local preview database is reused. Once the owner explicitly saves a mapping, that persisted override takes precedence on later startups. A persisted marker distinguishes an owner decision from an unconfigured preview seed.
3. Current verified Discord role IDs **or** an explicit owner-granted admin assignment grant admin access. These are additive; removing an explicit grant does not negate a still-mapped Discord role.
4. Removing all applicable grants revokes app-admin authority on fresh verification. A ban is an independent entry restriction, not an admin-role revocation.

For strict media guarantees, application policy must be paired with the protected signaling/media deployment described in [media enforcement](media-enforcement.md). These tables do not certify an untested SFU path.
