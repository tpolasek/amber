import { anthropicDriver } from "./provider.js";
import { openAIDriver } from "./openai-provider.js";
import { configuredSetting, type AmberSettings, type ProviderSettings } from "./settings.js";
import type { CredentialType, ProviderDriver } from "./provider-driver.js";
import type { LlmProvider, ProviderProtocol, ThinkingLevel } from "./types.js";

type ResolvedProvider = ProviderSettings & {
  credentialType: CredentialType;
};

export interface AvailableModel {
  key: string;
  provider: string;
  api: ProviderProtocol;
  model: string;
  displayName: string;
  thinkingLevel: ThinkingLevel;
  compactTokens?: number;
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
      const driver = driverFor(provider.api);
      const explicitModelNames = Object.keys(provider.models);
      const fallbackModels = [...new Set([
        ...explicitModelNames,
        ...(configuredSetting(provider.default_model) ? [configuredSetting(provider.default_model)!] : []),
      ])];
      let discovered;
      try {
        discovered = await driver.discoverModels({
          name: providerName,
          authKey: provider.auth_key,
          baseUrl: provider.auth_url,
          credentialType: provider.credentialType,
        }, fetchModelList);
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
        const thinkingLevel = override?.thinking_level ?? provider.thinking_level ?? driver.defaultThinkingLevel;
        const compactTokens = override?.compact_tokens ?? provider.compact_tokens;
        const key = `${providerName}/${discoveredModel.id}`;
        models.push({
          key,
          provider: providerName,
          api: provider.api,
          model: discoveredModel.id,
          displayName: discoveredModel.displayName,
          thinkingLevel,
          ...(compactTokens !== undefined ? { compactTokens } : {}),
        });
        providers.set(key, driver.createProvider({
          name: providerName,
          authKey: provider.auth_key,
          baseUrl: provider.auth_url,
          credentialType: provider.credentialType,
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

function providerEntries(
  environment: NodeJS.ProcessEnv,
  settings: AmberSettings,
): Array<[string, ResolvedProvider]> {
  const entries = Object.entries(settings.providers);
  if (entries.length > 0) {
    const defaultProvider = settings.default_provider ?? entries[0]![0];
    return entries.map(([name, provider]) => {
      const isDefault = name === defaultProvider;
      const environmentAuthToken = isDefault && provider.api === "anthropic"
        ? configuredSetting(environment.ANTHROPIC_AUTH_TOKEN)
        : undefined;
      const anthropicApiKey = isDefault && provider.api === "anthropic"
        ? configuredSetting(environment.ANTHROPIC_API_KEY)
        : undefined;
      const openAIApiKey = isDefault && provider.api === "openai"
        ? configuredSetting(environment.OPENAI_API_KEY)
        : undefined;
      const environmentAuth = environmentAuthToken ?? anthropicApiKey ?? openAIApiKey;
      const authKey = environmentAuth ?? configuredSetting(provider.auth_key);
      if (!authKey) throw new Error(`Set providers.${name}.auth_key in ~/.amber/settings.toml`);
      const environmentBaseUrl = isDefault
        ? configuredSetting(provider.api === "openai" ? environment.OPENAI_BASE_URL : environment.ANTHROPIC_BASE_URL)
        : undefined;
      const authUrl = environmentBaseUrl ?? configuredSetting(provider.auth_url);
      if (!authUrl) throw new Error(`Set providers.${name}.auth_url in ~/.amber/settings.toml`);
      const environmentModel = isDefault
        ? configuredSetting(provider.api === "openai" ? environment.OPENAI_MODEL : environment.ANTHROPIC_MODEL)
        : undefined;
      return [name, {
        ...provider,
        auth_key: authKey,
        auth_url: authUrl,
        credentialType: anthropicApiKey ? "api-key" : "bearer",
        ...(environmentModel ? { default_model: environmentModel } : {}),
      }];
    });
  }
  const authToken = configuredSetting(environment.ANTHROPIC_AUTH_TOKEN);
  const anthropicApiKey = configuredSetting(environment.ANTHROPIC_API_KEY);
  const anthropicModel = configuredSetting(environment.ANTHROPIC_MODEL);
  if ((authToken || anthropicApiKey) && anthropicModel) {
    return [["default", {
      api: "anthropic",
      auth_key: authToken ?? anthropicApiKey!,
      auth_url: configuredSetting(environment.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
      default_model: anthropicModel,
      models: { [anthropicModel]: {} },
      credentialType: authToken ? "bearer" : "api-key",
    }]];
  }
  const openAIKey = configuredSetting(environment.OPENAI_API_KEY);
  const openAIModel = configuredSetting(environment.OPENAI_MODEL);
  if (!openAIKey || !openAIModel) return [];
  return [["default", {
    api: "openai",
    auth_key: openAIKey,
    auth_url: configuredSetting(environment.OPENAI_BASE_URL) ?? "https://api.openai.com",
    default_model: openAIModel,
    models: { [openAIModel]: {} },
    credentialType: "bearer",
  }]];
}

function driverFor(protocol: ProviderProtocol): ProviderDriver {
  return protocol === "openai" ? openAIDriver : anthropicDriver;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
