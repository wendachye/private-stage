# Session phases and flexible speaking

One session has **Waiting** and **Live** phases. From **Session closed**, an admin chooses **Open session**, joins automatically in Waiting, and clicks **Go live** when ready to enter Live. Members can enter, text-chat and speak according to the selected mode before going live. The same session, room, speaking mode and chat continue across both phases. **End session** is available in Waiting and Live.

## Speaking modes in both phases

- **Everyone can talk** is selected by default for new sessions. All admitted members may choose Unmute, including audience members.
- **Stage only** permits approved stage speakers to use their microphones. Audience members can listen and text-chat.
- **Moderated Q&A** also restricts speaking to approved stage speakers; audience members can raise a hand to request a turn.
- An admin can change the speaking mode while Waiting or Live. Individual microphone blocks, group restrictions and entry restrictions remain authoritative in every mode.
- Switching from Everyone to a restrictive mode revokes ineligible microphone ownership and publication permissions across devices. Switching back grants eligibility but does not turn microphones on.
- **Go live keeps the selected speaking mode and eligible microphone choices.** Members are not muted merely because the phase changes. The room, chat and pins are preserved.

Everyone joins with their microphone off and decides when to unmute. Everyone mode does not expand screen-sharing permissions: presenters still need stage approval, and the three-share limit remains in place.

## Opening and joining

Both the main **Open session** form and a scheduled session's **Open session** action open the session in Waiting. The form offers a speaking-mode choice with Everyone can talk selected by default. The opening admin's current browser is admitted and placed on stage atomically. Its microphone starts off, and that browser makes one automatic media connection attempt.

The **Schedule session** and **Edit session** forms also offer **Who can speak**, and each scheduled card displays the saved choice. New schedules default to Everyone can talk. Opening a scheduled session uses its saved speaking mode, which continues through Go live. Editing a schedule does not change a room that is already open; use the room's speaking control for that. Older schedules without a saved mode receive Everyone can talk while retaining their reservation details.

Other browsers, refreshes and other admins do not automatically connect because someone opened a room. Automatic connection is cancelled when the account, device, authority, session or admission changes. An earlier pending connection is allowed to finish before the new opening's connection is attempted.

If media connection fails, the session remains in Waiting and the admin can use **Connect to room**. The session is not created again. With media configured, Go live is available once the admin has joined and connected.

People already in the session during Waiting can hear microphones and see screens that users explicitly publish there. The host can use the local microphone test in preferences before choosing to unmute in the shared room.

## Transition and cleanup

Go live is an authenticated admin operation. The server confirms the selected mode's current media policy, then records Live and its start time. It preserves existing eligible microphone ownership. If media synchronization fails, the room remains Waiting with the selected policy and a retry obligation; the admin can retry Go live after recovery.

Going live does not change the session or room identity, disconnect members or clear chat. The same speaking-mode control works before and after Go live. A failed change to a restrictive mode keeps the requested restrictions in application policy while media cleanup is retried.

The older waiting-only audio toggle remains a compatibility alias for Everyone or Stage only. It does not maintain a separate speaking policy. New controls use the shared room mode.

**End session** works in either Waiting or Live and returns to **Session closed**, clearing temporary chat, pins, hands, shares and admissions. Schedules and action history retain their existing behavior. A process restart closes either phase and reconciles media before another session can be opened.

## Verification

See [verification](verification.md) for the current combined checkpoint and commands. Automated coverage includes scheduled modes, legacy migration, mode changes in both phases, microphone continuity, restrictive revocation and cleanup. Real-SFU tests use synthetic tracks; physical microphones and a second real Discord member remain separate acceptance checks.
