import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import {
  INITIAL_GENERATION_ID,
  resolveLanguagePreference,
  type LanguagePreference,
} from './src/lib/conversation';
import {
  DEFAULT_SYSTEM_INSTRUCTION,
  buildLiveConfig,
  classifyLiveError,
  decideAfterTransportClose,
  resolveLiveModel,
  resolveServerApiKey,
  validateStartRequest,
} from './src/lib/liveConfig';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());

// Server environment key check. The value is never logged or returned.
const serverApiKey = resolveServerApiKey(process.env.GEMINI_API_KEY);
const hasServerApiKey = serverApiKey.length > 0;
const TARGET_MODEL = resolveLiveModel(process.env.GEMINI_LIVE_MODEL);

// Reconnection tuning. A resumed Live session preserves the conversation
// context; if no resumption handle exists we never silently start a fresh
// session (that would look like the assistant "forgot" the conversation).
const MAX_RESUME_ATTEMPTS = 2;
const RESUME_RETRY_DELAY_MS = 400;
// A transport can open and then be rejected (e.g. invalid API key) without the
// SDK's connect promise ever settling. Never let a start handshake hang.
const CONNECT_TIMEOUT_MS = Number(process.env.LIVE_CONNECT_TIMEOUT_MS || 20000);

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

if (!hasServerApiKey) {
  console.log('[Auth] No GEMINI_API_KEY in server environment; client must provide API key in UI.');
} else {
  console.log('[Auth] Server environment GEMINI_API_KEY detected.');
}
console.log(`[Config] Live model: ${TARGET_MODEL}`);

// Diagnostic status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'ok',
    hasServerKey: hasServerApiKey,
    targetModel: TARGET_MODEL,
    quotaStatus: 'Remaining account quota is not exposed by this session API.',
    serverTime: new Date().toISOString(),
  });
});

/**
 * WebSocket upgrades are not covered by the browser's same-origin policy, so a
 * page on any origin could otherwise drive this bridge (and, when configured,
 * spend the server-side Gemini API key). Allow same-host traffic (the normal
 * app), the configured APP_URL host (AI Studio), and an explicit allow-list.
 * Non-browser clients that send no Origin header are allowed.
 */
function isAllowedWebSocketOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (host && parsed.host === host) return true;

  const hostname = parsed.hostname;
  if (
    hostname.endsWith('.run.app') ||
    hostname.endsWith('.google.com') ||
    hostname.endsWith('.googleusercontent.com') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.includes('aistudio')
  ) {
    return true;
  }

  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl && appUrl !== 'MY_APP_URL') {
    try {
      if (new URL(appUrl).host === parsed.host) return true;
    } catch {
      /* ignore malformed APP_URL */
    }
  }

  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowList.includes(origin);
}

/**
 * All mutable state for ONE bridge session.
 *
 * Previously these values lived in the `clientWs` connection closure and were
 * shared by every Gemini session opened on that socket. A late callback from a
 * closed Gemini session could therefore flip `sessionActive`/`sessionInitialized`
 * for the *new* session and deliver stale audio tagged with the new session ID.
 * Each context is now owned by exactly one Gemini connection and every callback
 * verifies that the context is still the current one for its socket before
 * touching the client.
 */
interface LiveSessionContext {
  id: string;
  clientWs: WebSocket;
  startedAtMono: number;
  startedAtUtc: string;

  apiKey: string;
  baseInstruction: string;

  model: string;
  voice: string;
  language: LanguagePreference;

  gemini: Session | null;
  /**
   * Increments for every Gemini transport opened for this context. Callbacks
   * capture the epoch they belong to, so a delayed `onclose`/`onmessage` from a
   * connection that has already been replaced by a resume cannot tear down the
   * new connection.
   */
  connectionEpoch: number;
  initialized: boolean;
  active: boolean;
  intentionallyClosed: boolean;
  sawSessionReady: boolean;
  reconnecting: boolean;
  connecting: boolean;
  resumeScheduled: boolean;
  reconnectAttempts: number;
  resumeHandle: string | null;
  pendingResume: boolean;
  lastError: string | null;
  failureReported: boolean;

  generationCounter: number;
  currentGenerationId: string;
  chunkSeqInGeneration: number;
  interruptedGenerations: Set<string>;

  micChunksReceived: number;
  micChunksForwarded: number;
  micChunksDropped: number;
  modelChunksReceived: number;
  modelChunksDelivered: number;
  modelChunksDropped: number;
  serverInterruptionEventsCount: number;
  completedTurnsCount: number;
  lastUsageMetadata: Record<string, unknown> | null;
}

// A client socket owns at most one live context at a time. A WeakMap keeps
// tabs/clients isolated from each other while still letting stale callbacks
// detect that they have been superseded.
const sessionBySocket = new WeakMap<WebSocket, LiveSessionContext>();
let sessionIdCounter = 0;

function createSessionContext(
  clientWs: WebSocket,
  input: {
    apiKey: string;
    model: string;
    voice: string;
    language: LanguagePreference;
    baseInstruction: string;
  }
): LiveSessionContext {
  sessionIdCounter += 1;
  const sessionId = `sess_${Date.now()}_${sessionIdCounter}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;
  return {
    id: sessionId,
    clientWs,
    startedAtMono: performance.now(),
    startedAtUtc: new Date().toISOString(),
    apiKey: input.apiKey,
    baseInstruction: input.baseInstruction,
    model: input.model,
    voice: input.voice,
    language: input.language,
    gemini: null,
    connectionEpoch: 0,
    initialized: false,
    active: false,
    intentionallyClosed: false,
    sawSessionReady: false,
    reconnecting: false,
    connecting: false,
    resumeScheduled: false,
    reconnectAttempts: 0,
    resumeHandle: null,
    pendingResume: false,
    lastError: null,
    failureReported: false,
    generationCounter: 0,
    currentGenerationId: INITIAL_GENERATION_ID,
    chunkSeqInGeneration: 0,
    interruptedGenerations: new Set<string>(),
    micChunksReceived: 0,
    micChunksForwarded: 0,
    micChunksDropped: 0,
    modelChunksReceived: 0,
    modelChunksDelivered: 0,
    modelChunksDropped: 0,
    serverInterruptionEventsCount: 0,
    completedTurnsCount: 0,
    lastUsageMetadata: null,
  };
}

/**
 * Sends a frame to the client only if this context is still the active one.
 * Prevents stale sessions from mutating the client's state after a restart.
 */
function sendToClient(ctx: LiveSessionContext, payload: Record<string, unknown>): boolean {
  if (!isCurrent(ctx)) return false;
  if (ctx.clientWs.readyState !== WebSocket.OPEN) return false;
  try {
    ctx.clientWs.send(JSON.stringify(payload));
    return true;
  } catch (err: any) {
    console.error(`[Live WS] Failed to send frame [${ctx.id}]:`, err?.message || err);
    return false;
  }
}

/**
 * A callback is only allowed to mutate state if it belongs to the context that
 * currently owns the socket *and* to the transport that is currently open.
 */
function isCurrentConnection(ctx: LiveSessionContext, epoch: number): boolean {
  return isCurrent(ctx) && ctx.connectionEpoch === epoch;
}

function nextGeneration(ctx: LiveSessionContext): string {
  ctx.generationCounter += 1;
  ctx.currentGenerationId = `gen_${ctx.generationCounter}`;
  ctx.chunkSeqInGeneration = 0;
  return ctx.currentGenerationId;
}

/**
 * Reports a terminal session failure exactly once (error + closed), so the
 * client never receives duplicate teardown or a contradictory "ready" state.
 */
function reportSessionFailure(
  ctx: LiveSessionContext,
  code: string,
  error: string,
  extra: Record<string, unknown> = {}
): void {
  if (ctx.failureReported) return;
  ctx.failureReported = true;
  sendToClient(ctx, {
    type: 'error',
    code,
    sessionId: ctx.id,
    error,
    serverUtc: new Date().toISOString(),
    ...extra,
  });
  sendToClient(ctx, {
    type: 'closed',
    sessionId: ctx.id,
    reconnectable: false,
    reason: error,
    serverUtc: new Date().toISOString(),
    ...extra,
  });
}


function isCurrent(ctx: LiveSessionContext): boolean {
  return sessionBySocket.get(ctx.clientWs) === ctx && !ctx.intentionallyClosed;
}

/** Tears down a context exactly once. */
function closeSession(ctx: LiveSessionContext, reason: string): void {
  if (ctx.intentionallyClosed) return;
  ctx.intentionallyClosed = true;
  ctx.active = false;
  ctx.initialized = false;
  const gemini = ctx.gemini;
  ctx.gemini = null;
  if (gemini) {
    try {
      gemini.close();
    } catch (err: any) {
      console.error(`[Live WS] Error closing Gemini session [${ctx.id}]:`, err?.message || err);
    }
  }
  console.log(
    `[Live WS] Session closed [${ctx.id}] reason="${reason}" ` +
      `mic=${ctx.micChunksForwarded}/${ctx.micChunksReceived} ` +
      `modelChunks=${ctx.modelChunksDelivered} interruptions=${ctx.serverInterruptionEventsCount} ` +
      `turns=${ctx.completedTurnsCount}`
  );
  if (sessionBySocket.get(ctx.clientWs) === ctx) sessionBySocket.delete(ctx.clientWs);
}

/**
 * Handles one message from Gemini for the owning context.
 *
 * Ordering note: an interrupted frame can carry `modelTurn` parts for the new
 * turn. Interruption is therefore processed FIRST and the generation advanced,
 * so those parts are tagged with the new generation instead of the obsolete one
 * (which the client would immediately drop).
 */
function handleServerMessage(
  ctx: LiveSessionContext,
  message: LiveServerMessage,
  epoch: number
): void {
  if (!isCurrentConnection(ctx, epoch)) return;
  const recvMono = performance.now();
  const recvUtc = new Date().toISOString();
  const serverContent = message.serverContent;

  // Stage A: setup confirmed
  if (message.setupComplete) {
    const wasResuming = ctx.pendingResume;
    ctx.pendingResume = false;
    ctx.initialized = true;
    ctx.active = true;
    ctx.sawSessionReady = true;
    ctx.reconnecting = false;
    ctx.resumeScheduled = false;
    ctx.reconnectAttempts = 0;
    console.log(
      `[Live WS] Gemini Live ${wasResuming ? 'resumed' : 'ready'} [${ctx.id}] ` +
        `model=${ctx.model} language=${ctx.language.code ?? 'auto'} voice=${ctx.voice}`
    );
    sendToClient(ctx, {
      type: wasResuming ? 'session_reconnected' : 'session_ready',
      sessionId: ctx.id,
      model: ctx.model,
      voice: ctx.voice,
      language: { code: ctx.language.code, label: ctx.language.label },
      contextPreserved: wasResuming,
      resumed: wasResuming,
      serverMono: recvMono,
      serverUtc: recvUtc,
      sessionStartTimeUtc: ctx.startedAtUtc,
    });
    return;
  }

  // Session expiry warning: the client can inform the user; the bridge will
  // resume the context automatically once the socket closes.
  if (message.goAway) {
    console.log(`[Live WS] goAway received [${ctx.id}] timeLeft=${message.goAway.timeLeft ?? 'unknown'}`);
    sendToClient(ctx, {
      type: 'session_expiring',
      sessionId: ctx.id,
      timeLeft: message.goAway.timeLeft,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  if (message.sessionResumptionUpdate) {
    const update = message.sessionResumptionUpdate;
    if (update.resumable && update.newHandle) {
      ctx.resumeHandle = update.newHandle;
    }
  }

  // Stage C: interruption must be handled before any content in this frame.
  if (serverContent?.interrupted) {
    const interruptedGen = ctx.currentGenerationId;
    const firstObservation = !ctx.interruptedGenerations.has(interruptedGen);
    if (firstObservation) {
      ctx.interruptedGenerations.add(interruptedGen);
      ctx.serverInterruptionEventsCount += 1;
    }
    nextGeneration(ctx);
    console.log(
      `[Live WS] Interruption [${ctx.id}] ${interruptedGen} -> ${ctx.currentGenerationId}` +
        `${firstObservation ? '' : ' (duplicate event)'}`
    );
    sendToClient(ctx, {
      type: 'interrupted',
      sessionId: ctx.id,
      interruptedGenerationId: interruptedGen,
      nextGenerationId: ctx.currentGenerationId,
      serverInterruptionCount: ctx.serverInterruptionEventsCount,
      bridgeInterruptedRecvMono: recvMono,
      bridgeInterruptedRecvUtc: recvUtc,
      bridgeInterruptedSentMono: performance.now(),
    });
  }

  // Stage B: model turn content (24kHz PCM chunks & text transcript)
  const modelTurn = serverContent?.modelTurn;
  if (modelTurn?.parts?.length) {
    if (ctx.currentGenerationId === INITIAL_GENERATION_ID) {
      nextGeneration(ctx);
    }
    for (const part of modelTurn.parts) {
      if (part.inlineData?.data) {
        ctx.modelChunksReceived += 1;
        // Strict no-audio-playback requirement for Sales Copilot:
        // Do not forward generated audio payloads to the client.
        // We filter out generated audio packets before browser delivery.
        ctx.modelChunksDropped += 1;
      }
      if (part.text) {
        sendToClient(ctx, {
          type: 'text',
          sessionId: ctx.id,
          generationId: ctx.currentGenerationId,
          text: part.text,
          serverMono: recvMono,
          serverUtc: recvUtc,
        });
      }
    }
  }

  // Stage D: turn complete. The generation counter always advances so a new
  // response can never reuse the ID of a turn the client already closed.
  if (serverContent?.turnComplete) {
    const completedGen = ctx.currentGenerationId;
    ctx.completedTurnsCount += 1;
    nextGeneration(ctx);
    console.log(
      `[Live WS] Turn complete [${ctx.id}] ${completedGen} -> ${ctx.currentGenerationId} ` +
        `(turns=${ctx.completedTurnsCount}, audioDiscarded=${ctx.modelChunksDropped})`
    );
    sendToClient(ctx, {
      type: 'turn_complete',
      sessionId: ctx.id,
      completedGenerationId: completedGen,
      nextGenerationId: ctx.currentGenerationId,
      completedTurnsCount: ctx.completedTurnsCount,
      audioPacketsDiscarded: ctx.modelChunksDropped,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  // Stage E: token usage metadata (preserved raw from the API)
  if (message.usageMetadata) {
    ctx.lastUsageMetadata = {
      promptTokenCount: message.usageMetadata.promptTokenCount,
      responseTokenCount: message.usageMetadata.responseTokenCount,
      totalTokenCount: message.usageMetadata.totalTokenCount,
      cachedContentTokenCount: (message.usageMetadata as any).cachedContentTokenCount,
      thoughtsTokenCount: (message.usageMetadata as any).thoughtsTokenCount,
      audioPacketsDiscarded: ctx.modelChunksDropped,
    };
    sendToClient(ctx, {
      type: 'usage',
      sessionId: ctx.id,
      usage: ctx.lastUsageMetadata,
      scope: 'cumulative_session',
      quotaNotice: 'Remaining account quota is not exposed by this session API.',
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  // Transcripts are forwarded as structured events.
  // 1. Customer speech: low-latency interim hypothesis while actively speaking
  const interimInputTranscription = (serverContent as any)?.interimInputTranscription?.text;
  if (interimInputTranscription) {
    sendToClient(ctx, {
      type: 'transcription',
      sessionId: ctx.id,
      direction: 'input',
      isFinal: false,
      text: interimInputTranscription,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  // 2. Customer speech: finalized utterance segment
  const inputTranscription = serverContent?.inputTranscription?.text;
  if (inputTranscription) {
    sendToClient(ctx, {
      type: 'transcription',
      sessionId: ctx.id,
      direction: 'input',
      isFinal: true,
      text: inputTranscription,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  // 3. Private sales copilot suggestions: generated response text from Gemini
  const outputTranscription = serverContent?.outputTranscription?.text;
  if (outputTranscription) {
    sendToClient(ctx, {
      type: 'transcription',
      sessionId: ctx.id,
      direction: 'output',
      generationId: ctx.currentGenerationId,
      text: outputTranscription,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }

  // Stage F: voice activity signal if the server provides one
  if (message.voiceActivity) {
    sendToClient(ctx, {
      type: 'voice_activity',
      sessionId: ctx.id,
      voiceActivity: message.voiceActivity,
      serverMono: recvMono,
      serverUtc: recvUtc,
    });
  }
}




function scheduleResume(ctx: LiveSessionContext): void {
  if (ctx.resumeScheduled) return;
  ctx.resumeScheduled = true;
  ctx.reconnectAttempts += 1;
  ctx.reconnecting = true;
  sendToClient(ctx, {
    type: 'session_reconnecting',
    sessionId: ctx.id,
    attempt: ctx.reconnectAttempts,
    maxAttempts: MAX_RESUME_ATTEMPTS,
    serverUtc: new Date().toISOString(),
  });
  const delay = RESUME_RETRY_DELAY_MS * ctx.reconnectAttempts;
  setTimeout(() => {
    void attemptResume(ctx);
  }, delay);
}

async function attemptResume(ctx: LiveSessionContext): Promise<void> {
  if (!isCurrent(ctx) || !ctx.resumeHandle) return;
  ctx.resumeScheduled = false;
  console.log(`[Live WS] Attempting session resume [${ctx.id}] attempt=${ctx.reconnectAttempts}`);
  try {
    await openLive(ctx, ctx.apiKey, ctx.resumeHandle);
    await awaitSessionReady(ctx);
  } catch (err: any) {
    if (!isCurrent(ctx)) return;
    ctx.reconnecting = false;
    console.error(
      `[Live WS] Session resume failed [${ctx.id}] attempt=${ctx.reconnectAttempts}:`,
      err?.message || err
    );
    if (ctx.reconnectAttempts < MAX_RESUME_ATTEMPTS) {
      scheduleResume(ctx);
      return;
    }
    reportSessionFailure(
      ctx,
      'SESSION_RESUME_FAILED',
      'The live session could not be resumed after a connection loss. Start a new conversation to continue.'
    );
    closeSession(ctx, 'resume_failed');
  }
}

/**
 * Called whenever the Gemini transport closes. Only a session that had already
 * become ready is resumed, and only with a server-issued resumption handle -
 * this avoids silently creating a fresh (context-less) session.
 */
function handleLiveClose(
  ctx: LiveSessionContext,
  e: { code?: number; reason?: string },
  epoch: number
): void {
  if (!isCurrentConnection(ctx, epoch)) return;
  ctx.active = false;
  ctx.initialized = false;
  ctx.gemini = null;
  if (ctx.intentionallyClosed) return;

  const code = e?.code;
  const reason = e?.reason || '';
  if (reason) ctx.lastError = reason;
  console.log(`[Live WS] Gemini Live socket closed [${ctx.id}] code=${code} reason="${reason}"`);

  const decision = decideAfterTransportClose({
    sawSessionReady: ctx.sawSessionReady,
    hasResumeHandle: Boolean(ctx.resumeHandle),
    reconnectAttempts: ctx.reconnectAttempts,
    maxAttempts: MAX_RESUME_ATTEMPTS,
  });

  if (decision === 'fail_initial') {
    const errorCode = classifyLiveError(reason);
    reportSessionFailure(
      ctx,
      errorCode === 'API_ERROR' ? 'SESSION_INIT_FAILED' : errorCode,
      reason ||
        `Connection closed before session initialization completed (Close code ${code ?? 'unknown'}).`
    );
    closeSession(ctx, 'init_failed');
    return;
  }

  if (decision === 'resume') {
    scheduleResume(ctx);
    return;
  }

  sendToClient(ctx, {
    type: 'closed',
    sessionId: ctx.id,
    reconnectable: false,
    resumeAvailable: Boolean(ctx.resumeHandle),
    code,
    reason,
    serverMono: performance.now(),
    serverUtc: new Date().toISOString(),
  });
  closeSession(ctx, 'closed_by_server');
}


/**
 * Waits until `setupComplete` has been received. `connect()` only guarantees
 * that the socket opened; a session that never becomes ready must fail closed
 * rather than leaving the UI in a permanent "connecting" state.
 */
async function awaitSessionReady(ctx: LiveSessionContext, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isCurrent(ctx)) return;
    if (ctx.initialized && ctx.active) return;
    // Another resume attempt has been scheduled; it owns the outcome.
    if (ctx.resumeScheduled) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!isCurrent(ctx)) return;
  throw new Error('Gemini Live session did not complete setup in time.');
}

/**
 * Opens (or resumes) the Gemini Live transport for a context.
 * Throws if the connection cannot be established.
 */
async function openLive(
  ctx: LiveSessionContext,
  apiKey: string,
  resumptionHandle?: string | null
): Promise<void> {
  const isResume = Boolean(resumptionHandle);
  ctx.pendingResume = isResume;
  ctx.connecting = true;
  ctx.reconnecting = isResume;
  ctx.connectionEpoch += 1;
  const epoch = ctx.connectionEpoch;

  const config = buildLiveConfig({
    voice: ctx.voice,
    language: ctx.language,
    baseSystemInstruction: ctx.baseInstruction,
    resumptionHandle: resumptionHandle || null,
    model: ctx.model,
  });

  console.log(
    `[Live WS] ${isResume ? 'Resuming' : 'Connecting'} Gemini Live API [${ctx.id}] ` +
      `model=${ctx.model} voice=${ctx.voice} language=${ctx.language.code ?? 'auto'}` +
      `${isResume ? ' (context resume)' : ''}`
  );

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const session = await withTimeout(
      ai.live.connect({
        model: ctx.model,
        config,
        callbacks: {
        onopen: () => {
          if (!isCurrentConnection(ctx, epoch)) return;
          console.log(`[Live WS] Transport open to Gemini Live API [${ctx.id}]`);
          if (!isResume) {
            sendToClient(ctx, {
              type: 'ws_established',
              sessionId: ctx.id,
              model: ctx.model,
              serverMono: performance.now(),
              serverUtc: new Date().toISOString(),
            });
          }
        },
        onmessage: (message: LiveServerMessage) => {
          try {
            handleServerMessage(ctx, message, epoch);
          } catch (err: any) {
            console.error(`[Live WS] Gemini message handling error [${ctx.id}]:`, err?.message || err);
          }
        },
        onerror: (err: any) => {
          if (!isCurrentConnection(ctx, epoch)) return;
          ctx.lastError = err?.message || 'Gemini Live session error occurred.';
          console.error(`[Live WS] Gemini Live session error [${ctx.id}]:`, ctx.lastError);
          // Do not report here: `onclose` is the single authority for terminal
          // failures, which avoids duplicate error frames while still catching
          // sockets that close before `setupComplete`.
        },
        onclose: (e: any) => {
          handleLiveClose(ctx, { code: e?.code, reason: e?.reason }, epoch);
        },
      },
      }),
      CONNECT_TIMEOUT_MS,
      'Timed out while opening the Gemini Live session.'
    );

    if (!isCurrentConnection(ctx, epoch)) {
      try {
        session.close();
      } catch {
        /* already closed */
      }
      return;
    }

    // The SDK resolves connect() on socket open. If the socket has already
    // closed again (e.g. auth failure) do not leave a dead session attached.
    const conn = (session as unknown as { conn?: { readyState?: number } }).conn;
    if (typeof conn?.readyState === 'number' && conn.readyState !== 1) {
      try {
        session.close();
      } catch {
        /* already closed */
      }
      throw new Error('Gemini Live connection closed immediately after it was opened.');
    }

    ctx.gemini = session;
  } finally {
    ctx.connecting = false;
  }
}


const VOICE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

async function handleStart(clientWs: WebSocket, data: any): Promise<void> {
  // A `start` on a socket that already has a session replaces it. Closing the
  // previous context first guarantees its late callbacks are ignored.
  const previous = sessionBySocket.get(clientWs);
  if (previous) closeSession(previous, 'replaced_by_new_start');

  const language = resolveLanguagePreference(typeof data.language === 'string' ? data.language : null);
  const voice =
    typeof data.voice === 'string' && VOICE_NAME_PATTERN.test(data.voice.trim())
      ? data.voice.trim()
      : 'Puck';
  const baseInstruction =
    typeof data.systemInstruction === 'string' && data.systemInstruction.trim()
      ? data.systemInstruction.trim()
      : DEFAULT_SYSTEM_INSTRUCTION;

  const validation = validateStartRequest(
    { model: data.model, apiKey: data.apiKey },
    { serverApiKey, targetModel: TARGET_MODEL }
  );

  const ctx = createSessionContext(clientWs, {
    apiKey: validation.ok ? validation.apiKey : '',
    model: TARGET_MODEL,
    voice,
    language,
    baseInstruction,
  });
  sessionBySocket.set(clientWs, ctx);

  if (!validation.ok) {
    console.warn(`[Live WS] Rejected start [${ctx.id}] code=${validation.code}`);
    sendToClient(ctx, {
      type: 'error',
      code: validation.code,
      sessionId: ctx.id,
      error: validation.error,
      serverUtc: new Date().toISOString(),
    });
    closeSession(ctx, `start_rejected:${validation.code}`);
    return;
  }

  console.log(
    `[Live WS] Start requested [${ctx.id}] model=${ctx.model} voice=${ctx.voice} ` +
      `language=${language.code ?? 'auto'}`
  );

  sendToClient(ctx, {
    type: 'status',
    state: 'connecting',
    sessionId: ctx.id,
    model: ctx.model,
    language: { code: language.code, label: language.label },
    sessionStartTimeUtc: ctx.startedAtUtc,
    serverMono: performance.now(),
    serverUtc: new Date().toISOString(),
  });

  try {
    await openLive(ctx, validation.apiKey, null);
    await awaitSessionReady(ctx);
  } catch (err: any) {
    if (!isCurrent(ctx)) return;
    const message = err?.message || 'Failed to establish Gemini Live connection.';
    const code = classifyLiveError(message);
    console.error(`[Live WS] Connect failed [${ctx.id}]:`, message);
    reportSessionFailure(ctx, code === 'API_ERROR' ? 'CONNECT_FAILED' : code, message);
    closeSession(ctx, 'connect_failed');
  }
}

function handleAudioFrame(ctx: LiveSessionContext, data: any): void {
  const bridgeRecvMono = performance.now();
  ctx.micChunksReceived += 1;

  if (!data.audio || typeof data.audio !== 'string') return;

  // Chunks arriving while the session is (re)connecting are counted and
  // dropped; they belong to a moment when no model context existed.
  if (!ctx.gemini || !ctx.active) {
    ctx.micChunksDropped += 1;
    return;
  }

  try {
    ctx.gemini.sendRealtimeInput({
      audio: {
        data: data.audio,
        mimeType: 'audio/pcm;rate=16000',
      },
    });
    ctx.micChunksForwarded += 1;
    const bridgeFwdMono = performance.now();

    if (data.seq && data.seq % 50 === 0) {
      sendToClient(ctx, {
        type: 'audio_ack',
        sessionId: ctx.id,
        seq: data.seq,
        clientCaptureMono: data.clientCaptureMono,
        clientSentMono: data.clientSentMono,
        bridgeRecvMono,
        bridgeFwdMono,
        bridgeForwardDurationMs: Math.round((bridgeFwdMono - bridgeRecvMono) * 100) / 100,
      });
    }
  } catch (sendErr: any) {
    console.error(`[Live WS] Error streaming audio to Gemini Live [${ctx.id}]:`, sendErr?.message || sendErr);
  }
}

// WebSocket Server for Gemini Live API bidirectional bridge
const wss = new WebSocketServer({ noServer: true });

/**
 * Application-level liveness. The client pings every 5 s, but a half-open TCP
 * connection can otherwise hold a Gemini session (and its quota) for minutes
 * after the browser disappears. Terminating silent peers also guarantees their
 * per-socket context is closed.
 */
const WS_HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
    if (ws.isAlive === false) {
      console.warn('[Live WS] Terminating unresponsive client socket');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* close handler will clean up */
    }
  }
}, WS_HEARTBEAT_MS);
heartbeat.unref?.();

wss.on('connection', (clientWs: WebSocket) => {
  console.log('[Live WS] Client connected to live session bridge');
  const tracked = clientWs as WebSocket & { isAlive?: boolean };
  tracked.isAlive = true;
  tracked.on('pong', () => {
    tracked.isAlive = true;
  });

  clientWs.on('message', async (raw) => {
    let data: any;
    try {
      data = JSON.parse(raw.toString());
    } catch (err: any) {
      try {
        clientWs.send(
          JSON.stringify({
            type: 'error',
            code: 'MESSAGE_ERROR',
            error: `Server message parsing error: ${err?.message || err}`,
            serverUtc: new Date().toISOString(),
          })
        );
      } catch {
        /* socket already gone */
      }
      return;
    }

    try {
      // 1. RTT Ping/Pong for transport latency measurement
      if (data.type === 'ping') {
        clientWs.send(
          JSON.stringify({
            type: 'pong',
            clientMono: data.clientMono,
            serverMono: performance.now(),
            serverUtc: new Date().toISOString(),
          })
        );
        return;
      }

      // 2. Start (or restart) the live session for this socket
      if (data.type === 'start') {
        await handleStart(clientWs, data);
        return;
      }

      const ctx = sessionBySocket.get(clientWs);
      if (!ctx) {
        return;
      }

      // 3. Microphone audio
      if (data.type === 'audio') {
        handleAudioFrame(ctx, data);
        return;
      }

      // 4. Explicit end
      if (data.type === 'end') {
        console.log(`[Live WS] Client requested end of session [${ctx.id}]`);
        sendToClient(ctx, {
          type: 'status',
          state: 'disconnected',
          sessionId: ctx.id,
          serverMono: performance.now(),
          serverUtc: new Date().toISOString(),
        });
        closeSession(ctx, 'client_end');
      }
    } catch (err: any) {
      console.error('[Live WS] Message handler error:', err?.message || err);
      const ctx = sessionBySocket.get(clientWs);
      if (ctx) {
        sendToClient(ctx, {
          type: 'error',
          code: 'MESSAGE_ERROR',
          sessionId: ctx.id,
          error: `Server message handling error: ${err?.message || err}`,
          serverUtc: new Date().toISOString(),
        });
      }
    }
  });

  clientWs.on('close', () => {
    const ctx = sessionBySocket.get(clientWs);
    console.log(
      `[Live WS] Client disconnected from WebSocket bridge${ctx ? ` [${ctx.id}]` : ''}`
    );
    if (ctx) closeSession(ctx, 'client_disconnected');
  });

  clientWs.on('error', (err) => {
    const ctx = sessionBySocket.get(clientWs);
    console.error(
      `[Live WS] Client WebSocket socket error${ctx ? ` [${ctx.id}]` : ''}:`,
      err
    );
    if (ctx) closeSession(ctx, 'client_socket_error');
  });
});

// Upgrade handling for WebSocket endpoint
server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (pathname === '/api/live-ws') {
      // Behind Cloud Run/proxies the public host may only be present in
      // X-Forwarded-Host.
      const forwardedHost = request.headers['x-forwarded-host'];
      const publicHost = Array.isArray(forwardedHost)
        ? forwardedHost[0]
        : forwardedHost || request.headers.host;
      if (!isAllowedWebSocketOrigin(request.headers.origin, publicHost)) {
        console.warn(`[Server Upgrade] Rejected WebSocket origin: ${request.headers.origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
      return;
    }
    // For non /api/live-ws upgrade requests (such as Vite HMR), do not handle or destroy;
    // let Vite middleware handle them or ignore.
  } catch (err) {
    console.error('[Server Upgrade] Error parsing URL:', err);
    socket.destroy();
  }
});

// Setup Vite middlewares in dev or static files in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Gemini Live Voice Tester server running at http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket endpoint ready at ws://0.0.0.0:${PORT}/api/live-ws`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});

