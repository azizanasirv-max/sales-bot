# Gemini 3.8 Live Audio-In / Text-Out Sales Copilot — Evidence-Based Audit

Date: 2026-10-24  
Scope: current `main` / `cline/de2jk712` checkout (`9ceef0b`), no source changes applied.  
Mode: code audit + official documentation + offline probes. **No live microphone or
Gemini API session was available in this environment** (no `GEMINI_API_KEY`, no audio
device), so no claim in this report asserts acoustic quality or observed API event
granularity. Anything that needs a real session is labelled **[LIVE]**.

Evidence used:

- Full read of `server.ts`, `src/App.tsx`, `src/utils/audio.ts`,
  `src/lib/conversation.ts`, `src/lib/liveConfig.ts`, and all tests.
- `npm test` → 55/55 pass; `npm run lint` → clean; `npm run build` → success
  (current baseline).
- Offline probes against the real `src/utils/audio.ts` and
  `src/lib/conversation.ts` (results quoted in §2.1 and §2.2).
- Official docs: Gemini Live capabilities guide, Live transcription guide, Live
  API reference, and the Gemini 3.8 Live developer guide
  (`docs.cloud.google.com/.../gemini-3-8-live`), retrieved 2026-10-24.
- SDK types from the installed `@google/genai` 2.30.0.

---

## 1. Executive summary

The audio **format** is correct: 16 kHz mono signed-16-bit little-endian PCM, base64,
`mimeType: "audio/pcm;rate=16000"`, WebSocket ordering preserved, no interleaving,
no double-send. PCM conversion was verified numerically (§2.1, V-1). The
`responseModalities: [Modality.AUDIO]` + `inputAudioTranscription: {}` +
`outputAudioTranscription: {}` configuration is the documented way to get text
from a native-audio Live model.

The remaining problems are therefore **not primarily a format bug**. They are:

1. **Audio can be silently lost at the start of the session and during reconnects.**
   Microphone capture starts immediately, but the bridge drops every chunk until
   `setupComplete` (`server.ts:872-875`). For a short first utterance such as
   “Hey”, this can remove the onset or the whole word, and nothing in the UI or
   diagnostics counts it.
2. **The real microphone rate / chunk duration / DSP settings are never measured or
   logged.** `AudioContext({sampleRate:16000})` is attempted, but if it falls back
   the same 512-sample buffer produces 10.7–16 ms chunks (below the documented
   20–100 ms range for 3.8 Live) and the per-chunk resampler injects a phase
   discontinuity at every boundary. This path is currently unobservable.
3. **Transcript finalization is not modelled.** Every `inputTranscription` event is
   treated as a completed customer turn, and `Transcription.finished` is ignored.
   Every `interimInputTranscription` replaces the previous hypothesis (correct if
   the API sends cumulative hypotheses), but interim text is never cleared on
   interruption, turn completion, reconnect, or timeout.
4. **Output-transcript generation attribution is wrong when a transcript shares a
   server frame with `turnComplete` or `interrupted`.** The bridge reads
   `outputTranscription` *after* advancing the generation, so the last words of a
   suggestion are tagged as the *next* generation. This creates ghost suggestions
   and promotes stale tails to “Active Recommendation”.
5. **Local barge-in is dead code in this build.** Model audio is discarded, so
   `markPlaybackScheduled()` is never called and `playbackCount()` is permanently 0.
   `shouldTriggerLocalBargeIn()` can never return true. Interruption handling depends
   100% on Gemini emitting `serverContent.interrupted`, and nothing in the client
   reacts to customer speech onset/interim transcripts to freeze or retire the
   active suggestion.

The single most probable explanation for “Hey” → “school” is **not** a wrong sample
format. It is a combination of **missing/truncated onset audio** (mechanism 1) and
**ASR ambiguity with no language hint and browser DSP enabled**, with a lower-ranked
possibility of the resampling fallback (mechanism 2). §5 ranks these by evidence and
§10 defines the live tests that distinguish them.

---

## 2. Confirmed code defects

Confidence labels:

- **Confirmed** — directly visible in code and, where possible, reproduced offline.
- **Confirmed conditional** — the defect exists in a code path whose runtime
  occurrence still needs live instrumentation.
- **Live** — requires a real session to observe.

### 2.1 Microphone → Gemini audio pipeline

| ID | Finding | Location | Evidence / impact |
| --- | --- | --- | --- |
| A-1 | **Capture starts before the Live session is ready and audio is dropped, uncounted.** `startConversation` creates the `ScriptProcessor` immediately after opening the bridge WebSocket (not after `session_ready`). The bridge’s `handleAudioFrame` drops every chunk while `!ctx.gemini \|\| !ctx.active`. The client increments `micChunksCaptured`/`micChunksSent` only inside the successful-send branch. | `src/App.tsx:936-955` (start), `:1288-1390` (processor), `:1360-1380` (send/counters); `server.ts:864-876` | **Confirmed.** The user can speak during the 0.3–2 s setup window; those chunks are counted nowhere. A one-word utterance can be clipped or entirely lost. This is the strongest code-level explanation for a wrong transcript of “Hey”. |
| A-2 | **Chunk duration is assumed, not measured.** Diagnostics hard-code `measuredChunkDurationMs: 32`. `createScriptProcessor(512, 1, 1)` is fixed regardless of `inputCtx.sampleRate`. If the 16 kHz constructor throws and the default rate is used, each chunk is 16 ms @32k, 11.6 ms @44.1k or 10.7 ms @48k. The 3.8 Live guide specifies **20 ms–100 ms** chunks. | `src/App.tsx:842`, `:902-916`, `:1296`; `src/utils/audio.ts:10-23` | **Confirmed conditional** (depends on the context rate actually negotiated). Measured geometry: 16k → 32.00 ms (compliant); 32k → 16.00 ms; 44.1k → 11.61 ms; 48k → 10.67 ms (all below the documented minimum). |
| A-3 | **Per-chunk linear resampling has no phase/state continuity and rounds each chunk independently.** `resampleTo16k` is called per 512-sample block with `Math.round(input.length / ratio)`. | `src/utils/audio.ts:10-23`; `src/App.tsx:1348` | **Confirmed.** Probe: 1 s of 1 kHz tone at 48 kHz → 16,031 samples (0.19 % fast); 62 of 93 chunk boundaries contain a discontinuity > 0.1 (max 0.259) versus a maximum normal adjacent step of 0.1305. This is a real distortion source if the fallback path is used. No effect when `inputCtx.sampleRate === 16000` (early return). |
| A-4 | **Actual microphone format and DSP are never read.** No `track.getSettings()` / `getCapabilities()`, no `sampleRate`, `channelCount`, `echoCancellation`, `noiseSuppression`, `autoGainControl`, `deviceId` in diagnostics. Constraints are unconditionally `true`. | `src/App.tsx:642-649`; diagnostics `:842-883`; no other references | **Confirmed observability defect.** It is impossible to tell from a session export whether the browser honoured 16 kHz, which device was used, or whether NS/AGC were applied. Acoustic impact is **[LIVE]**. |
| A-5 | **No AudioContext / track lifecycle monitoring.** State is resumed only once at start. No `statechange`, `visibilitychange`, `track.onended`, `track.onmute`, `devicechange`, or callback-cadence watchdog. | `src/App.tsx:902-916`, `:1288-1390` | **Confirmed gap.** If the context suspends (background tab, OS audio change) or the device disappears, the UI still shows “STREAMING” and silently sends nothing/silence. |
| A-6 | **Bridge-side drop accounting is not exposed.** No frame counts/drops are sent to the client; `audio_ack` is emitted only every 50th seq and the client assigns **both** `micChunksReceivedBridge` and `micChunksForwardedBridge` to that seq. | `server.ts:884-899`; `src/App.tsx:1082-1093` | **Confirmed.** “Received” and “forwarded” are the same number. Client-side send drops, transport loss and bridge drops cannot be distinguished. |
| A-7 | **`audioStreamEnd` is never sent** when capture stops, the session ends, or audio is paused for >1 s. | no reference; `server.ts:878` only sends audio | **Confirmed omission.** Official docs recommend `audioStreamEnd` to flush cached audio after a pause. On `end` the socket closes, so impact is limited; relevant if capture is ever paused without closing. |
| A-8 | **`interimInputTranscription` is read through `as any`.** | `server.ts:502` | **Confirmed fragility.** The installed SDK (2.30.0) has the field, but `package.json` allows `^2.4.0`; an older resolved version would make the branch silently dead. The UI would then have no interim hypotheses at all. |
| A-9 | **Mic capture is connected to `inputCtx.destination`.** | `src/App.tsx:1389`, also `:720` | **Checked, not asserted as a defect.** A ScriptProcessor must be pulled by a destination; its output buffer is a fresh zero-filled `AudioBuffer` per event, so this should not loop the mic to the speakers. It is still an unnecessary render path and should be verified by listening once with headphones/speakers. |

Correct in this area (verified, do not change):

- V-1 PCM encoding: probe `floatTo16BitPCM([0, 1, -1, 0.5, -0.5, 2, -2])` →
  `[0, 32767, -32768, 16383, -16384, 32767, -32768]` (clamped, signed, LE), base64
  length 20 for 14 bytes, exact round-trip. **Correct.**
- V-2 Mono, no interleaving: `createScriptProcessor(512, 1, 1)` forces one input
  channel; only `getChannelData(0)` is used. **Correct.**
- V-3 `mimeType: "audio/pcm;rate=16000"` is the documented string. **Correct.**
- V-4 WebSocket preserves message order; the client sends one base64 payload per
  callback and never sends the same buffer twice. **Correct.**
- V-5 `responseModalities: [Modality.AUDIO]`, `inputAudioTranscription: {}`,
  `outputAudioTranscription: {}` is the documented configuration for
  native-audio text extraction. **Correct.**
- V-6 Echo cancellation/NS/AGC being *enabled* is not a code bug by itself; it is a
  quality variable that is currently hidden (A-4). It must be A/B tested, not
  assumed to help or hurt.


### 2.2 Transcription state and false suggestions

| ID | Finding | Location | Evidence / impact |
| --- | --- | --- | --- |
| T-1 | **Every `inputTranscription` is finalized, regardless of `Transcription.finished`.** The bridge forwards only `.text`; the client calls `addFinal()` for every event. | `server.ts:516-528`; `src/App.tsx:1024-1042`; `src/lib/conversation.ts:626-650` | **Confirmed code defect.** Probe with three events for one utterance (`finished:false,false,true`) produced **three** customer turns: `Hey`, `Hey can you`, `Hey, can you hear me?`. Whether the API emits such fragments for 3.8 Live is **[LIVE]**; the code is wrong either way because it discards the API’s completion flag. |
| T-2 | **Interim hypotheses replace, by design.** `setInterim()` stores one string; the UI renders one bubble. | `src/lib/conversation.ts:606-624`; `src/App.tsx:1044-1046`, `:2090-2100` | **Correct if** `interimInputTranscription.text` is a cumulative hypothesis (docs call it a “partial hypothesis”). If it is a delta, the bubble shows only the last fragment. **[LIVE]** to confirm event granularity. |
| T-3 | **Interim text is never cleared except by a non-empty final, a new session, or manual “Clear transcript”.** No clear on `interrupted`, `turn_complete`, `session_reconnecting`, `error`, `closed`, or timeout. | `src/App.tsx:1021-1046`, `:1109-1190`, `:2079-2088` | **Confirmed stale-UI defect.** After an interruption or a missed final, “Customer Speaking (Interim Hypothesis)…” can remain indefinitely. |
| T-4 | **Empty transcript events are dropped.** `if (interimInputTranscription)` / `if (inputTranscription)` means an empty text carrying `finished:true` can never clear the interim or close a customer turn. | `server.ts:503`, `:517` | **Confirmed.** This removes the API’s only explicit “end of speech” signal when the text is empty. |
| T-5 | **Output transcripts are tagged with the generation *after* `turnComplete` may have advanced it.** `handleServerMessage` processes `turnComplete` (advance) before the transcript block. | `server.ts:459-480` (advance), `:530-540` (tag) | **Confirmed.** Probe: suggestion `gen_1` completed by `turnComplete`; the same frame’s transcript was tagged `gen_2` and became the new latest suggestion containing only the tail. This splits one suggestion into a completed body plus a ghost “active” tail. |
| T-6 | **The same mis-tagging happens on `interrupted`.** Interruption advances the generation first; a transcript in that frame is tagged as the *new* generation. | `server.ts:406-427`, `:530-540` | **Confirmed.** Probe: an interrupted `gen_1` tail became a **streaming** `gen_2` suggestion, i.e. stale text promoted to “Active Recommendation”. Whether the API puts the old tail in that frame is **[LIVE]**, but the attribution logic is wrong for any transcript in that frame. |
| T-7 | **Two independent text sources append to the same suggestion ledger.** `modelTurn.parts[].text` arrives as `type: 'text'`; `outputTranscription` arrives as `direction: 'output'`. Both call `appendDelta`. | `server.ts:436-454`, `:530-540`; `src/App.tsx:1196-1214`, `:1047-1075` | **Confirmed code risk.** If both fire for the same content, the suggestion is duplicated. With `AUDIO` modality `modelTurn` should be audio-only, but this is not asserted anywhere. **[LIVE]** to rule out. |
| T-8 | **The transcript path does not check `gate.isInvalidated(genId)`**, unlike the `type: 'text'` path. | `src/App.tsx:1047-1075` vs `:1196-1199` | **Confirmed inconsistency.** A transcript for an invalidated generation can still create/append a suggestion. |
| T-9 | **`SalesSuggestionLedger.getLatest()` returns the newest entry regardless of status.** The UI renders it as “Active Recommendation” with its text even when `status === 'interrupted'` or `'completed'`. | `src/lib/conversation.ts:779-781`; `src/App.tsx:2160-2225` | **Confirmed stale-output defect.** After a barge-in, the partial interrupted suggestion remains the most prominent card (red badge), while the new utterance is being processed. It is never cleared or demoted automatically. |
| T-10 | **Customer/text dedupe is exact-adjacent-only.** `addFinal` only ignores an identical previous text within 2 s. Cumulative texts are all appended. | `src/lib/conversation.ts:626-650` | **Confirmed.** Probe T-1 shows this. No prefix/suffix reconciliation exists. |
| T-11 | **Suggestion generation does not read the displayed transcript.** The client only sends audio; the system instruction is static. The displayed transcript is a *parallel* API output, not an input to suggestion generation. | `server.ts:878-883`; `src/lib/liveConfig.ts:52-60` | **Confirmed architectural fact.** Therefore “incorrect transcript → clarification suggestion” is correlation, not causation. Both are downstream of the same misheard/truncated audio. Prompt edits cannot guarantee transcript accuracy. |


### 2.3 Interruption handling

| ID | Finding | Location | Evidence / impact |
| --- | --- | --- | --- |
| I-1 | **Local barge-in can never trigger in this build.** The server discards all model audio; the client `audio` branch returns immediately; `markPlaybackScheduled()` / `markPlaybackEnded()` are **never called anywhere**. `gate.playbackCount()` is always 0, so `shouldTriggerLocalBargeIn()` (which requires `playbackCount > 0`) is always false. | `src/App.tsx:1094-1108` (drop audio), `:1326-1345` (barge-in call); `src/lib/conversation.ts:562-573`; `grep` found zero `markPlaybackScheduled` calls | **Confirmed.** `localPlaybackCancellations` stays 0 and `interruptionTimingOutcome` is always `stopped_on_server_event`. The entire local barge-in path is dead code, not a working fallback. |
| I-2 | **Interruption is inferred only from `serverContent.interrupted`.** No action on customer speech onset, `interimInputTranscription`, or the `voice_activity` frame (the server forwards it; the client ignores it). | `src/App.tsx:1109-1155`; `server.ts:546-555`; no `voice_activity` client branch | **Confirmed.** If the server event is late or absent, the old suggestion keeps streaming/appending and stays “Active”. A new utterance can be recognized while an older suggestion remains active with no state change. |
| I-3 | **The server’s interruption de-duplication is ineffective.** The dedupe key is the *pre-advance* `currentGenerationId`; after the first event the ID has changed, so a second `interrupted` frame is a new “first observation” and advances again. | `server.ts:406-427` | **Confirmed by simulation.** Three frames produced `gen_0 → gen_1 → gen_2 → gen_3`, each with `firstObservation=true`. A duplicate/spurious event can invalidate the answer to the barge-in and split it into another generation. |
| I-4 | **Documented order `interrupted > turn_complete` makes the closing `turn_complete` name an empty generation.** The client then counts the interrupted turn as a clean completion (`wasInterrupted` is false because the ledger has no entry for the empty gen). | `server.ts:406-480`; `src/App.tsx:1156-1185`; docs quoted §4 | **Confirmed from the documented order + code.** `completedTurns` is wrong on every interrupted turn, and `turn_complete` advances again (`gen_N → gen_{N+2}` for one barge-in). |
| I-5 | **A `turn_complete` that shares its frame with model content can leave a suggestion permanently “streaming”.** Content is tagged with the current gen, then `turnComplete` advances; no later `turn_complete` will name that gen. | `server.ts:430-480` | **Confirmed conditional** (docs say `turnComplete` “can be set alongside content”). A live trace is required to see whether 3.8 Live emits content+`turnComplete` after an interruption. If it does, the UI shows “Streaming suggestions…” indefinitely. |
| I-6 | **`session_reconnecting` keeps the old suggestion/interim and drops audio mid-utterance.** | `src/App.tsx:993-1005`; `server.ts:872-876` | **Confirmed.** On a resume, the customer’s ongoing word is truncated. This is another path to a wrong transcript during a long conversation. |
| I-7 | **Interruption does not mark the sales entry when it is local.** Even if local barge-in worked, `cancelAllAssistantAudio('local_onset')` interrupts only `TurnLedger`, not `SalesSuggestionLedger`. | `src/App.tsx:474-495` vs `:1128-1138` | **Confirmed inconsistency.** The sales suggestion would remain `streaming` until the server event arrives. |
| I-8 | **`userSpeechOnsetMonoRef` is a single global timestamp**, not per-turn; it is cleared only when an output transcript arrives. If no suggestion appears, the next turn’s “latency” is measured from the previous onset. | `src/App.tsx:1317-1323`, `:1050-1054` | **Confirmed diagnostics defect.** Not a cause of wrong suggestions. |

### 2.4 Tests and diagnostics

| ID | Finding | Location | Evidence |
| --- | --- | --- | --- |
| D-1 | **No unit tests for `src/utils/audio.ts`.** No PCM/endianness/clip/resample/base64 invariants are covered. | `tests/unit/` contains only conversation, diagnostics, language, live-config | **Confirmed.** The only audio “tests” use silence or WAV fixtures in live suites. |
| D-2 | **No tests for server transcript mapping or generation attribution.** `handleServerMessage` is not exported and is coupled to a live `Session`, so it cannot be driven with synthetic `LiveServerMessage`s. | `server.ts:347-555` | **Confirmed testability defect.** The defects T-5/T-6/I-3 cannot be regression-tested today. |
| D-3 | **No tests for interim replacement, `finished`, empty transcripts, multiple utterances, or new utterance during output.** `CustomerTranscriptLedger` is tested only for simple add/dedupe. | `tests/unit/conversation.test.ts:330-380` | **Confirmed.** |
| D-4 | **`tests/live-controlled-trials.ts` is incompatible with the current no-audio build.** It waits for `msg.type === 'audio'` to count model chunks and trigger interruptions; the bridge no longer sends audio frames (server drops them). | `tests/live-controlled-trials.ts:202-232`; `server.ts:440-446` | **Confirmed.** The trial can never reach its interruption threshold; it will time out. It must be rewritten against `transcription`/`interrupted`/`turn_complete` events. |
| D-5 | **`audio_ack` is not a reliable delivery count** (every 50th; both counters set to seq). | `server.ts:884-899`; `src/App.tsx:1082-1093` | **Confirmed.** See A-6. |
| D-6 | **The diagnostics “Mic Captured” equals “Mic Sent”**, so drops before send and drops at the bridge are invisible. | `src/App.tsx:1368-1380` | **Confirmed.** See A-1. |
| D-7 | **No raw transcript event log.** The export contains rendered entries and diagnostic events, not the raw `{interim/final/finished/languageCode/text}` sequence, so T-1/T-2 cannot be diagnosed from a user report. | `src/lib/diagnostics.ts:23-35` | **Confirmed.** |


---

## 3. End-to-end trace of one hypothetical utterance

Utterance: the customer says “Hey” approximately 300 ms after pressing Start.

1. **Start.** `startConversation` resets ledgers/generation, calls
   `obtainMicrophoneStream()` (`App.tsx:878-900`) and then constructs
   `AudioContext({sampleRate:16000})` (`:902-916`). It opens the bridge WebSocket
   and sends `{type:'start'}` in `onopen` (`:936-955`).
2. **Capture.** Immediately after assigning handlers, it creates
   `createMediaStreamSource(stream)` and `createScriptProcessor(512,1,1)` and connects
   them (`:1288-1390`). The first `onaudioprocess` event can fire before the Gemini
   session exists. Each callback computes RMS for the UI, optionally triggers local
   barge-in (impossible here, I-1), then `resampleTo16k(inputData, inputCtx.sampleRate)`,
   `floatTo16BitPCM`, `uint8ToBase64`, and `ws.send({type:'audio', audio})`
   (`:1347-1372`).
3. **Bridge.** `handleAudioFrame` increments `micChunksReceived`; if
   `!ctx.gemini || !ctx.active`, it increments `micChunksDropped` and **returns
   without forwarding** (`server.ts:864-876`). `ctx.active` becomes true only in the
   `setupComplete` branch (`:349-361`). So any “Hey” audio during connection setup is
   discarded. No frame is sent to the client to say so.
4. **Once ready.** `sendRealtimeInput({audio:{data, mimeType:'audio/pcm;rate=16000'}})`
   forwards the remaining chunks (`server.ts:878-883`). Gemini’s automatic VAD
   buffers speech with prefix padding and, when the speech turn ends, emits
   `interimInputTranscription` events while speaking and an
   `inputTranscription` when the speech turn finishes (documented, §4).
5. **Bridge transcript mapping.** `handleServerMessage` forwards
   `interimInputTranscription.text` with `isFinal:false` (`server.ts:502-514`) and
   `inputTranscription.text` with `isFinal:true` (`:516-528`). It ignores
   `Transcription.finished`, `languageCode`, and empty text. Both are sent with
   `direction:'input'`, no generation, no session-turn ID.
6. **Client transcript.** For `isFinal:false`, `customerLedgerRef.setInterim(text)`
   replaces the hypothesis and renders one bubble (`App.tsx:1044-1046`). For
   `isFinal:true`, `addFinal(text)` appends a new customer turn, clears the interim,
   and logs “Customer utterance finalized” (`:1024-1042`). If the API sent three
   cumulative pieces with only the last `finished:true`, the UI now shows three
   customer turns (T-1 probe).
7. **Suggestion generation.** Independently, the model (native audio) responds to
   the audio. Its output transcription arrives as `direction:'output'`; the bridge
   tags it with `ctx.currentGenerationId` (`server.ts:530-540`). The client appends it
   to `SalesSuggestionLedger` under that generation (`App.tsx:1047-1075`) and renders
   it as “Active Recommendation” (`:2144-2225`).
8. **Turn completion.** `turnComplete` is forwarded with the *pre-advance* gen,
   then the bridge advances (`server.ts:459-480`). The client completes that sales
   entry and advances the gate (`App.tsx:1156-1195`). If an output transcript shared
   the frame, it was tagged with the new gen and becomes a ghost suggestion (T-5).
9. **Next utterance / barge-in.** The only invalidation is the server `interrupted`
   event (`App.tsx:1109-1155`). The local VAD path cannot invalidate anything (I-1).
   The old suggestion remains the newest ledger entry until the server event arrives,
   and it remains displayed even after it is marked `interrupted` (T-9).

The customer’s “Hey” therefore has two independent ways to be wrong in the UI:
the **audio can be truncated before Gemini hears it** (step 3), and the **transcript
event can be mis-segmented or mis-rendered** (steps 5–6). The suggestion text is
generated from the audio, not from the displayed transcript (T-11).


---

## 4. Official API behavior vs application assumptions

### 4.1 Documented (quotable)

- **Audio format.** “Audio data in the Live API is always raw, little-endian, 16-bit
  PCM. Audio output always uses a sample rate of 24 kHz. Input audio is natively
  16 kHz, but the Live API will resample if needed so any sample rate can be sent.
  To convey the sample rate of input audio, set the MIME type ... to a value like
  `audio/pcm;rate=16000`.” (Gemini Live guide.)
- **3.8 Live chunking.** “Input audio: 16 kHz, 16-bit, little-endian, mono PCM
  (`audio/pcm;rate=16000`), streamed in chunks of 20 ms to 100 ms. Output audio:
  24 kHz mono PCM.” (Gemini 3.8 Live developer guide.)
- **Response modality.** Native-audio models only support `AUDIO`. “If you need the
  model response as text, use the output audio transcription feature.” (Capabilities
  guide.) This confirms the current `responseModalities:[AUDIO]` + both transcription
  settings design; it is not a workaround.
- **Language.** “Native audio output models automatically choose the appropriate
  language and don't support explicitly setting the language code.” (Capabilities
  guide.) Language can be constrained in the system instruction for *speech*, but
  this does not configure the input transcription decoder.
- **VAD / interruption.** “By default, the model automatically performs VAD on a
  continuous audio input stream.” “When VAD detects an interruption, the ongoing
  generation is canceled and discarded. Only the information already sent to the
  client is retained in the session history. The server then sends a
  `BidiGenerateContentServerContent` message to report the interruption.”
  `serverContent.interrupted` is the signal. An interrupted turn goes
  `interrupted > turn_complete` (documented in the capabilities guide).
- **VAD parameters.** `prefixPaddingMs` is a look-back that “ensures the model
  captures the full onset of speech, including the first syllable which may start
  before the VAD triggers. A value of 0 may cause the beginning of words to be
  clipped.” `silenceDurationMs` default is approximately 800 ms; values of
  100–200 ms split one utterance into fragments and “result in lower transcription
  and response quality.” The app sets neither (defaults apply), which is acceptable
  for automatic VAD but means the app cannot tune onset clipping.
- **Paused stream.** “When the audio stream is paused for more than a second ... an
  `audioStreamEnd` event should be sent to flush any cached audio.”
- **Transcription semantics.** The Live transcription guide documents
  `server_content.interim_input_transcription` as “Low-latency, interim partial
  transcription hypothesis emitted continuously while the user is actively
  speaking” and `server_content.input_transcription` as “Finalized, authoritative
  input transcript emitted when a speech turn finishes.” The SDK’s `Transcription`
  type also has `finished?: boolean` (“The bool indicates the end of the
  transcription”), `languageCode?`, and `speakerLabel?`.
- **Event composition.** “A single server event can contain multiple content parts
  simultaneously (e.g., audio chunks and transcript). Always process all parts.”
  `turnComplete` “can be set alongside `content`, indicating that the `content` is
  the last in the turn.”
- **3.8 Live specifics.** Proactive audio and affective dialogue are enabled by
  default; `custom_vocabulary` is supported in `AudioTranscriptionConfig` for 3.8
  Live; barge-in behavior is described as a “polite interruption downgrade (waits
  when user speaks)” for tool-response scheduling. Audio-only sessions are limited
  to 15 minutes; context window 128k.

### 4.2 Application assumptions that are not documented

- That `inputTranscription` arrives exactly once per customer turn (T-1).
- That `interimInputTranscription.text` is a cumulative hypothesis rather than a
  delta (T-2).
- That a transcript present in an `interrupted` frame belongs to the *new*
  generation (the server comment at `server.ts:341-345` asserts this; it is not
  documented).
- That `interrupted` is delivered promptly/always when the customer speaks during
  generation in 3.8 Live. The docs say VAD cancels and reports, but the 3.8 Live
  “polite interruption” behavior and always-on proactive audio must be observed
  live.
- That browser AEC/NS/AGC improve ASR accuracy. They are quality variables, not
  documented requirements; the official best practice is to test with headphones.
- That a 512-sample ScriptProcessor is always 32 ms. It is only true at 16 kHz.


---

## 5. “Hey” → “school”: ranked hypotheses

No hypothesis below can be promoted to fact without a live session. The ranking is
by strength of code/documentation evidence, not by acoustic measurement.

### H1 — Most likely: the word did not reach the model intact (onset/session loss)

Evidence:

- The microphone is captured and sent **before** `setupComplete`; the bridge drops
  every chunk until `ctx.active` (`server.ts:872-875`). The client starts the
  processor immediately after opening the WebSocket (`App.tsx:1288-1390`) and sends
  as soon as `readyState === OPEN` (`:1358-1372`). The UI’s “ready” state
  (`setIsMicStreaming(true)` at `:989`) is cosmetic; it does not gate capture.
- Mic drops are uncounted on the client (A-1/A-6). The user cannot tell whether the
  word was truncated.
- On every reconnect (`session_reconnecting`), audio is dropped again until the
  resumed session reaches `setupComplete` (I-6).
- A one-word utterance has no linguistic context to recover from a missing onset.
  The docs stress that `prefixPaddingMs` exists specifically to avoid clipping the
  first syllable; VAD cannot recover audio that was never sent.
- The same failure is reproduced deterministically in code for the first utterance:
  any `onaudioprocess` event before `setupComplete` is discarded.

This is the highest-evidence explanation because it is a confirmed code path that
removes audio before the ASR model sees it, and it disproportionately affects a
short greeting at the start of a session.

### H2 — Browser microphone DSP and unknown device configuration

Evidence:

- `echoCancellation`, `noiseSuppression`, `autoGainControl` are all forced true
  (`App.tsx:642-649`); `track.getSettings()` is never read, so the session export
  cannot say whether they were applied or what they did (A-4).
- Noise suppression/AGC are adaptive filters. They can attenuate breathy onsets
  (“h”) and pump up room noise, which is exactly the kind of change that turns an
  isolated “hey” into a different short word.
- The official 3.8 Live best-practice list says to test with headphones, implying
  that acoustic/DSP conditions materially affect behavior.
- The app never selects a device; the OS default may be an array mic, a virtual
  device, or a Bluetooth hands-free endpoint with a low-quality codec.

This is a strong second cause but requires an A/B recording to quantify. It is not
a code “bug” in the sense of a wrong format; it is an uncontrolled input variable.

### H3 — ASR language ambiguity / no input-language hint

Evidence:

- `buildLiveConfig` sends `inputAudioTranscription: {}` (`liveConfig.ts:175`). No
  `languageCodes`, no `customVocabulary`.
- The app deliberately omits `speechConfig.languageCode` for native-audio models
  (`liveConfig.ts:179-181`, docs quoted §4), so the only language control is the
  system instruction, which affects the model’s *spoken output*, not the input
  transcription decoder.
- 3.8 Live performs dynamic multilingual detection. A single short English word is
  a weak signal; the decoder may choose another language or a phonetically nearby
  word.
- The `Transcription` message exposes `languageCode`, but the bridge drops it
  (`server.ts:516-528`), so the user cannot see which language was detected.

This is a plausible direct cause of an unexpected English word or a word from
another language. It is testable by logging `languageCode` and by repeating the
same utterance with `languageCodes:['en-US']` (if 3.8 Live honors it — see §8).


### H4 — Fallback resampling path (only if the 16 kHz context was rejected)

Evidence:

- `new AudioCtx({sampleRate:16000})` is wrapped in try/catch; on failure the default
  rate is used (`App.tsx:902-916`). Nothing logs which branch ran.
- At 32/44.1/48 kHz the same 512-sample buffer yields 16/11.6/10.7 ms chunks, below
  the documented 20–100 ms; the per-chunk resampler skips input samples and injects
  a boundary discontinuity at every chunk (measured: 62/93 boundaries > 0.1, max
  0.259 on a 1 kHz tone).
- The model is told the stream is 16 kHz and will resample internally; a slightly
  fast stream (0.19 %) plus periodic discontinuities is a quality degradation, not
  a wholesale corruption.

This cannot explain a gross substitution by itself, but it compounds H1/H2 and is
easy to rule out with one diagnostic line. Rank it fourth until the runtime rate is
known.

### H5 — Intrinsic ASR ambiguity for a 200–400 ms isolated word

Evidence:

- Input transcription is a separate API output (“The transcription is independent to
  the model turn which means it doesn’t imply any ordering between transcription and
  model turn” — SDK type comment).
- Short interjections are inherently ambiguous without context; the decoder has no
  way to know the speaker meant “hey” rather than a phonetically similar word.
- The system instruction’s sales vocabulary may bias the model’s language model,
  but it cannot guarantee acoustic decoding. Prompt changes cannot fix this.

This is a real floor on accuracy, not an app defect. It should be measured with a
fixed phrase set (e.g., “Hey”, “Hello”, “Testing one two three”) and repeated trials,
not inferred from one session.

### H6 — Display-only artifact: the interim hypothesis is shown as if it were the final

Evidence:

- The UI shows a single interim bubble that is replaced by each new hypothesis
  (`App.tsx:1044-1046`, `:2090-2100`). If `interimInputTranscription.text` is a delta
  rather than a cumulative hypothesis, the bubble would show only the newest
  fragment (e.g. “school”) and the user might read that as the transcript.
- Every `inputTranscription` is appended as a final customer turn (T-1); cumulative
  fragments would produce several turns, one of which might contain the odd word.

This affects what is *displayed*, not what the model heard. It must be separated
from H1–H5 by logging the raw event stream (§10.2). Rank it last for the “wrong word”
symptom but first for “the transcript looks wrong/duplicated in the UI”.

### What is *not* supported by the evidence

- A wrong PCM format, wrong endianness, interleaving, or wrong MIME type: all were
  checked and are correct (V-1..V-3).
- Dropped or duplicated chunks at the WebSocket level: the client sends once per
  callback and WebSocket preserves order; no duplicate send exists.
- Clipping: `floatTo16BitPCM` clamps; no gain stage exists that could exceed ±1.
- A prompt-only fix for transcription accuracy: the suggestion model and the input
  transcription are separate outputs; the system instruction does not configure ASR.


---

## 6. The interruption failure mechanism

### 6.1 Exact sequence in the current code

Assume the model is streaming suggestion text under `gen_1` and the customer starts
speaking (a new utterance) mid-stream.

1. `onaudioprocess` sees RMS > 0.025 for three frames. It calls
   `shouldTriggerLocalBargeIn({ playbackCount: gateRef.current.playbackCount(), ... })`
   (`App.tsx:1326-1345`). `playbackCount()` is 0 because no audio was ever scheduled
   (I-1). The function returns false. **Nothing local happens.** Audio continues to
   Gemini; the suggestion continues to append.
2. Gemini’s automatic VAD detects the speech, cancels generation, and sends
   `serverContent.interrupted` (documented). The bridge:
   - captures `interruptedGen = ctx.currentGenerationId` (`gen_1`),
   - adds it to `interruptedGenerations` and increments the counter,
   - calls `nextGeneration()` → `gen_2`,
   - sends `{interruptedGenerationId:'gen_1', nextGenerationId:'gen_2'}`.
3. The client `interrupted` handler marks the sales entry `gen_1` as `interrupted`,
   advances the gate to `gen_2`, and leaves `getLatest()` = the interrupted entry.
   The UI keeps its text on the “Active Recommendation” card with a red
   “Interrupted” badge (T-9). There is no clearing, no collapse, no “waiting for new
   input” placeholder.
4. Per the documented order, the interrupted turn is closed by a following
   `turn_complete`. The bridge now names `completedGen = gen_2` (the empty
   generation) and advances to `gen_3`. The client’s `ledgerRef.get(gen_2)` is null,
   so `wasInterrupted` is false; `completedTurns` is incremented and the state goes
   back to “ready”. **An interrupted turn is recorded as a clean completion.**
5. The model’s answer to the new utterance streams under `gen_3`. Its first output
   transcript creates a new suggestion. If the customer speaks again before that
   answer finishes, the cycle repeats.
6. If a duplicate `interrupted` frame arrives (I-3), it is treated as a new
   interruption of `gen_2` and advances to `gen_3` again, potentially marking the
   *answer* as interrupted and splitting it.

### 6.2 The distinct failure modes

**F1 — No local fallback (confirmed).** Because playback is disabled, the app has
no way to react to the customer’s onset. The 3.8 Live server event is the only
switch. Any latency or omission in that event leaves the old suggestion streaming
and visible. This is structural, not a race.

**F2 — Generation misattribution around `turn_complete` (confirmed).** The bridge
advances the generation before reading transcripts and again on the closing
`turn_complete`. Consequences:

- the closing event names a generation with no content;
- `completedTurns` is wrong;
- output transcript text in the same frame is tagged to the next generation
  (ghost suggestion, or a stale tail promoted to active);
- if content also shares the frame, the content’s generation is never completed
  (permanently “streaming”, I-5).

**F3 — Duplicate/spurious interruption frames (confirmed code, live likelihood
unknown).** The dedupe key changes after each advance, so duplicates are not
deduped. A duplicate can invalidate the new answer and skip generations.

**F4 — Model-side interruption policy (live).** 3.8 Live documents a “polite
interruption downgrade” and always-on proactive audio. If the server waits for the
user to finish before emitting `interrupted` (or does not emit it for speech it
classifies as background), F1 becomes directly observable: the suggestion keeps
growing while the customer talks. This cannot be confirmed without a real session
that logs `interimInputTranscription`, `interrupted`, and `turn_complete` timestamps.

### 6.3 Can a new utterance be recognized while an older suggestion is active?

Code answer: **yes, audio is always captured and sent** (continuous mic is
intentional), but **the UI/ledger does not treat it as a new turn** until either a
server `interrupted` or a server `turn_complete` arrives. There is no
customer-utterance epoch in the client state. `interimInputTranscription` is
rendered but has no effect on the suggestion ledger. `voice_activity` frames are
received by the bridge and ignored by the client. Therefore the answer is: audio
recognition can begin, but the application cannot represent “new utterance while
old suggestion is active” in its state machine.


---

## 7. Recommended deterministic transcription policy

The goal is a policy that never invents confidence and never turns a hypothesis into
a turn. Use only API-provided signals: `Transcription.finished`, `text`,
`languageCode`, and the documented turn/interruption events.

1. **Treat `interimInputTranscription` as provisional, always.**
   - Replace the single interim string (last-write-wins).
   - Never append it to the finalized customer history.
   - Never let it create a customer turn or a suggestion generation.
   - If `finished === true` arrives on an interim message, treat it as “speech turn
     ended” and clear/promote the interim, but still do not append until an
     `inputTranscription` or an explicit end-of-turn signal arrives.
2. **Commit a customer turn only on a terminal final.**
   - Primary rule: `inputTranscription.finished === true` → commit.
   - If `finished` is absent (older SDK/API), use a deterministic text relation:
     - identical to the last final → ignore;
     - extends the last final (prefix match) and belongs to the same speech run →
       **replace** the last entry, not append;
     - otherwise → append as a new turn.
   - Do not use a fabricated confidence score; no such field exists.
3. **Define a speech-run/epoch in the client.**
   - Increment `utteranceEpoch` on the first interim of a new run (after silence or
     after a final) and on every committed final.
   - Tag all transcript events with the epoch at receipt; drop any event whose epoch
     is stale. This makes “interim replaces interim” and “final replaces its own
     interim” deterministic across reconnects.
4. **Clear interim deterministically** on: a committed final, `interrupted`,
   `turn_complete` for the active generation, `session_reconnecting`, `error`,
   `closed`, and a silence timeout derived from the documented VAD behavior (e.g.
   1.5–2× the default `silenceDurationMs`). The timeout is a UI cleanup, not a
   transcription confidence claim.
5. **Never let a transcript update create a new generation.** Generations belong to
   model output turns only. A customer transcript may set a `pendingCustomerTurn`
   flag, but the generation is created by model content/interruption/turn_complete.
6. **Output transcripts must be attributed to the generation that was active at the
   start of the server frame**, before `turnComplete`/`interrupted` processing. If
   the frame is an interruption frame, prefer dropping (or quarantining) the
   transcript rather than creating a suggestion for the next generation. If the
   frame is a `turn_complete` frame, append to the completed generation before
   advancing.
7. **Display state.**
   - `streaming` = receiving output text for the current generation.
   - `completed` = `turn_complete` received for that generation.
   - `interrupted` = `interrupted` received for that generation.
   - On the first interim of a new customer utterance, demote the current
     `streaming` suggestion to `stale` (visible but not “Active”), and stop
     promoting its updates. This uses the API’s own speech signal, not a confidence
     score.
8. **Empty text events are meaningful.** Forward `{text:'', finished:true}` as an
   explicit end-of-speech event instead of dropping it, so the client can clear the
   interim without inventing text.


---

## 8. Minimal recommended fixes, ordered by expected impact / risk

No fix is applied in this phase. “Minimal” means the smallest change that makes the
failure observable or removes a specific confirmed defect; it does not change the
model, the AUDIO response modality, the text-suggestion path, or continuous capture.

| Order | Fix | Addresses | Impact | Risk | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | **Add audio/transcript observability first (no behaviour change).** Log `inputCtx.sampleRate`, `track.getSettings()` (sampleRate, channelCount, AEC/NS/AGC, deviceId/label), real chunk duration, callback interval, bytes/sec; forward bridge `micChunksReceived/Forwarded/Dropped` and `Transcription.finished/languageCode`; keep a small raw-event ring buffer in diagnostics. | A-2, A-4, A-6, D-5, D-6, D-7, T-1/T-2 diagnosis | Very high (makes the rest measurable) | Very low | Do this before any behavioural change; it also distinguishes H1–H6. |
| 2 | **Gate mic forwarding until `session_ready`** (or buffer at most ~1 s and flush on ready), and count `chunksBeforeReady` as dropped. Stop capture/sending on `session_reconnecting` or mark a gap; never silently splice across a reconnect. | A-1, I-6 | High for first-utterance accuracy | Low | The user can still speak immediately; the app just does not discard the onset. Buffering ≤1 s keeps memory bounded; do not replay stale audio. |
| 3 | **Make the capture chunk 20–100 ms at the actual rate** (choose `bufferSize` from `inputCtx.sampleRate`, or force/assert 16 kHz and fail visibly if unsupported). If resampling is needed, use a stateful resampler that carries phase and a fractional-sample remainder across chunks. | A-2, A-3 | Medium (only if fallback occurs) | Low | At 16 kHz, 512 is already compliant; this prevents the silent fallback from violating the documented range. |
| 4 | **Honour `Transcription.finished` and stop treating every input event as a turn.** Commit on `finished:true`; otherwise treat as interim/provisional. Forward `finished` and `languageCode`; forward empty terminal events. Clear interim on the deterministic triggers from §7. | T-1, T-3, T-4, T-10 | High for duplicate/stale customer turns | Medium | Add a client speech-run epoch; do not fabricate confidence. |
| 5 | **Snapshot the generation at frame entry and use it for all content/transcripts.** Process `turnComplete`/`interrupted` after the content of that frame (or explicitly assign the pre-advance gen to the frame’s transcript). Do not create a suggestion for a transcript that belongs to an interrupted generation. | T-5, T-6, T-8, I-5 | High for ghost/stale suggestions | Medium | This is the core ordering fix; it must be covered by synthetic event-sequence tests. |
| 6 | **Make interruption bookkeeping idempotent.** Track a per-turn `interrupted` flag; ignore repeated `interrupted` frames until new model content starts. Do not advance twice for `interrupted` + closing `turn_complete`; record the closing completion against the interrupted turn. | I-3, I-4 | High for diagnostics and generation numbering | Medium | Aligns with the documented `interrupted > turn_complete` order. |
| 7 | **Demote/retire stale suggestions on a new customer utterance.** On the first interim/voice-activity of a new run, mark the active suggestion `stale`/demote it from the “Active Recommendation” slot; do not append new output to a stale entry. | T-9, I-2, §7.7 | High for the visible “old suggestion during new speech” problem | Medium | Purely client display/ledger state; no model change. |
| 8 | **Optional transcription configuration.** If a language is locked, test `inputAudioTranscription: { languageCodes: [code] }` (verify 3.8 Live honors it; the 3.8 Live guide explicitly documents `custom_vocabulary`, not `languageCodes`). Add `customVocabulary` for known product/SKU terms. | H3, domain accuracy | Medium if supported | Low–medium | Do not assume it works; A/B it. This is not a prompt-only accuracy fix. |
| 9 | **A/B the browser DSP.** Run paired trials with `echoCancellation/noiseSuppression/autoGainControl` true vs false (and with a fixed device) while logging the raw PCM. Keep the better setting per environment; record it in diagnostics. | H2 | Medium–high if DSP is the cause | Low–medium | Do not change the default before the A/B; the current settings may be helping in some rooms. |
| 10 | **Fix live trial + diagnostics assertions.** Rewrite `tests/live-controlled-trials.ts` to trigger on `transcription`/`turn_complete` instead of `audio`; make `audio_ack` gap-aware and expose per-direction counters. | D-4, A-6, D-5 | Medium (restores the only live interruption harness) | Low | The current trial cannot run in this architecture. |
| 11 | **Send `audioStreamEnd` on pause/teardown.** | A-7 | Low–medium | Very low | Flushes cached VAD audio; especially if capture is ever paused without closing the socket. |
| 12 | **Decide whether 512-sample `ScriptProcessor` remains acceptable.** Keep it (constraint) but add a callback-cadence watchdog; if gaps exceed 1.5× expected, surface a “capture glitch” counter. | A-5, main-thread jank | Medium observability | Low | Do not migrate to AudioWorklet in this phase; the constraint says no architecture change. |

Explicitly **not** recommended in this phase:

- Changing the model, adding another model, or switching to `responseModalities:[TEXT]`
  (3.8 Live native audio rejects it).
- Re-enabling audio playback or removing continuous capture.
- Relying on prompt wording to fix ASR accuracy.
- Adding a fabricated transcript “confidence” score; none is provided.


---

## 9. Tests required for each proposed fix

The current suite (`npm test`, 55 passing) covers the gate/ledgers/config but none of
the transcript-mapping or audio-format paths. Proposed tests are split by whether
they can run offline (deterministic, no mic/API) or need **[LIVE]**.

| Fix | Offline tests to add | Live test needed? |
| --- | --- | --- |
| 1 Observability | Pure `buildAudioDiagnostics(inputCtx, trackSettings, callbackStats)` test: exact fields, no credentials, redaction. Assert `measuredChunkDurationMs === 512/rate*1000` for 16k/44.1k/48k. | No for the report shape; yes to validate real `getSettings()` values. |
| 2 Ready gate | Fake `MicGate` state machine: chunks before `ready` are counted and not forwarded; a ≤1 s buffer flushes in order; a reconnect creates a gap and never splices; `audioStreamEnd` emitted on stop. | Yes: first-utterance “Hey” with/without the gate, 20 repetitions, compare transcripts. |
| 3 Chunk geometry | `planChunkSize(rate, minMs=20, maxMs=100)` table test (16k→512 ok; 32k/44.1k/48k must choose 1024/1024/2048 or equivalent). Resampler invariants: total output length within ±1 sample per second; a 1 kHz tone has no boundary jump > the normal adjacent step; continuity across chunk joins. | Yes: log the actual `inputCtx.sampleRate` and chunk count per second. |
| 4 Transcript finalization | Table tests for: interim replaces; `finished:false` never commits; `finished:true` commits once; empty `finished:true` clears interim; three cumulative finals produce one entry; identical final within/after 2 s; two separate utterances produce two entries; prefix-extension replaces. | Yes: raw event trace (interim/final/finished/languageCode) for a known phrase. |
| 5 Generation attribution | Synthetic server frames: `turnComplete` + `outputTranscription` in one frame → text stays with the completed gen; `interrupted` + transcript → no new suggestion; `modelTurn` + `interrupted` + `turnComplete` → no permanently streaming entry; late transcript for a completed gen is dropped or appended to that gen, never the next. | Yes: observe whether 3.8 Live actually co-emits content/transcript with `turnComplete`/`interrupted`. |
| 6 Interruption idempotency | Replay `interrupted, turn_complete, interrupted(dup)` and assert: one generation advance per turn; duplicate ignored; closing completion attributed to the interrupted gen; `completedTurns` not incremented for an interrupted turn. | Yes: count real `interrupted`/`turn_complete` frames per barge-in. |
| 7 Stale suggestion demotion | Ledger/UI state test: first interim of a new run demotes the active streaming entry; new output does not append to the stale entry; the stale entry remains in history but not as “Active”. | Yes: visual/state trace during a barge-in. |
| 8 Transcription config | `buildLiveConfig` test: locked language → expected `inputAudioTranscription.languageCodes` **only if** the 3.8 Live behavior is confirmed; custom vocabulary is passed through. | Yes A/B: same phrase with/without the hint; compare transcript + `languageCode`. |
| 9 DSP A/B | None offline (browser API). | Yes: paired recordings (DSP on/off, same device/phrase), transcript WER and raw PCM comparison. |
| 10 Trial harness | Unit-test the rewritten trial state machine with a fake WebSocket emitting synthetic frames; assert it triggers on `transcription`/`turn_complete`, not `audio`. | Yes: run the trial end-to-end with a key. |
| 11 `audioStreamEnd` | Fake socket test: on stop/pause a frame `{audioStreamEnd:true}` is sent once; no audio follows until resumed. | Yes: confirm the server flushes the cached turn. |
| 12 Cadence watchdog | Pure stats test: given callback timestamps, detect gaps > 1.5× expected and produce a counter; no false positives on normal jitter. | Yes: observe real callback gaps under UI load. |

Existing tests that should be extended rather than duplicated:

- `tests/unit/conversation.test.ts` — already covers the gate, turn ledger and basic
  customer/sales ledgers. Add the transcript-policy and generation-attribution cases
  there (or in a new `tests/unit/transcript-policy.test.ts`).
- `tests/unit/live-config.test.ts` — asserts the current empty transcription config;
  extend only after fix 8 is validated live.
- `tests/bridge-protocol.test.ts` — good transport contract, but it cannot inject
  Gemini frames. Extract the frame handler into a pure function and test it directly;
  do not weaken the no-key protocol tests.
- `tests/live-controlled-trials.ts` — currently unusable (D-4); rewrite it before
  claiming any interruption measurement.


---

## 10. Additional live diagnostics needed (mic vs transport vs model)

Run these with `npm run dev`, a key, headphones, and a quiet room. Record timestamps
on the client and the bridge.

### 10.1 Capture / transport

1. **Log the negotiated audio graph** at start:
   `inputCtx.sampleRate`, `inputCtx.baseLatency`, `inputCtx.state`,
   `track.getSettings()` (sampleRate, channelCount, echoCancellation,
   noiseSuppression, autoGainControl, deviceId), `track.label`.
2. **Log per-second capture stats**: callbacks/s (expected 31.25 at 16k/512),
   mean/max callback interval, bytes/s (expected 32,000 B/s for 16k s16le), and
   frames with all-zero samples. A gap > 1.5× expected indicates main-thread jank or
   a suspended context.
3. **Log bridge counters**: received, forwarded, dropped-before-ready,
   dropped-after-close, and seq gaps. Compare client sent vs bridge received. This
   separates mic/UI loss, WebSocket loss, and bridge drops.
4. **Dump the exact PCM sent** (ring buffer, last 5–10 s) behind a debug flag. Save as
   WAV and listen to it. This is the only way to know whether “Hey” left the browser
   intact; do not claim acoustic quality without it.
5. **Record the system output** (or use a loopback) once to confirm the
   ScriptProcessor→destination connection is silent (A-9).

### 10.2 Distinguishing the layers

- **Offline re-transcription:** feed the dumped PCM to the same model (or
  `gemini-3.5-transcribe-live`) outside the live session. If it transcribes “Hey”
  correctly, the capture is fine and the live path/transport/VAD is at fault. If it
  also says “school”, the capture/DSP or the model’s ASR is at fault.
- **Fixture through the bridge:** send a known-good 16 kHz WAV fixture through the
  same `/api/live-ws` path (bypassing the mic). If the fixture transcribes
  correctly, the bridge/format is fine and the microphone path is implicated; if
  not, the bridge/streaming is implicated.
- **Raw transcript trace:** log every `interimInputTranscription` and
  `inputTranscription` with `finished`, `languageCode`, `text`, and the UTC/mono
  timestamp. This distinguishes T-1/T-2/H6 from H1–H5.
- **Timeline:** log `start`, `session_ready`, first voiced frame, first forwarded
  chunk, first interim, first final, `interrupted`, `turn_complete`, `generation`.
  If the first voiced frame precedes `session_ready`, H1 is confirmed for that trial.
- **AI Studio comparison:** run the same phrase in Google AI Studio (Live) with the
  same model and a known-good mic. A correct transcript there but not here points to
  the app/transport; a wrong transcript in both points to capture/ASR.
- **Language check:** repeat “Hey” with the app language set to English vs Auto, and
  inspect `languageCode` in the raw transcript. If the decoder picks a non-English
  language, H3 is confirmed.
- **DSP A/B:** same phrase/device, DSP on vs off, 20 repetitions each; compare the
  raw PCM and the transcript. This is the only way to attribute H2.

### 10.3 Interruption / transcript-state trace

For three barge-in trials (early, mid, late), log:

- customer onset mono time (local RMS) and interim transcript timestamps;
- every `interrupted` frame (`interruptedGenerationId`, `nextGenerationId`,
  duplicate?);
- every `turn_complete` (`completedGenerationId`, `nextGenerationId`);
- every output transcript (`generationId`, text) and the sales ledger status;
- client active generation, `getLatest()` generation/status/text, and
  `completedTurns`.

Acceptance observations:

- one generation advance per interruption, not two;
- no output transcript assigned to the empty post-interrupt generation;
- no suggestion remains `streaming` after its turn is closed;
- the interrupted suggestion is demoted/cleared when the new utterance starts;
- `completedTurns` does not increment for an interrupted turn;
- `micChunksDropped` during reconnect is visible and bounded.


### 10.4 Things that cannot be concluded from this environment

- Whether the 16 kHz `AudioContext` was actually used in the user’s browser.
- Whether AEC/NS/AGC helped or hurt.
- Whether `inputTranscription` is emitted once per turn or in fragments for 3.8
  Live.
- Whether 3.8 Live emits `interrupted` promptly/always during customer speech.
- Whether content/transcript co-occurs with `turnComplete`/`interrupted`.
- Any acoustic quality or word-error-rate claim.

These require the live session described above.

---

## 11. Verification status and open questions

| Item | Status |
| --- | --- |
| PCM signedness/endianness/clipping/base64 | **Verified offline** (probe). Correct. |
| Mono / no interleaving | **Verified by code.** Correct. |
| MIME type / sample-rate declaration | **Verified by code.** Correct. |
| WebSocket ordering / duplicate sends | **Verified by code.** Correct. |
| 20–100 ms chunk compliance at 16 kHz | **Verified by arithmetic.** 32 ms. Compliant. |
| 20–100 ms chunk compliance on fallback | **Verified by arithmetic.** 10.7–16 ms. Non-compliant if fallback occurs; runtime occurrence **[LIVE]**. |
| Chunk-boundary resampling distortion | **Measured offline.** Real if fallback occurs; inaudible if 16 kHz. |
| Output transcript mis-tagging on `turnComplete`/`interrupted` | **Confirmed by code + ledger probe.** |
| Duplicate interruption frames advancing generations | **Confirmed by simulation.** Live frequency **[LIVE]**. |
| Local barge-in dead in no-audio mode | **Confirmed by code (`grep`).** |
| Stale suggestion remains latest after interruption | **Confirmed by code/UI.** |
| Interim never cleared on interruption/timeout | **Confirmed by code.** |
| `finished` / `languageCode` ignored | **Confirmed by code + SDK types.** |
| Actual mic sample rate / DSP / device | **[LIVE]** |
| Event granularity (interim delta vs cumulative; final once vs fragments) | **[LIVE]** |
| Interruption latency/omission on 3.8 Live | **[LIVE]** |
| Acoustic quality / WER | **[LIVE]** |

### Open questions that determine the next code change

1. **Did the first “Hey” arrive before `session_ready`?** If yes, fix 2 is the first
   behaviour change to make. The current diagnostics cannot answer this; add the
   timeline log.
2. **What is `inputCtx.sampleRate` in the failing browser?** If 16k, H4 is out and
   H1/H2/H3 remain. If not 16k, fix 3 is also required.
3. **How many `inputTranscription` events arrive for one utterance, and do they carry
   `finished`/`languageCode`?** This decides the exact transcript policy and whether
   T-1 is causing duplicate turns in production.
4. **Does `interrupted` arrive before or after the customer’s first interim?** This
   determines how much local staleness the UI must handle and whether F4 is real.
5. **Does a server frame ever contain content + `turnComplete` + transcript
   together?** This determines whether I-5 is a live bug or only a latent one.

Until these are answered, any change to transcription handling or interruption
semantics is speculative. The observability fix (order 1) and the ready-gate fix
(order 2) are the only changes that are justified by code evidence alone (A-1/A-4/A-6
and the documented onset-clipping behavior), and even they should be validated with
the live timeline before touching the transcript policy.

---

## 12. Bottom line

- Keep the model, architecture, AUDIO modality, both transcription settings, text
  suggestions, no-playback, and continuous capture.
- The “Hey” → “school” symptom is **most consistent with audio truncation before
  Gemini hears the word**, with browser DSP and language ambiguity as strong
  co-factors. It is **not** explained by a wrong PCM format; that was checked and is
  correct. The fallback resampler is a real but lower-ranked factor that is currently
  invisible.
- The interruption problem is **structural**: local barge-in cannot fire, so the app
  has no way to react to a new customer utterance while a suggestion is streaming;
  it depends entirely on the server `interrupted` event, and the generation
  bookkeeping around `turn_complete`/duplicate interruption frames is wrong.
- Fix observability first, then gate the mic on session readiness, then correct
  transcript finalization and generation attribution. Do not tune prompts or swap
  models to compensate for a pipeline/state defect.
- No fix should be merged without the offline tests in §9 and the live trace in §10,
  because the event granularity and interruption timing of 3.8 Live are still
  unverified in this environment.

