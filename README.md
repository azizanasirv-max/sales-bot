# Gemini Live Voice Tester

Real-time, full-duplex voice test bench for the Gemini Live API. A React client
streams 16 kHz PCM from the microphone to a Node/Express WebSocket bridge, which
relays it to a Gemini Live session and streams the model's 24 kHz PCM back for
scheduled Web Audio playback. The UI instruments latency, interruptions and turn
lifecycle so barge-in behaviour can be evaluated empirically.

## Architecture

```
Browser (React)                              Node bridge (server.ts)                  Google
┌──────────────────────────────┐   ws /api/live-ws   ┌───────────────────────┐   Live API
│ getUserMedia → 512-sample    │ ──────────────────► │ per-socket LiveSession │ ─────────►
│ ScriptProcessor (≈32 ms)     │  audio, start, ping │ Context (isolated)     │
│ resample → 16-bit PCM/base64 │                     │  · generation counter  │
│                              │ ◄────────────────── │  · resumption handle   │ ◄─────────
│ generation gate + turn ledger│  audio, interrupted │  · language policy     │
│ Web Audio scheduling         │  turn_complete, ... │  · counters / logs     │
└──────────────────────────────┘                     └───────────────────────┘
```

Key files:

| File | Responsibility |
| --- | --- |
| `server.ts` | HTTP/static host, WebSocket bridge, per-session isolation, interruption forwarding, resumption, diagnostics endpoint |
| `src/App.tsx` | Session UI, microphone capture, playback scheduling, barge-in handling, diagnostics |
| `src/lib/conversation.ts` | Language policy, `ConversationGate` (generation acceptance), `TurnLedger` (turn lifecycle) — shared and unit-tested |
| `src/lib/liveConfig.ts` | Model resolution, start-request validation, Live session config, error classification |
| `src/utils/audio.ts` | Resampling, PCM encode/decode, RMS |
| `tests/unit/*.test.ts` | Offline regression tests for language, interruption, ordering and config |
| `tests/bridge-protocol.test.ts` | Spawns the real server without a key and verifies the transport contract |
| `tests/interruption-suite.ts` | Live-API interruption suite (requires `GEMINI_API_KEY` + running server) |
| `tests/live-controlled-trials.ts` | Live-API controlled barge-in trials using WAV fixtures |

## Conversation flow

1. The user selects voice **and conversation language**, then presses *Start*.
2. `startConversation` acquires the microphone, creates 16 kHz input/output
   `AudioContext`s and opens the bridge WebSocket.
3. The bridge validates the model/API key, opens a Gemini Live session with the
   language policy, `speechConfig.languageCode` (when locked) and a sliding
   context window, then reports `session_ready` with the **server's** session ID.
4. Microphone chunks are forwarded with `sendRealtimeInput`; the server drops
   chunks while no Live context is active (connecting/reconnecting).
5. Model audio is tagged with a **generation ID**. The client's
   `ConversationGate` decides whether each chunk may be decoded and scheduled.
6. `turn_complete` advances the server generation and closes exactly the turn it
   names in the client `TurnLedger`.
7. Barge-in: local VAD stops playback immediately and invalidates only the
   generations that are playing or still streaming. The server's `interrupted`
   event invalidates the reported generation and advances to the next one, whose
   audio is accepted normally.
8. On transport loss after a ready session the bridge resumes the Live session
   with its resumption handle (max 2 attempts). The client keeps its audio graph,
   history and language; if resumption is impossible the session fails closed

## Language consistency

Two levers are applied together:

* `speechConfig.languageCode` (e.g. `en-US`) when the user locks a language.
* A highest-priority language policy appended to the system instruction that
  forbids switching on interruptions or noisy transcripts.

`Auto (follow the user)` omits `languageCode` and instructs the model to detect
the first intelligible language and keep it. The preference is persisted in
`localStorage`, is part of the session diagnostics/export, and is never reset by
interruption recovery or session resumption.

Model compliance is ultimately empirical: an instruction cannot *guarantee*
behaviour, which is why the retest checklist below verifies it over many turns.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes* | Server-side API key. If absent, the user supplies a key in the UI (session storage only). |
| `GEMINI_LIVE_MODEL` | No | Overrides the default model ID `gemini-3.8-live`. `/api/status` reports the resolved value. |
| `PORT` | No | HTTP/WebSocket port (default `3000`). |
| `APP_URL` | In AI Studio | Injected by AI Studio for self-referential links. |

\* One of the server key or a UI-provided key is required.

Secrets are never logged, returned by `/api/status`, or included in the
diagnostics export.

## Commands

```bash
npm install          # or: bun install
npm run dev          # bridge + Vite dev middleware on :3000
npm run lint         # tsc --noEmit
npm run build        # production client build
npm test             # offline unit + bridge protocol tests
npm run test:unit    # language / interruption / ordering unit tests
npm run test:bridge  # real server, no API key required
GEMINI_API_KEY=... npm run test:live  # live interruption suite (server must be running)
```

## Diagnostics

The UI exposes latency stages (capture → send → bridge → first audio → audible),
generation IDs, interruption counts, playback cancellation counts, turn records
and a redacted JSON export. The bridge logs session creation/termination,
generations, interruptions, expiry and resume attempts without audio payloads or
credentials.

## Known limitations

* A browser-side model cannot be made to comply perfectly with a language
  instruction; verify over many turns (Test A) in Google AI Studio.
* If the bridge WebSocket itself drops (not the Gemini transport), the Gemini
  session is unreachable and the conversation cannot be resumed without replaying
  history. The UI fails closed and requires a new session.
* Microphone audio captured while the Gemini session is reconnecting is dropped,
  not buffered, to avoid feeding stale speech into the resumed VAD context.
* `ScriptProcessorNode` is deprecated but retained to avoid changing the capture
  architecture; it is supported by all current browsers.
* The resumption path depends on the Live API issuing `sessionResumptionUpdate`
  handles and cannot be exercised without a live key.

## Google AI Studio retest checklist

**Test A — Language stability.** Select a fixed language, hold ≥10 consecutive
turns. Pass: same language throughout, no switches, no drift after several turns.

**Test B — Single interruption.** Interrupt mid-response. Pass: audio stops
promptly, no stale audio afterwards, the assistant answers the new input, the
conversation continues.

**Test C — Repeated interruptions.** Interrupt early in generation, mid-playback
and at the tail. Pass: each interruption handled, session responsive, no obsolete
response resurfaces.

**Test D — Rapid turn-taking.** ≥10 short exchanges without reloading. Pass: no
missing/duplicated turns, no language change, no permanent busy state, no
accumulating playback errors.

**Test E — Longer conversation.** ≥5 minutes. Pass: responsive, language
consistent, no broken state (context compression keeps the session alive).

**Test F — Recovery.** If the environment can interrupt the network, force a
transport drop. Pass: session resumes with context (or fails closed with a clear
error), no stale responses, no duplicate turns.

   instead of silently starting a context-less session.
