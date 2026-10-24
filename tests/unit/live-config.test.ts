import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIVE_MODEL,
  buildLiveConfig,
  classifyLiveError,
  decideAfterTransportClose,
  isNativeAudioModel,
  resolveLiveModel,
  resolveServerApiKey,
  supportsSpeechLanguageCode,
  supportsTextResponseModality,
  validateStartRequest,
} from '../../src/lib/liveConfig';
import { resolveLanguagePreference } from '../../src/lib/conversation';

test('model: defaults to gemini-3.8-live and honours a valid env override', () => {
  assert.equal(resolveLiveModel(undefined), DEFAULT_LIVE_MODEL);
  assert.equal(resolveLiveModel(''), DEFAULT_LIVE_MODEL);
  assert.equal(resolveLiveModel('  '), DEFAULT_LIVE_MODEL);
  assert.equal(resolveLiveModel('not a model name!'), DEFAULT_LIVE_MODEL);
  assert.equal(resolveLiveModel('gemini-3.8-live'), 'gemini-3.8-live');
  assert.equal(resolveLiveModel('gemini-next-live'), 'gemini-next-live');
});

test('start validation: missing key is rejected before any connection', () => {
  // The .env.example placeholder is not a usable key.
  assert.equal(resolveServerApiKey('MY_GEMINI_API_KEY'), '');
  assert.equal(resolveServerApiKey('  '), '');
  assert.equal(resolveServerApiKey(undefined), '');
  assert.equal(resolveServerApiKey(' real-key '), 'real-key');

  const result = validateStartRequest(
    { model: DEFAULT_LIVE_MODEL },
    { serverApiKey: resolveServerApiKey('MY_GEMINI_API_KEY'), targetModel: DEFAULT_LIVE_MODEL }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'API_KEY_MISSING');
    assert.match(result.error, /API key/);
  }
});

test('start validation: an unknown model is rejected, not silently substituted', () => {
  const result = validateStartRequest(
    { model: 'gemini-2.0-flash-live', apiKey: 'client-key' },
    { serverApiKey: '', targetModel: DEFAULT_LIVE_MODEL }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_MODEL');
    assert.match(result.error, new RegExp(DEFAULT_LIVE_MODEL));
  }
});

test('start validation: client key overrides, server key is the fallback', () => {
  const clientKey = validateStartRequest(
    { model: DEFAULT_LIVE_MODEL, apiKey: '  client-key  ' },
    { serverApiKey: 'server-key', targetModel: DEFAULT_LIVE_MODEL }
  );
  assert.deepEqual(clientKey, {
    ok: true,
    model: DEFAULT_LIVE_MODEL,
    apiKey: 'client-key',
  });

  const serverKey = validateStartRequest(
    { model: DEFAULT_LIVE_MODEL },
    { serverApiKey: 'server-key', targetModel: DEFAULT_LIVE_MODEL }
  );
  assert.equal(serverKey.ok, true);
  if (serverKey.ok) assert.equal(serverKey.apiKey, 'server-key');
});

test('live config: voice and language instruction are wired for the native-audio model', () => {
  const language = resolveLanguagePreference('ar-SA');
  const config = buildLiveConfig({ voice: 'Kore', language, model: 'gemini-3.8-live' });

  assert.deepEqual(config.responseModalities, ['AUDIO']);
  // Sales copilot enables input audio transcription for customer speech
  // and output audio transcription for private text guidance.
  assert.deepEqual(config.inputAudioTranscription, {});
  assert.deepEqual(config.outputAudioTranscription, {});
  // Gemini Live does not support responseModalities: [TEXT]
  assert.equal(supportsTextResponseModality('gemini-3.8-live'), false);
  // Google documents that native-audio models choose the language themselves
  // and do not support an explicit language code.
  assert.equal(config.speechConfig?.languageCode, undefined);
  assert.equal(config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, 'Kore');
  assert.match(String(config.systemInstruction), /Arabic/);
  assert.match(String(config.systemInstruction), /Never switch to another language/i);
  // Long sessions must not fail on context growth.
  assert.ok(config.contextWindowCompression?.slidingWindow);
  // A fresh session opts into resumption updates but carries no handle.
  assert.deepEqual(config.sessionResumption, {});
});

test('live config: languageCode is sent only for models documented to support it', () => {
  const language = resolveLanguagePreference('en-US');

  assert.equal(isNativeAudioModel('gemini-3.8-live'), true);
  assert.equal(isNativeAudioModel('gemini-3.8-live-extended-thinking'), true);
  assert.equal(isNativeAudioModel('gemini-2.0-flash-live-001'), false);
  assert.equal(supportsSpeechLanguageCode('gemini-3.8-live'), false);
  assert.equal(supportsSpeechLanguageCode('gemini-2.0-flash-live-001'), true);

  const legacy = buildLiveConfig({
    voice: 'Kore',
    language,
    model: 'gemini-2.0-flash-live-001',
  });
  assert.equal(legacy.speechConfig?.languageCode, 'en-US');

  const explicit = buildLiveConfig({
    voice: 'Kore',
    language,
    model: 'gemini-3.8-live',
    supportsLanguageCode: true,
  });
  assert.equal(explicit.speechConfig?.languageCode, 'en-US');
});

test('live config: auto language sends no languageCode and keeps detection policy', () => {
  const config = buildLiveConfig({ voice: '', language: resolveLanguagePreference('') });
  assert.equal(config.speechConfig?.languageCode, undefined);
  assert.equal(config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, 'Puck');
  assert.match(String(config.systemInstruction), /first intelligible utterance/i);
});

test('live config: resumption handle is used only when resuming', () => {
  const config = buildLiveConfig({
    voice: 'Puck',
    language: resolveLanguagePreference('en-US'),
    resumptionHandle: 'handle-123',
  });
  assert.deepEqual(config.sessionResumption, { handle: 'handle-123' });
});

test('live config: a resumed session keeps the locked language policy', () => {
  const config = buildLiveConfig({
    voice: 'Puck',
    language: resolveLanguagePreference('ar-SA'),
    resumptionHandle: 'handle-abc',
    baseSystemInstruction: 'Be concise.',
    model: 'gemini-3.8-live',
  });
  // Native-audio sessions are locked by instruction, not by an unsupported
  // languageCode field.
  assert.equal(config.speechConfig?.languageCode, undefined);
  assert.match(String(config.systemInstruction), /Arabic/);
  assert.match(String(config.systemInstruction), /Never switch to another language/i);
  assert.deepEqual(config.sessionResumption, { handle: 'handle-abc' });
});

test('live config: base instruction is preserved verbatim ahead of the policy', () => {
  const config = buildLiveConfig({
    voice: 'Puck',
    language: resolveLanguagePreference('en-US'),
    baseSystemInstruction: 'Custom persona.',
  });
  assert.match(String(config.systemInstruction), /^Custom persona\./);
});

test('errors: API failures map to stable client-facing codes', () => {
  assert.equal(classifyLiveError('API key not valid. Please pass a valid API key.'), 'AUTH_ERROR');
  assert.equal(classifyLiveError('UNAUTHENTICATED'), 'AUTH_ERROR');
  assert.equal(classifyLiveError('RESOURCE_EXHAUSTED: quota exceeded'), 'QUOTA_EXHAUSTED');
  assert.equal(classifyLiveError('HTTP 429 Too Many Requests'), 'RATE_LIMITED');
  assert.equal(classifyLiveError('model not found'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyLiveError(''), 'API_ERROR');
});

test('reconnect policy: init failures fail closed, ready sessions resume only with a handle', () => {
  const base = {
    sawSessionReady: true,
    hasResumeHandle: true,
    reconnectAttempts: 0,
    maxAttempts: 2,
  };
  assert.equal(decideAfterTransportClose({ ...base, sawSessionReady: false }), 'fail_initial');
  assert.equal(decideAfterTransportClose(base), 'resume');
  assert.equal(decideAfterTransportClose({ ...base, hasResumeHandle: false }), 'close');
  assert.equal(decideAfterTransportClose({ ...base, reconnectAttempts: 2 }), 'close');
});
