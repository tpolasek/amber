import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYSTEM_PROMPT,
  extractApiError,
  providerApiUrl,
  providerConnectionOptions,
  systemText,
  uniqueModels,
  type DiscoveredModel,
  type ProviderModelConnection,
} from "../src/provider-driver.js";

test("providerApiUrl appends the v1 base once", () => {
  assert.equal(providerApiUrl("https://api.example.com", "messages"), "https://api.example.com/v1/messages");
  assert.equal(providerApiUrl("https://api.example.com/", "messages"), "https://api.example.com/v1/messages");
  assert.equal(providerApiUrl("https://api.example.com/v1", "/messages"), "https://api.example.com/v1/messages");
  assert.equal(providerApiUrl("https://api.example.com/v1/", "messages"), "https://api.example.com/v1/messages");
});

test("providerConnectionOptions maps connection fields and omits unset maxOutputTokens", () => {
  const base: ProviderModelConnection = {
    name: "main",
    authKey: "k",
    baseUrl: "https://api.example.com",
    model: "claude-3",
    thinkingLevel: "high",
  };
  assert.deepEqual(providerConnectionOptions(base), {
    name: "main",
    baseUrl: "https://api.example.com",
    model: "claude-3",
    thinkingLevel: "high",
  });
  assert.deepEqual(providerConnectionOptions({ ...base, maxOutputTokens: 4096 }), {
    name: "main",
    baseUrl: "https://api.example.com",
    model: "claude-3",
    thinkingLevel: "high",
    maxOutputTokens: 4096,
  });
});

test("uniqueModels deduplicates by id keeping the last entry", () => {
  const models: DiscoveredModel[] = [
    { id: "a", displayName: "first" },
    { id: "b", displayName: "b" },
    { id: "a", displayName: "second" },
  ];
  assert.deepEqual(uniqueModels(models), [
    { id: "a", displayName: "second" },
    { id: "b", displayName: "b" },
  ]);
});

test("systemText flattens system blocks and falls back to the default prompt", () => {
  assert.equal(systemText("plain"), "plain");
  assert.equal(
    systemText([{ text: "one", type: "text" }, { text: "two", type: "text", cache_control: { type: "ephemeral" } }]),
    "one\n\ntwo",
  );
  assert.equal(systemText(undefined), DEFAULT_SYSTEM_PROMPT);
});

test("extractApiError prefers the structured message and truncates junk", () => {
  assert.equal(extractApiError('{"error":{"message":"rate limited"}}'), "rate limited");
  assert.equal(extractApiError("not json"), "not json");
  assert.equal(extractApiError(""), "Unknown error");
  const long = "x".repeat(500);
  assert.equal(extractApiError(long).length, 300);
});
