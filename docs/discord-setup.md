# Discord setup

Discord supplies identity and server-membership verification. This app hosts its own stage and chat. Every installation must configure its own OAuth application and keep credentials outside source control. See [verification](verification.md) for the current acceptance boundary.

## 1. Obtain IDs

In Discord, enable **User Settings → Advanced → Developer Mode**. Then use the relevant context menu to copy:

- The private server's **Server ID**.
- Your **User ID** for `DISCORD_OWNER_ID`.
- Each role's **Role ID** that should grant app-admin access. Role names are not authoritative.

Role IDs may be left empty initially if only the configured owner should administer the app. Sharing IDs is enough for setup discussion; passwords and client secrets belong only in local configuration. Discord's [ID guidance](https://support.discord.com/hc/en-us/articles/206346498) explains the platform controls.

## 2. Create the OAuth application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create an application for Private Stage, then open its OAuth2 settings.
3. Copy its Client ID. Generate/copy its Client Secret directly into the local `.env`; do not put it in chat, source files, screenshots, or logs.
4. Register this exact local redirect URI:

```text
http://localhost:3210/api/auth/discord/callback
```

Do not interchange `localhost` and `127.0.0.1` during a login attempt. Scheme, hostname, port, and path must match the registered callback. When a trusted temporary hostname or future domain is actually configured, register its exact callback too:

```text
https://YOUR-CONFIGURED-HOSTNAME/api/auth/discord/callback
```

Replace the placeholder with the chosen host. The corresponding `APP_URL` is the origin without the callback path. Domain purchase and external media ingress are deferred to the remote-testing checkpoint.

## 3. Enter configuration locally

Stop the application, open `.env` in a local editor, and fill:

```dotenv
LOCAL_PREVIEW=false
APP_URL=http://localhost:3210
DISCORD_CLIENT_ID=YOUR_CLIENT_ID
DISCORD_CLIENT_SECRET=ENTER_SECRET_LOCALLY
DISCORD_GUILD_ID=YOUR_PRIVATE_SERVER_ID
DISCORD_OWNER_ID=YOUR_USER_ID
DISCORD_ADMIN_ROLE_IDS=ROLE_ID_1,ROLE_ID_2
```

Keep the generated `SESSION_KEY`, `TOKEN_ENCRYPTION_KEY`, and media credentials. The example values above are placeholders, not working credentials. Restart after saving. Only switch to production HTTPS once the complete deployment is configured and tested.

The maintained `@fastify/oauth2` integration uses the authorization-code flow, S256 PKCE, and a device-bound, single-use state check. Requested scopes are `identify` and `guilds.members.read`. The backend calls the current-user guild-member endpoint to verify membership and role IDs. No Discord bot or privileged full member-list fetch is required for this design. See [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) and [current-user membership](https://docs.discord.com/developers/resources/user#get-current-user-guild-member).

Access and refresh tokens stay encrypted in the server's auth database. The frontend receives app identity and media credentials, not Discord OAuth tokens. Keep `.env` with its encryption key alongside a protected database backup; changing that key without migration makes saved tokens unreadable.

Refresh operations are coordinated per account so simultaneous browser/background checks do not reuse a rotating refresh token. A delayed response for an older access token reloads the canonical stored replacement. Known membership loss or revoked authorization remains denied even if downstream media cleanup temporarily fails; it is never reclassified as a successful stale-membership fallback.

The default membership/admin proof window is **60 seconds** (`MEMBERSHIP_CACHE_SECONDS`). Backend checks for new admission, sensitive admin actions, current target roles, and media tokens can reuse a successful account verification within that window, but cannot use expired proof during a Discord failure. Ordinary existing-session access has a separate **300-second** maximum age during temporary failures. A strict action can therefore rely on proof up to 60 seconds old; an observed denial immediately takes precedence over cached success. Passive detection for an otherwise idle active session can approach 120 seconds because a 60-second background tick may reuse nearly expired proof until its next tick. See the exact [policy and failure behavior](policy.md).

Active accounts are rechecked on a 60-second cadence, sharing current proof across browser tabs, devices, commands, and media authorization. Concurrent provider checks for one account share one strict request; callers separately apply their allowed stale policy. Dormant eight-hour login sessions with no event stream or connected media admission no longer trigger periodic membership requests.

Respect the Retry countdown when Discord limits verification. The server persists provider reset/retry deadlines, including zero remaining membership quota, token-refresh 429s, and global limits. Restarting the app or signing in again does not clear that cooldown. The interface suppresses early retry and does not offer another login as a way around a verification outage. Do not repeatedly click login or refresh to try to recover quota. Successful proof may still be reused while it is current; once a strict operation needs newer proof, it waits or fails closed until verification is available.

Provider quotas can change. Honor the returned cooldown instead of assuming a fixed request allowance. Mocked provider tests and a local owner trial do not establish authorization behavior for every account; complete the real account checks below.

## 4. Verify real authorization

Use an actual server member and an actual nonmember. Confirm the owner and configured-role admins, then remove an eligible role and verify that sensitive actions lose authority after recheck. Test revoked consent, expired tokens, Discord rate limits/outages, and membership screening. A successful identity login alone must not expose private room data or media credentials.

The owner can manage role mappings and explicit grants through the owner controls. Saved role mappings take precedence over the initial environment seed; explicit grants and current mapped roles are additive. See [policy](policy.md) before testing revocation.

## Preview safety

`.env.example` disables local preview. `npm run setup` enables it only in the generated local development `.env` so the app can be exercised before Discord exists. The server rejects preview when `NODE_ENV=production`, when `HOST` is not loopback, or when `APP_URL` is not loopback. The preview route accepts only fixed fictional personas; it is not a general impersonation or membership bypass endpoint for deployment.

Before any LAN/WAN deployment, disable preview, configure real Discord, and verify that the preview-login route is unavailable. A missing configuration screen is a setup state, not a reason to broaden access.
