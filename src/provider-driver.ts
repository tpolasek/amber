import type { LlmProvider, ProviderProtocol, ProviderSystemBlock, ThinkingLevel } from "./types.js";

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
  /** Per-response output token cap sent as max_tokens/max_output_tokens. */
  maxOutputTokens?: number;
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

/** Maps a driver connection onto the constructor options every provider shares. */
export function providerConnectionOptions(connection: ProviderModelConnection) {
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    model: connection.model,
    thinkingLevel: connection.thinkingLevel,
    ...(connection.maxOutputTokens !== undefined ? { maxOutputTokens: connection.maxOutputTokens } : {}),
  };
}

export function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

export const DEFAULT_SYSTEM_PROMPT = "You are an expert coding agent working through a web terminal. Be direct, precise, and use Markdown when it improves clarity.";

export function systemText(system: string | ProviderSystemBlock[] | undefined): string {
  if (typeof system === "string") return system;
  if (system) return system.map((block) => block.text).join("\n\n");
  return DEFAULT_SYSTEM_PROMPT;
}

export function extractApiError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || "Unknown error";
  }
}
