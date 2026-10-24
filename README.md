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
| `src/lib/generationLifecycle.ts` | Reconstructed: single bridge generation authority and `mapServerContent` (Gemini frame → client frames) |
| `src/lib/audioIngest.ts` | Reconstructed: bounded, ordered pre-ready microphone buffer |
| `src/lib/transcription.ts` | Reconstructed: interim/final input and generation-attributed output transcript classification |
| `src/lib/liveConfig.ts` | Model resolution, start-request validation, Live session config, error classification |
| `src/utils/audio.ts` | Resampling, PCM encode/decode, RMS |
| `tests/unit/*.test.ts` | Offline regression tests for language, interruption, ordering and config |
| `tests/bridge-protocol.test.ts` | Spawns the real server without a key and verifies the transport contract |
| `tests/interruption-suite.ts` | Live-API interruption suite (requires `GEMINI_API_KEY` + running server) |
| `tests/live-controlled-trials.ts` | Live-API controlled barge-in trials using WAV fixtures |

## Conversation flow

1. The user selects voice **and conversation language**, then presses *Start*.
2. `startConversation` acquires the microphone, creates a 16 kHz input
   `AudioContext` (falling back to the hardware rate) and an output
   `AudioContext` at the hardware rate, then opens the bridge WebSocket.
3. The bridge validates the model/API key, opens a Gemini Live session with the
   language policy, a sliding context window and session-resumption updates,
   then reports `session_ready` with the **server's** session ID.
4. Microphone chunks are forwarded with `sendRealtimeInput`. Until the first
   `setupComplete` the bridge keeps a bounded FIFO window (250 chunks / 512 KB /
   15 s) and flushes it in capture order once the session is ready, so a short
   opening utterance is not truncated. Audio captured during a reconnect is still
   dropped rather than replayed. `session_ready` reports how many chunks were
   flushed and the capture span, and the client records the measured input
   sample rate and chunk duration.
5. Model audio is tagged with a **generation ID**. This build never forwards
   generated audio to the browser (text-only suggestions); the `ConversationGate`
   still owns generation validity so late/stale content cannot be attributed to
   the current turn.
6. `turn_complete` closes exactly the turn it names in the client `TurnLedger`.
   A trailing `turnComplete` after an interruption closes the *interrupted*
   generation and does not advance the counter a second time.
7. Barge-in: the server's `interrupted` event is attributed to the generation
   that last produced content (not to an empty reserved slot), is idempotent for
   duplicate events, and invalidates only that generation. Local VAD remains the
   immediate-stop path; content coalesced with an interruption is discarded as a
   stale tail rather than promoted into the next turn.
8. On transport loss after a ready session the bridge resumes the Live session
   with its resumption handle (max 2 attempts). The client keeps its audio graph,
   history and language; if resumption is impossible the session fails closed
   instead of silently starting a context-less session.

## Language consistency

`gemini-3.8-live` is a native-audio model. Google's Live API documentation
states that native-audio models choose the language themselves and *do not
support explicitly setting the language code*, so this application applies the
supported lever: a highest-priority language policy appended to the system
instruction that forbids switching on interruptions or noisy transcripts.
`speechConfig.languageCode` is only added when `GEMINI_LIVE_MODEL` points at a
legacy half-cascade Live model where that field is documented as supported.

`Auto (follow the user)` instructs the model to detect the first intelligible
language and keep it. The preference is persisted in `localStorage`, is part of
the session diagnostics/export, and is never reset by interruption recovery or
session resumption.

Model compliance is ultimately empirical: an instruction cannot *guarantee*
behaviour, which is why the retest checklist below verifies it over many turns.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Yes* | Server-side API key. If absent, the user supplies a key in the UI (session storage only). |
| `GEMINI_LIVE_MODEL` | No | Overrides the default model ID `gemini-3.8-live`. `/api/status` reports the resolved value. |
| `LIVE_CONNECT_TIMEOUT_MS` | No | Deadline for opening a Live session (default `20000`). |
| `ALLOWED_ORIGINS` | No | Comma-separated extra browser origins permitted to open the bridge WebSocket. Same-host and `APP_URL` are always allowed. |
| `PORT` | No | HTTP/WebSocket port (default `3000`). |
| `APP_URL` | In AI Studio | Injected by AI Studio for self-referential links. |

\* One of the server key or a UI-provided key is required.

Secrets are never logged, returned by `/api/status`, or included in the
diagnostics export.

## Commands

```bash
npm install          # or: bun install (bun.lock is the canonical lockfile)
npm run dev          # bridge + Vite dev middleware on :3000
npm run lint         # tsc --noEmit
npm run build        # production client build
npm run start:prod   # serve dist/ + bridge (NODE_ENV=production)
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
* **Deferred — late-transcription attribution.** A delayed output transcript
  whose generation ID is absent cannot be proven to belong to any particular
  turn. The client drops such text instead of guessing, and text for a terminal
  generation is rejected. This does not fully solve the protocol-level case where
  the *provider* delivers a late transcript tagged with a subsequent turn; that
  remains a known limitation and is being investigated separately in Google AI
  Studio. No artificial delay or "perfect attribution" claim is made here.
* Microphone audio captured while the Gemini session is reconnecting is dropped,
  not buffered, to avoid feeding stale speech into the resumed VAD context. The
  pre-ready buffer only covers the first connection and is bounded (dropping the
  oldest audio beyond its limits).
* **Provenance of `src/lib/audioIngest.ts`, `src/lib/generationLifecycle.ts` and
  `src/lib/transcription.ts`.** The original Stage 3 branch and files were not
  present in any Git reference, reflog, dangling object, Cline artifact or other
  workspace. These modules are a documented reconstruction of the missing
  behaviour on top of the verified bridge; they are not the original files.
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
