import type { HarnessConfig } from '../../shared/types';
import type { GlobalSettingSection } from '../app/route';

export function globalSettingSectionValue(section: GlobalSettingSection, value: HarnessConfig) {
  if (section === 'models')
    return {
      provider: value.provider,
      providerBaseUrl: value.providerBaseUrl,
      modelProviders: value.modelProviders,
      agents: value.agents,
    };
  if (section === 'browser') return value.mcp;
  if (section === 'object-storage') return value.oss;
  if (section === 'local-data') return value.local.retentionDays;
  return null;
}

export function globalSettingSectionPatch(section: GlobalSettingSection, value: HarnessConfig) {
  if (section === 'models')
    return {
      provider: value.provider,
      providerBaseUrl: value.providerBaseUrl,
      modelProviders: value.modelProviders,
      agents: value.agents,
    };
  if (section === 'browser')
    return { mcp: { ...value.mcp, browser: 'chromium' as const, headless: true } };
  if (section === 'object-storage') return { oss: value.oss };
  return { local: { retentionDays: value.local.retentionDays } };
}

export function withoutModelProviderSource(value: HarnessConfig, sourceId: string): HarnessConfig {
  const modelProviders = value.modelProviders.filter((source) => source.id !== sourceId);
  const firstSourceId = value.modelProviders[0]?.id || 'default';
  const agents = { ...value.agents };
  for (const role of ['main', 'runner', 'reviewer'] as const) {
    const selectedSourceId = value.agents[role].providerSourceId || firstSourceId;
    if (selectedSourceId !== sourceId) continue;
    agents[role] = {
      providerSourceId: '',
      model: '',
      thinking: role === 'runner' ? 'off' : 'low',
    };
  }
  return {
    ...value,
    modelProviders,
    provider: modelProviders[0]?.provider ?? '',
    providerBaseUrl: modelProviders[0]?.baseUrl ?? '',
    agents,
  };
}
