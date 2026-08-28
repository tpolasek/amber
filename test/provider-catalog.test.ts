import test from "node:test";
import assert from "node:assert/strict";
import { ProviderCatalog } from "../src/provider-catalog.js";
import type { AmberSettings } from "../src/settings.js";

test("discovers every provider model and merges configured overrides", async () => {
  const requests: URL[] = [];
  const settings: AmberSettings = {
    default_provider: "zai",
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "zai-key",
        auth_url: "https://zai.example.test/anthropic",
        default_model: "glm-5.3",
        thinking_level: "max",
        compact_tokens: 200_000,
        models: {
          "glm-5.3": { thinking_level: "low", compact_tokens: 100_000 },
          "custom-glm": { thinking_level: "high" },
        },
      },
      deepseek: {
        api: "anthropic",
        auth_key: "deepseek-key",
        auth_url: "https://deepseek.example.test/anthropic",
        models: {},
      },
    },
    agents: [],
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === "deepseek.example.test") {
      return Response.json({ data: [{ id: "deepseek-v4", display_name: "DeepSeek V4" }], has_more: false });
    }
    if (!url.searchParams.has("after_id")) {
      return Response.json({
        data: [{ id: "glm-5.3", display_name: "GLM 5.3" }],
        has_more: true,
        last_id: "glm-5.3",
      });
    }
    return Response.json({ data: [{ id: "glm-5.3-flash", display_name: "GLM 5.3 Flash" }], has_more: false });
  };

  const catalog = await ProviderCatalog.load(settings, fetcher);

  assert.equal(catalog.defaultModel, "zai/glm-5.3");
  assert.deepEqual(catalog.models, [
    {
      key: "zai/glm-5.3",
      provider: "zai",
      api: "anthropic",
      model: "glm-5.3",
      displayName: "GLM 5.3",
      thinkingLevel: "low",
      compactTokens: 100_000,
    },
    {
      key: "zai/glm-5.3-flash",
      provider: "zai",
      api: "anthropic",
      model: "glm-5.3-flash",
      displayName: "GLM 5.3 Flash",
      thinkingLevel: "max",
      compactTokens: 200_000,
    },
    {
      key: "zai/custom-glm",
      provider: "zai",
      api: "anthropic",
      model: "custom-glm",
      displayName: "custom-glm",
      thinkingLevel: "high",
      compactTokens: 200_000,
    },
    {
      key: "deepseek/deepseek-v4",
      provider: "deepseek",
      api: "anthropic",
      model: "deepseek-v4",
      displayName: "DeepSeek V4",
      thinkingLevel: "max",
    },
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.pathname, "/anthropic/v1/models");
  assert.equal(requests[1]?.searchParams.get("after_id"), "glm-5.3");
  assert.equal(catalog.provider("zai/glm-5.3").model, "glm-5.3");
  assert.throws(() => catalog.provider("missing/model"), /not configured/);
});

test("uses explicit models when discovery is unavailable", async () => {
  const settings: AmberSettings = {
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "key",
        auth_url: "https://zai.example.test",
        default_model: "glm-5.3",
        models: { "glm-5.3": {} },
      },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  const catalog = await ProviderCatalog.load(settings, unavailable);
  assert.equal(catalog.defaultModel, "zai/glm-5.3");
  assert.deepEqual(catalog.models.map((model) => model.key), ["zai/glm-5.3"]);
});

test("selects a provider default for agents independently of the session provider", async () => {
  const settings: AmberSettings = {
    default_provider: "zai",
    default_agent_provider: "openai",
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "key",
        auth_url: "https://zai.example.test",
        default_model: "glm-main",
        models: {},
      },
      openai: {
        api: "openai",
        auth_key: "key",
        auth_url: "https://openai.example.test",
        default_model: "gpt-agent",
        models: {},
      },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  const catalog = await ProviderCatalog.load(settings, unavailable);
  assert.equal(catalog.defaultModel, "zai/glm-main");
  assert.equal(catalog.defaultAgentModel, "openai/gpt-agent");
});

test("default agent model overrides its provider default and remains available without discovery", async () => {
  const settings: AmberSettings = {
    default_provider: "zai",
    default_agent_provider: "zai",
    default_agent_model: "glm-agent",
    providers: {
      zai: {
        api: "anthropic",
        auth_key: "key",
        auth_url: "https://zai.example.test",
        default_model: "glm-main",
        models: {},
      },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  const catalog = await ProviderCatalog.load(settings, unavailable);
  assert.equal(catalog.defaultModel, "zai/glm-main");
  assert.equal(catalog.defaultAgentModel, "zai/glm-agent");
  assert.deepEqual(catalog.models.map((model) => model.key), ["zai/glm-main", "zai/glm-agent"]);
});

test("requires discovery when no models are configured", async () => {
  const settings: AmberSettings = {
    providers: {
      deepseek: { api: "anthropic", auth_key: "key", auth_url: "https://deepseek.example.test", models: {} },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  await assert.rejects(ProviderCatalog.load(settings, unavailable), /Could not discover models/);
});

test("requires provider configuration in settings", async () => {
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });
  await assert.rejects(
    ProviderCatalog.load({ providers: {}, agents: [] }, unavailable),
    /Configure at least one provider/,
  );
});

test("authenticates model discovery with bearer credentials from settings", async () => {
  const requests: RequestInit[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init ?? {});
    return Response.json({ data: [{ id: "claude-test" }], has_more: false });
  };
  const catalog = await ProviderCatalog.load({
    providers: {
      anthropic: {
        api: "anthropic",
        auth_key: "api-key",
        auth_url: "https://anthropic.example.test",
        models: {},
      },
    },
    agents: [],
  }, fetcher);

  const headers = new Headers(requests[0]?.headers);
  assert.equal(headers.get("authorization"), "Bearer api-key");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(catalog.defaultModel, "anthropic/claude-test");
});

test("discovers OpenAI models with bearer auth and creates an OpenAI provider", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return Response.json({ object: "list", data: [{ id: "gpt-test" }, { id: "gpt-fast" }] });
  };
  const catalog = await ProviderCatalog.load({
    default_provider: "openai",
    providers: {
      openai: {
        api: "openai",
        auth_key: "openai-key",
        auth_url: "https://api.openai.com/v1",
        default_model: "gpt-test",
        thinking_level: "high",
        models: {},
      },
    },
    agents: [],
  }, fetcher);

  assert.equal(requestUrl, "https://api.openai.com/v1/models");
  assert.equal(requestHeaders.get("authorization"), "Bearer openai-key");
  assert.equal(requestHeaders.get("anthropic-version"), null);
  assert.deepEqual(catalog.models.map(({ key, api }) => ({ key, api })), [
    { key: "openai/gpt-test", api: "openai" },
    { key: "openai/gpt-fast", api: "openai" },
  ]);
  assert.equal(catalog.defaultModel, "openai/gpt-test");
  assert.equal(catalog.provider(undefined).protocol, "openai");
});

test("uses OAuth-backed Codex discovery and provider requests", async () => {
  let authResolutions = 0;
  const settings: AmberSettings = {
    default_provider: "openai-codex",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        auth_url: "https://chatgpt.com/backend-api",
        default_model: "gpt-codex",
        models: {},
      },
    },
    agents: [],
  };
  const fetcher: typeof fetch = async () => Response.json({
    models: [{ slug: "gpt-codex", display_name: "GPT Codex", supported_in_api: true, visibility: "list" }],
  });

  const catalog = await ProviderCatalog.load(settings, fetcher, {
    openAICodexAuth: async () => {
      authResolutions++;
      return { accessToken: "oauth-access", accountId: "account-1" };
    },
  });

  assert.equal(authResolutions, 1);
  assert.equal(catalog.defaultModel, "openai-codex/gpt-codex");
  assert.deepEqual(catalog.models.map(({ key, displayName }) => ({ key, displayName })), [
    { key: "openai-codex/gpt-codex", displayName: "GPT Codex" },
  ]);
  assert.equal(catalog.provider(undefined).protocol, "openai");
});

test("keeps configured Codex models available before login", async () => {
  const catalog = await ProviderCatalog.load({
    default_provider: "openai-codex",
    providers: {
      "openai-codex": {
        api: "openai",
        auth: "openai-codex",
        auth_url: "https://chatgpt.com/backend-api",
        default_model: "gpt-codex",
        models: {},
      },
    },
    agents: [],
  }, async () => { throw new Error("not signed in"); }, {
    openAICodexAuth: async () => { throw new Error("not signed in"); },
  });

  assert.deepEqual(catalog.models.map((model) => model.key), ["openai-codex/gpt-codex"]);
});

test("defaults each protocol to its own top thinking level", async () => {
  const fetcher: typeof fetch = async () => Response.json({ data: [{ id: "model-test" }] });
  const settings = (api: "anthropic" | "openai") => ({
    default_provider: "provider",
    providers: { provider: { api, auth_key: "key", auth_url: "https://example.test", models: {} } },
    agents: [],
  });
  const anthropic = await ProviderCatalog.load(settings("anthropic"), fetcher);
  const openai = await ProviderCatalog.load(settings("openai"), fetcher);

  assert.equal(anthropic.models[0]?.thinkingLevel, "max");
  assert.equal(openai.models[0]?.thinkingLevel, "xhigh");
});
