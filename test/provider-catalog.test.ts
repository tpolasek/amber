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

  const catalog = await ProviderCatalog.load({}, settings, fetcher);

  assert.equal(catalog.defaultModel, "zai/glm-5.3");
  assert.deepEqual(catalog.models, [
    {
      key: "zai/glm-5.3",
      provider: "zai",
      model: "glm-5.3",
      displayName: "GLM 5.3",
      thinkingLevel: "low",
      compactTokens: 100_000,
    },
    {
      key: "zai/glm-5.3-flash",
      provider: "zai",
      model: "glm-5.3-flash",
      displayName: "GLM 5.3 Flash",
      thinkingLevel: "max",
      compactTokens: 200_000,
    },
    {
      key: "zai/custom-glm",
      provider: "zai",
      model: "custom-glm",
      displayName: "custom-glm",
      thinkingLevel: "high",
      compactTokens: 200_000,
    },
    {
      key: "deepseek/deepseek-v4",
      provider: "deepseek",
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
        auth_key: "key",
        auth_url: "https://zai.example.test",
        default_model: "glm-5.3",
        models: { "glm-5.3": {} },
      },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  const catalog = await ProviderCatalog.load({}, settings, unavailable);
  assert.equal(catalog.defaultModel, "zai/glm-5.3");
  assert.deepEqual(catalog.models.map((model) => model.key), ["zai/glm-5.3"]);
});

test("requires discovery when no models are configured", async () => {
  const settings: AmberSettings = {
    providers: {
      deepseek: { auth_key: "key", auth_url: "https://deepseek.example.test", models: {} },
    },
    agents: [],
  };
  const unavailable: typeof fetch = async () => new Response("not supported", { status: 404 });

  await assert.rejects(ProviderCatalog.load({}, settings, unavailable), /Could not discover models/);
});

test("preserves API-key authentication for environment overrides", async () => {
  const requests: RequestInit[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(init ?? {});
    return Response.json({ data: [{ id: "claude-test" }], has_more: false });
  };
  const catalog = await ProviderCatalog.load({
    ANTHROPIC_API_KEY: "api-key",
    ANTHROPIC_BASE_URL: "https://anthropic.example.test",
    ANTHROPIC_MODEL: "claude-test",
  }, { providers: {}, agents: [] }, fetcher);

  const headers = new Headers(requests[0]?.headers);
  assert.equal(headers.get("x-api-key"), "api-key");
  assert.equal(headers.get("authorization"), null);
  assert.equal(catalog.defaultModel, "default/claude-test");
});
