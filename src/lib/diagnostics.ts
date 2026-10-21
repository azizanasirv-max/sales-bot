/**
 * Diagnostics export builder.
 *
 * Whitelists exactly the fields that may leave the browser. Credentials are
 * never accepted as input, so no future call site can accidentally include an
 * API key by spreading a state object into the report.
 */

export interface DiagnosticsReportInput {
  modelId: string;
  sessionDiagnostics: unknown;
  activeGenerationId: string;
  language: string;
  hasConfiguredApiKey: boolean;
  authSource: 'user_provided_key' | 'server_env_key' | 'none';
  microphoneDevice: string;
  recentEvents: readonly unknown[];
}

export const QUOTA_STATUS_NOTICE =
  'Remaining account quota is not exposed by this session API.';

export function buildDiagnosticsReport(input: DiagnosticsReportInput) {
  return {
    modelId: input.modelId,
    sessionDiagnostics: input.sessionDiagnostics,
    activeGenerationId: input.activeGenerationId,
    language: input.language,
    hasConfiguredApiKey: input.hasConfiguredApiKey,
    authSource: input.authSource,
    microphoneDevice: input.microphoneDevice,
    quotaStatusNotice: QUOTA_STATUS_NOTICE,
    recentEvents: input.recentEvents.slice(0, 50),
  };
}
