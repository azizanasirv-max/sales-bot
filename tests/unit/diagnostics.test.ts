import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticsReport, QUOTA_STATUS_NOTICE } from '../../src/lib/diagnostics';

test('diagnostics export: includes the expected diagnostics fields', () => {
  const report = buildDiagnosticsReport({
    modelId: 'gemini-3.8-live',
    sessionDiagnostics: { rttTransportLatencyMs: 12 },
    activeGenerationId: 'gen_4',
    language: 'English (US)',
    hasConfiguredApiKey: true,
    authSource: 'user_provided_key',
    microphoneDevice: 'Built-in Mic',
    recentEvents: [{ id: '1' }, { id: '2' }, { id: '3' }],
  });
  assert.equal(report.modelId, 'gemini-3.8-live');
  assert.equal(report.authSource, 'user_provided_key');
  assert.equal(report.quotaStatusNotice, QUOTA_STATUS_NOTICE);
  assert.equal(report.recentEvents.length, 3);
});

test('diagnostics export: never copies credentials from extra input properties', () => {
  const secret = 'AIzaSyFakeSecretForDiagnosticsTest123';
  const input = {
    modelId: 'gemini-3.8-live',
    sessionDiagnostics: { sessionId: 'sess_1' },
    activeGenerationId: 'gen_0',
    language: 'Auto',
    hasConfiguredApiKey: true,
    authSource: 'user_provided_key' as const,
    microphoneDevice: 'None',
    recentEvents: [],
    // A future caller might spread state that still contains the key. The
    // whitelist must drop it.
    apiKey: secret,
    GEMINI_API_KEY: secret,
  };

  const serialized = JSON.stringify(buildDiagnosticsReport(input));
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('GEMINI_API_KEY'), false);
});

test('diagnostics export: bounds the recent-events payload', () => {
  const events = Array.from({ length: 120 }, (_, index) => ({ id: String(index) }));
  const report = buildDiagnosticsReport({
    modelId: 'gemini-3.8-live',
    sessionDiagnostics: null,
    activeGenerationId: 'gen_0',
    language: 'Auto',
    hasConfiguredApiKey: false,
    authSource: 'none',
    microphoneDevice: 'None',
    recentEvents: events,
  });
  assert.equal(report.recentEvents.length, 50);
});
