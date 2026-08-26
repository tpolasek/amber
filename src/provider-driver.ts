import type { LlmProvider, ProviderProtocol, ThinkingLevel } from "./types.js";

export interface ProviderConnection {
  name: string;
  authKey: string;
  baseUrl: string;
}

export interface DiscoveredModel {
  id: string;
  displayName: string;
}

export interface ProviderModelConnection extends ProviderConnection {
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface ProviderDriver {
  readonly protocol: ProviderProtocol;
  readonly defaultThinkingLevel: ThinkingLevel;
  discoverModels(connection: ProviderConnection, fetcher: typeof fetch): Promise<DiscoveredModel[]>;
  createProvider(connection: ProviderModelConnection): LlmProvider;
}

export function providerApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/${path.replace(/^\/+/, "")}`;
}
