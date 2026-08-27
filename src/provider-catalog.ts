import { anthropicDriver } from "./provider.js";
import { createOpenAICodexDriver, openAIDriver, type OpenAIAuthResolver } from "./openai-provider.js";
import { configuredSetting, type AmberSettings, type ProviderSettings } from "./settings.js";
import type { ProviderDriver } from "./provider-driver.js";
import type { LlmProvider, ProviderProtocol, ThinkingLevel } from "./types.js";

export interface AvailableModel {
  key: string;
  provider: string;
  api: ProviderProtocol;
  model: string;
  displayName: string;
  thinkingLevel: ThinkingLevel;
  compactTokens?: number;
}

export interface ProviderCatalogOptions {
  openAICodexAuth?: OpenAIAuthResolver;
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
    settings: AmberSettings,
    fetchModelList: typeof fetch = fetch,
    options: ProviderCatalogOptions = {},
  ): Promise<ProviderCatalog> {
    const configuredProviders = providerEntries(settings);
    if (configuredProviders.length === 0) {
      throw new Error("Configure at least one provider in ~/.amber/settings.toml");
    }

    const models: AvailableModel[] = [];
    const providers = new Map<string, LlmProvider>();
    const providerDefaults = new Map<string, string>();
    for (const [providerName, provider] of configuredProviders) {
      const driver = driverFor(provider, options.openAICodexAuth);
      const explicitModelNames = Object.keys(provider.models);
      const fallbackModels = [...new Set([
        ...explicitModelNames,
        ...(configuredSetting(provider.default_model) ? [configuredSetting(provider.default_model)!] : []),
      ])];
      let discovered;
      try {
        discovered = await driver.discoverModels({
          name: providerName,
          authKey: configuredSetting(provider.auth_key) ?? "",
          baseUrl: provider.auth_url,
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
          authKey: configuredSetting(provider.auth_key) ?? "",
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

function providerEntries(settings: AmberSettings): Array<[string, ProviderSettings]> {
  return Object.entries(settings.providers).map(([name, provider]) => {
    if (provider.auth !== "openai-codex" && !configuredSetting(provider.auth_key)) {
      throw new Error(`Set providers.${name}.auth_key in ~/.amber/settings.toml`);
    }
    if (!configuredSetting(provider.auth_url)) {
      throw new Error(`Set providers.${name}.auth_url in ~/.amber/settings.toml`);
    }
    return [name, provider];
  });
}

function driverFor(provider: ProviderSettings, openAICodexAuth?: OpenAIAuthResolver): ProviderDriver {
  if (provider.auth === "openai-codex") {
    return createOpenAICodexDriver(openAICodexAuth ?? (async () => {
      throw new Error("OpenAI Codex is not signed in. Open Auth settings to connect ChatGPT.");
    }));
  }
  return provider.api === "openai" ? openAIDriver : anthropicDriver;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
