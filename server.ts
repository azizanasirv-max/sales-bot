import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());

// Server environment key check
const serverApiKey = (process.env.GEMINI_API_KEY || '').trim();
const hasServerApiKey =
  serverApiKey.length > 0 && serverApiKey !== 'MY_GEMINI_API_KEY';

if (!hasServerApiKey) {
  console.log('[Auth] No GEMINI_API_KEY in server environment; client must provide API key in UI.');
} else {
  console.log('[Auth] Server environment GEMINI_API_KEY detected.');
}

// Diagnostic status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'ok',
    hasServerKey: hasServerApiKey,
    targetModel: 'gemini-3.8-live',
    quotaStatus: 'Remaining account quota is not exposed by this session API.',
    serverTime: new Date().toISOString(),
  });
});

// WebSocket Server for Gemini Live API bidirectional bridge
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (clientWs: WebSocket) => {
  console.log('[Live WS] Client connected to live session bridge');

  // Session-isolated variables
  let currentSessionId = '';
  let geminiSession: any = null;
  let sessionActive = false;
  let sessionInitialized = false;
  let isIntentionalClose = false;
  let sessionStartTimeMono = 0;
  let sessionStartTimeUtc = '';

  // Monotonic generation management
  let generationCounter = 0;
  let currentGenerationId = '';
  let chunkSeqInGeneration = 0;
  let interruptedGenerations = new Set<string>();

  // Isolated per-session packet & event counters
  let micChunksReceived = 0;
  let micChunksForwarded = 0;
  let modelChunksReceived = 0;
  let modelChunksDelivered = 0;
  let serverInterruptionEventsCount = 0;
  let completedTurnsCount = 0;

  // Recent usage metadata
  let lastUsageMetadata: any = null;

  const cleanupSession = () => {
    isIntentionalClose = true;
    sessionActive = false;
    sessionInitialized = false;
    if (geminiSession) {
      try {
        console.log(`[Live WS] Closing Gemini Live session: ${currentSessionId}`);
        geminiSession.close?.();
      } catch (err) {
        console.error('[Live WS] Error closing Gemini session:', err);
      }
      geminiSession = null;
    }
  };

  clientWs.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

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

      // 2. Start Live Session
      if (data.type === 'start') {
        cleanupSession();
        isIntentionalClose = false;

        // Generate unique isolated session ID
        currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        sessionStartTimeMono = performance.now();
        sessionStartTimeUtc = new Date().toISOString();

        // Reset per-session counters & generation tracking
        generationCounter = 0;
        currentGenerationId = 'gen_0';
        chunkSeqInGeneration = 0;
        interruptedGenerations = new Set<string>();
        micChunksReceived = 0;
        micChunksForwarded = 0;
        modelChunksReceived = 0;
        modelChunksDelivered = 0;
        serverInterruptionEventsCount = 0;
        completedTurnsCount = 0;
        lastUsageMetadata = null;

        const requestedModel = data.model || 'gemini-3.8-live';
        // Strict model check: Do not substitute another model silently
        if (requestedModel !== 'gemini-3.8-live') {
          clientWs.send(
            JSON.stringify({
              type: 'error',
              code: 'INVALID_MODEL',
              sessionId: currentSessionId,
              error: `Invalid model requested: "${requestedModel}". Only "gemini-3.8-live" is supported.`,
              serverUtc: new Date().toISOString(),
            })
          );
          return;
        }

        // Determine effective API key
        const userProvidedKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
        const effectiveApiKey = userProvidedKey || serverApiKey;

        if (!effectiveApiKey) {
          clientWs.send(
            JSON.stringify({
              type: 'error',
              code: 'API_KEY_MISSING',
              sessionId: currentSessionId,
              error: 'No Gemini API key supplied. Please enter your Google Gemini API key in the configuration screen.',
              serverUtc: new Date().toISOString(),
            })
          );
          return;
        }

        const voiceName = data.voice || 'Puck';
        const systemInstruction =
          data.systemInstruction ||
          'You are a real-time voice testing assistant. Keep your spoken responses natural, expressive, and concise (1-3 sentences) so the user can easily evaluate speech quality, latency, and barge-in interruption.';

        clientWs.send(
          JSON.stringify({
            type: 'status',
            state: 'connecting',
            sessionId: currentSessionId,
            model: 'gemini-3.8-live',
            serverMono: performance.now(),
            serverUtc: new Date().toISOString(),
          })
        );

        try {
          console.log(
            `[Live WS] Connecting Gemini Live API [Session: ${currentSessionId}] (Model: gemini-3.8-live, Voice: ${voiceName})`
          );

          const ai = new GoogleGenAI({
            apiKey: effectiveApiKey,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              },
            },
          });

          geminiSession = await ai.live.connect({
            model: 'gemini-3.8-live',
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voiceName },
                },
              },
              systemInstruction: systemInstruction,
            },
            callbacks: {
              onopen: () => {
                console.log(`[Live WS] Transport connection opened to Gemini Live API [${currentSessionId}]`);
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'ws_established',
                      sessionId: currentSessionId,
                      model: 'gemini-3.8-live',
                      serverMono: performance.now(),
                      serverUtc: new Date().toISOString(),
                    })
                  );
                }
              },
              onmessage: (message: LiveServerMessage) => {
                if (clientWs.readyState !== WebSocket.OPEN) return;
                const msgRecvMono = performance.now();
                const msgRecvUtc = new Date().toISOString();

                // Stage A: Session setup confirmed by Google Gemini Live server
                if (message.setupComplete) {
                  sessionInitialized = true;
                  sessionActive = true;
                  console.log(`[Live WS] Gemini Live session ready (setupComplete) [${currentSessionId}]`);
                  clientWs.send(
                    JSON.stringify({
                      type: 'session_ready',
                      sessionId: currentSessionId,
                      model: 'gemini-3.8-live',
                      voice: voiceName,
                      serverMono: msgRecvMono,
                      serverUtc: msgRecvUtc,
                      sessionStartTimeUtc,
                    })
                  );
                  return;
                }

                // Stage B: Process model turn content (24kHz PCM chunks & text transcript)
                const modelTurn = message.serverContent?.modelTurn;
                if (modelTurn?.parts) {
                  // Ensure generation ID is active
                  if (!currentGenerationId || currentGenerationId === 'gen_0') {
                    generationCounter++;
                    currentGenerationId = `gen_${generationCounter}`;
                    chunkSeqInGeneration = 0;
                  }

                  for (const part of modelTurn.parts) {
                    if (part.inlineData?.data) {
                      modelChunksReceived++;
                      chunkSeqInGeneration++;
                      modelChunksDelivered++;

                      clientWs.send(
                        JSON.stringify({
                          type: 'audio',
                          sessionId: currentSessionId,
                          generationId: currentGenerationId,
                          chunkSeq: chunkSeqInGeneration,
                          data: part.inlineData.data,
                          mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                          bridgeRecvMono: msgRecvMono,
                          bridgeSentMono: performance.now(),
                          serverUtc: msgRecvUtc,
                        })
                      );
                    }
                    if (part.text) {
                      clientWs.send(
                        JSON.stringify({
                          type: 'text',
                          sessionId: currentSessionId,
                          generationId: currentGenerationId,
                          text: part.text,
                          serverMono: msgRecvMono,
                          serverUtc: msgRecvUtc,
                        })
                      );
                    }
                  }
                }

                // Stage C: Gemini Live Interruption event (Stage 6 & 7 in pipeline)
                if (message.serverContent?.interrupted) {
                  const interruptedGen = currentGenerationId;
                  interruptedGenerations.add(interruptedGen);
                  serverInterruptionEventsCount++;

                  // Increment generation for subsequent speech
                  generationCounter++;
                  currentGenerationId = `gen_${generationCounter}`;
                  chunkSeqInGeneration = 0;

                  const bridgeInterruptedSentMono = performance.now();
                  console.log(
                    `[Live WS] Gemini Live reported interruption of ${interruptedGen} -> transitioning to ${currentGenerationId}`
                  );

                  clientWs.send(
                    JSON.stringify({
                      type: 'interrupted',
                      sessionId: currentSessionId,
                      interruptedGenerationId: interruptedGen,
                      nextGenerationId: currentGenerationId,
                      serverInterruptionCount: serverInterruptionEventsCount,
                      // Stage 6: Gemini Live interruption event received by bridge
                      bridgeInterruptedRecvMono: msgRecvMono,
                      bridgeInterruptedRecvUtc: msgRecvUtc,
                      // Stage 7: Interruption event delivered to browser
                      bridgeInterruptedSentMono,
                    })
                  );
                }

                // Stage D: Turn complete event
                if (message.serverContent?.turnComplete) {
                  const completedGen = currentGenerationId;
                  completedTurnsCount++;

                  // Prepare next generation ID for the next turn
                  generationCounter++;
                  currentGenerationId = `gen_${generationCounter}`;
                  chunkSeqInGeneration = 0;

                  clientWs.send(
                    JSON.stringify({
                      type: 'turn_complete',
                      sessionId: currentSessionId,
                      completedGenerationId: completedGen,
                      nextGenerationId: currentGenerationId,
                      completedTurnsCount,
                      serverMono: msgRecvMono,
                      serverUtc: msgRecvUtc,
                    })
                  );
                }

                // Stage E: Token usage metadata (Preserve raw API data exactly)
                if (message.usageMetadata) {
                  lastUsageMetadata = {
                    promptTokenCount: message.usageMetadata.promptTokenCount,
                    responseTokenCount: message.usageMetadata.responseTokenCount,
                    totalTokenCount: message.usageMetadata.totalTokenCount,
                    cachedContentTokenCount: (message.usageMetadata as any).cachedContentTokenCount,
                    thoughtsTokenCount: (message.usageMetadata as any).thoughtsTokenCount,
                  };

                  clientWs.send(
                    JSON.stringify({
                      type: 'usage',
                      sessionId: currentSessionId,
                      usage: lastUsageMetadata,
                      scope: 'cumulative_session',
                      quotaNotice: 'Remaining account quota is not exposed by this session API.',
                      serverMono: msgRecvMono,
                      serverUtc: msgRecvUtc,
                    })
                  );
                }

                // Stage F: Voice activity signal if server provided
                if (message.voiceActivity) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'voice_activity',
                      sessionId: currentSessionId,
                      voiceActivity: message.voiceActivity,
                      serverMono: msgRecvMono,
                      serverUtc: msgRecvUtc,
                    })
                  );
                }
              },
              onerror: (err: any) => {
                console.error(`[Live WS] Gemini Live session error [${currentSessionId}]:`, err?.message || err);
                if (clientWs.readyState === WebSocket.OPEN) {
                  const errorMsg = err?.message || 'Gemini Live session error occurred.';
                  let errorCode = 'API_ERROR';
                  if (errorMsg.includes('API key') || errorMsg.includes('UNAUTHENTICATED')) {
                    errorCode = 'AUTH_ERROR';
                  } else if (errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('quota')) {
                    errorCode = 'QUOTA_EXHAUSTED';
                  } else if (errorMsg.includes('429')) {
                    errorCode = 'RATE_LIMITED';
                  } else if (errorMsg.includes('not found') || errorMsg.includes('unsupported')) {
                    errorCode = 'MODEL_UNAVAILABLE';
                  }

                  clientWs.send(
                    JSON.stringify({
                      type: 'error',
                      code: errorCode,
                      sessionId: currentSessionId,
                      error: errorMsg,
                      status: err?.status,
                      serverUtc: new Date().toISOString(),
                    })
                  );
                }
              },
              onclose: (e: any) => {
                console.log(
                  `[Live WS] Gemini Live session closed [${currentSessionId}]. Code: ${e?.code}, Reason: ${e?.reason}`
                );
                if (clientWs.readyState === WebSocket.OPEN) {
                  if (!sessionInitialized && !isIntentionalClose) {
                    let code = 'SESSION_INIT_FAILED';
                    const reason = (e?.reason || '').toLowerCase();
                    if (e?.code === 1007 || reason.includes('api key') || reason.includes('valid api key')) {
                      code = 'AUTH_ERROR';
                    } else if (reason.includes('quota') || reason.includes('resource_exhausted')) {
                      code = 'QUOTA_EXHAUSTED';
                    } else if (reason.includes('not found') || reason.includes('unsupported')) {
                      code = 'MODEL_UNAVAILABLE';
                    }

                    clientWs.send(
                      JSON.stringify({
                        type: 'error',
                        code: code,
                        sessionId: currentSessionId,
                        error:
                          e?.reason ||
                          `Connection closed before session initialization completed (Close code ${e?.code || 'unknown'}).`,
                        serverUtc: new Date().toISOString(),
                      })
                    );
                  } else {
                    clientWs.send(
                      JSON.stringify({
                        type: 'closed',
                        sessionId: currentSessionId,
                        code: e?.code,
                        reason: e?.reason,
                        serverMono: performance.now(),
                        serverUtc: new Date().toISOString(),
                      })
                    );
                  }
                }
                sessionActive = false;
                sessionInitialized = false;
              },
            },
          });
        } catch (connErr: any) {
          console.error(`[Live WS] Connect exception [${currentSessionId}]:`, connErr?.message || connErr);
          const errMsg = connErr?.message || 'Failed to establish Gemini Live connection.';
          let errCode = 'CONNECT_FAILED';
          if (errMsg.includes('API key') || errMsg.includes('UNAUTHENTICATED')) {
            errCode = 'AUTH_ERROR';
          }
          clientWs.send(
            JSON.stringify({
              type: 'error',
              code: errCode,
              sessionId: currentSessionId,
              error: errMsg,
              serverUtc: new Date().toISOString(),
            })
          );
        }
      } else if (data.type === 'audio') {
        // Stage 4 & 5: Audio chunk received by bridge and forwarded to Gemini
        const bridgeRecvMono = performance.now();
        micChunksReceived++;

        if (geminiSession && sessionActive && data.audio) {
          try {
            geminiSession.sendRealtimeInput({
              audio: {
                data: data.audio,
                mimeType: 'audio/pcm;rate=16000',
              },
            });
            micChunksForwarded++;
            const bridgeFwdMono = performance.now();

            // Acknowledge chunk forwarding telemetry periodically (every 50 chunks or on explicit ack)
            if (data.seq && data.seq % 50 === 0) {
              clientWs.send(
                JSON.stringify({
                  type: 'audio_ack',
                  sessionId: currentSessionId,
                  seq: data.seq,
                  clientCaptureMono: data.clientCaptureMono,
                  clientSentMono: data.clientSentMono,
                  bridgeRecvMono,
                  bridgeFwdMono,
                  bridgeForwardDurationMs: Math.round((bridgeFwdMono - bridgeRecvMono) * 100) / 100,
                })
              );
            }
          } catch (sendErr: any) {
            console.error('[Live WS] Error streaming audio to Gemini Live:', sendErr?.message || sendErr);
          }
        }
      } else if (data.type === 'end') {
        console.log(`[Live WS] Client requested end of session [${currentSessionId}]`);
        cleanupSession();
        clientWs.send(
          JSON.stringify({
            type: 'status',
            state: 'disconnected',
            sessionId: currentSessionId,
            serverMono: performance.now(),
            serverUtc: new Date().toISOString(),
          })
        );
      }
    } catch (err: any) {
      console.error('[Live WS] Message handler error:', err?.message || err);
      clientWs.send(
        JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          error: `Server message parsing error: ${err?.message || err}`,
          serverUtc: new Date().toISOString(),
        })
      );
    }
  });

  clientWs.on('close', () => {
    console.log(`[Live WS] Client disconnected from WebSocket bridge [${currentSessionId}]`);
    cleanupSession();
  });

  clientWs.on('error', (err) => {
    console.error(`[Live WS] Client WebSocket socket error [${currentSessionId}]:`, err);
    cleanupSession();
  });
});

// Upgrade handling for WebSocket endpoint
server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (pathname === '/api/live-ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
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
