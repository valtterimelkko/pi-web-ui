# Phase 7 — operator real-ear runbook (Voice Mode)

**Class:** operator runbook (prepared by the conductor; Phase 7 authority is the operator's alone).
**Status:** READY — the disposable slice is prepared and self-tested; awaiting the operator's session.

Phase 7 is the only gate no agent may sign off. This runbook gives you the whole session in one
command and says exactly what to judge. Nothing here touches production: the slice is a disposable
server with its own directory, ports, registry and state, plus a dev client pointed at it.

## 1. Start the slice (one command, from a terminal on this host)

```bash
cd /root/pi-web-ui
bash scripts/voice-mode-dogfood.sh
```

It boots the disposable server with **`VOICE_MODE_ENGINE=gemini-live`** (the native engine on trial)
and the dev client wired to it, then prints the URL and password. The shell profile exports
`GEMINI_API_KEY` (the script never prints it). `Ctrl-C` stops both; the disposable directory is left
for inspection and can be deleted afterwards.

If a previous slice is still around, the script refuses and tells you the exact stop command — it
never guesses at another process.

## 2. The session (~15 minutes, hands busy)

1. Log in at the printed URL, start (or pick) a **Pi** session in a scratch workspace with a real,
   small task you can think aloud about.
2. Open **Drive Mode** → in the dictation row, expand the **native voice lane** (closed by default;
   it never competes with the shipped mic) → press its **Start** control.
3. Talk the way you actually work: think aloud, wander, ask the talker questions, hand instructions
   to the worker, change your mind. Then, mid-session, if you want to see the fallback: nothing —
   it engages on its own if the Live connection fails, and announces itself in the conversation.

## 3. What you are judging (the Phase 7 protocol)

| Property | What good looks like |
|---|---|
| **Spoken time-to-first-audio** | Natural pacing — no awkward pauses; target ≤ 2.0 s p90 |
| **Colleague feel** | Free discussion and speculative reasoning; no switchboard interruptions, no "shall I… are you sure?" loops |
| **Audio ducking** | Talker audio dips while you speak and recovers promptly — no eaten words, no glitching |
| **Honest delivery** | The chime fires **only** on a delivered outcome; the receipt verdict (delivered / queued / refused / unknown) is visible and truthful; a proposal you did not hear back is never confirmable |

Safety reminders you should be able to *feel*: instructions to the worker are your own words
(semi-verbatim, channel phrases stripped); nothing is released without your confirmation; a spoken
or typed confirmation only releases a proposal you were read back.

## 4. Stopping and reporting

- Say "stop the lane" or press Stop, then `Ctrl-C` in the terminal.
- **Your verdict is the gate.** Reply to the conductor (Telegram is fine) with, explicitly:
  acceptable / not acceptable, and for anything not acceptable: which property, what you heard, and
  roughly when (the slice's server log and the browser console are then worth pulling).
  A written line from you in the session log is the sign-off; no agent can write it for you.

## 5. What this slice deliberately is not

- Not production, no production restart, no production validation, no deploy. The standing gate holds.
- Not the scripted Gate-5 slice (that one is a scripted client); this is the real browser surface
  (AudioWorklet capture, the arbiter, the chime, the card) against the real server mount.
- Not a substitute for your ears: this host has no OS-output oracle for the audio lab, which is
  exactly why Phase 7 exists.
