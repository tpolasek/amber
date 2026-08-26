import { AnthropicProvider } from "./provider.js";
import { configuredSetting, type AmberSettings, type ProviderSettings, type ThinkingLevel } from "./settings.js";
import type { LlmProvider } from "./types.js";

type ResolvedProvider = ProviderSettings & {
  credentialType: "api-key" | "bearer";
};

export interface AvailableModel {
  key: string;
  provider: string;
  model: string;
  displayName: string;
  thinkingLevel: ThinkingLevel;
  compactTokens?: number;
}

interface DiscoveredModel {
  id: string;
  displayName: string;
}

interface ModelsResponse {
  data?: Array<{ id?: unknown; display_name?: unknown }>;
  has_more?: unknown;
  last_id?: unknown;
}

export class ProviderCatalog {
  readonly models: AvailableModel[];
  readonly defaultModel: string;
  readonly #providers: Map<string, LlmProvider>;

  private constructor(models: AvailableModel[], defaultModel: string, providers: Map<string, LlmProvider>) {
    this.models = models;
    this.defaultModel = defaultModel;
    this.#providers = providers;
  }

  static async load(
    environment: NodeJS.ProcessEnv,
    settings: AmberSettings,
    fetchModelList: typeof fetch = fetch,
  ): Promise<ProviderCatalog> {
    const configuredProviders = providerEntries(environment, settings);
    if (configuredProviders.length === 0) {
      throw new Error("Configure at least one provider in ~/.amber/settings.toml");
    }

    const models: AvailableModel[] = [];
    const providers = new Map<string, LlmProvider>();
    const providerDefaults = new Map<string, string>();
    for (const [providerName, provider] of configuredProviders) {
      const explicitModelNames = Object.keys(provider.models);
      const fallbackModels = [...new Set([
        ...explicitModelNames,
        ...(configuredSetting(provider.default_model) ? [configuredSetting(provider.default_model)!] : []),
      ])];
      let discovered: DiscoveredModel[];
      try {
        discovered = await discoverModels(provider.auth_url, provider.auth_key, provider.credentialType, fetchModelList);
      } catch (error) {
        if (fallbackModels.length === 0) {
          throw new Error(`Could not discover models for provider '${providerName}': ${errorMessage(error)}`);
        }
        discovered = fallbackModels.map((id) => ({ id, displayName: id }));
      }
      const discoveredById = new Map(discovered.map((model) => [model.id, model]));
      for (const modelName of explicitModelNames) {
        if (!discoveredById.has(modelName)) {
          discovered.push({ id: modelName, displayName: modelName });
          discoveredById.set(modelName, discovered.at(-1)!);
        }
      }
      const defaultModelName = configuredSetting(provider.default_model) ?? discovered[0]?.id;
      if (!defaultModelName) throw new Error(`Provider '${providerName}' returned no models`);
      if (!discoveredById.has(defaultModelName)) {
        discovered.unshift({ id: defaultModelName, displayName: defaultModelName });
      }
      const defaultKey = `${providerName}/${defaultModelName}`;
      providerDefaults.set(providerName, defaultKey);

      for (const discoveredModel of discovered) {
        const override = provider.models[discoveredModel.id];
        const thinkingLevel = override?.thinking_level ?? provider.thinking_level ?? "max";
        const compactTokens = override?.compact_tokens ?? provider.compact_tokens;
        const key = `${providerName}/${discoveredModel.id}`;
        models.push({
          key,
          provider: providerName,
          model: discoveredModel.id,
          displayName: discoveredModel.displayName,
          thinkingLevel,
          ...(compactTokens !== undefined ? { compactTokens } : {}),
        });
        providers.set(key, new AnthropicProvider({
          name: providerName,
          ...(provider.credentialType === "api-key"
            ? { apiKey: provider.auth_key }
            : { authToken: provider.auth_key }),
          baseUrl: provider.auth_url,
          model: discoveredModel.id,
          thinkingLevel,
        }));
      }
    }

    const defaultProvider = settings.default_provider ?? configuredProviders[0]![0];
    const defaultModel = providerDefaults.get(defaultProvider);
    if (!defaultModel) throw new Error(`Default provider '${defaultProvider}' has no models`);
    return new ProviderCatalog(models, defaultModel, providers);
  }

  provider(modelKey: string | undefined): LlmProvider {
    const key = modelKey ?? this.defaultModel;
    const provider = this.#providers.get(key);
    if (!provider) throw new Error(`Model '${key}' is not configured`);
    return provider;
  }

  model(modelKey: string | undefined): AvailableModel {
    const key = modelKey ?? this.defaultModel;
    const model = this.models.find((candidate) => candidate.key === key);
    if (!model) throw new Error(`Model '${key}' is not configured`);
    return model;
  }

  has(modelKey: string): boolean {
    return this.#providers.has(modelKey);
  }
}

async function discoverModels(
  baseUrl: string,
  authKey: string,
  credentialType: ResolvedProvider["credentialType"],
  fetchModelList: typeof fetch,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let afterId: string | undefined;
  for (;;) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/v1/models`);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await fetchModelList(url, {
      headers: {
        "anthropic-version": "2023-06-01",
        ...(credentialType === "api-key"
          ? { "x-api-key": authKey }
          : { authorization: `Bearer ${authKey}` }),
      },
    });
    if (!response.ok) throw new Error(`model list failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as ModelsResponse;
    for (const candidate of body.data ?? []) {
      if (typeof candidate.id !== "string" || !candidate.id || candidate.id.includes("/")) continue;
      models.push({
        id: candidate.id,
        displayName: typeof candidate.display_name === "string" && candidate.display_name
          ? candidate.display_name
          : candidate.id,
      });
    }
    if (body.has_more !== true || typeof body.last_id !== "string" || !body.last_id) break;
    afterId = body.last_id;
  }
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function providerEntries(
  environment: NodeJS.ProcessEnv,
  settings: AmberSettings,
): Array<[string, ResolvedProvider]> {
  const entries = Object.entries(settings.providers);
  if (entries.length > 0) {
    const defaultProvider = settings.default_provider ?? entries[0]![0];
    return entries.map(([name, provider]) => {
      const environmentAuthToken = name === defaultProvider
        ? configuredSetting(environment.ANTHROPIC_AUTH_TOKEN)
        : undefined;
      const environmentApiKey = name === defaultProvider
        ? configuredSetting(environment.ANTHROPIC_API_KEY)
        : undefined;
      const environmentAuth = environmentAuthToken ?? environmentApiKey;
      const authKey = environmentAuth ?? configuredSetting(provider.auth_key);
      if (!authKey) throw new Error(`Set providers.${name}.auth_key in ~/.amber/settings.toml`);
      const authUrl = name === defaultProvider
        ? configuredSetting(environment.ANTHROPIC_BASE_URL) ?? configuredSetting(provider.auth_url)
        : configuredSetting(provider.auth_url);
      if (!authUrl) throw new Error(`Set providers.${name}.auth_url in ~/.amber/settings.toml`);
      const environmentModel = name === defaultProvider ? configuredSetting(environment.ANTHROPIC_MODEL) : undefined;
      return [name, {
        ...provider,
        auth_key: authKey,
        auth_url: authUrl,
        credentialType: environmentAuthToken ? "bearer" : environmentApiKey ? "api-key" : "bearer",
        ...(environmentModel ? { default_model: environmentModel } : {}),
      }];
    });
  }
  const authToken = configuredSetting(environment.ANTHROPIC_AUTH_TOKEN);
  const apiKey = configuredSetting(environment.ANTHROPIC_API_KEY);
  const authKey = authToken ?? apiKey;
  const model = configuredSetting(environment.ANTHROPIC_MODEL);
  if (!authKey || !model) return [];
  return [["default", {
    auth_key: authKey,
    auth_url: configuredSetting(environment.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
    default_model: model,
    models: { [model]: {} },
    credentialType: authToken ? "bearer" : "api-key",
  }]];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
