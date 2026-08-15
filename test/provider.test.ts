import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createProvider } from "../src/provider.js";

test("uses bearer auth and parses Anthropic-compatible streaming events", async (context) => {
  let receivedAuthorization = "";
  let receivedPath = "";
  let receivedBetas = "";
  let receivedUserAgent = "";
  let receivedSdkVersion = "";
  let receivedModel = "";
  let receivedThinking: unknown;
  let receivedTools: unknown;
  let receivedMaxTokens = 0;
  const gateway = createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization ?? "";
    receivedPath = request.url ?? "";
    receivedBetas = String(request.headers["anthropic-beta"] ?? "");
    receivedUserAgent = request.headers["user-agent"] ?? "";
    receivedSdkVersion = String(request.headers["x-stainless-package-version"] ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      max_tokens: number;
      thinking?: unknown;
      tools?: unknown;
    };
    receivedModel = body.model;
    receivedMaxTokens = body.max_tokens;
    receivedThinking = body.thinking;
    receivedTools = body.tools;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"cache_creation_input_tokens":40,"cache_read_input_tokens":100}}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Working it out"}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"signed-thought"}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool-1","name":"Bash","input":{}}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"pwd\\"}"}}\n\n');
    response.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const provider = createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_MODEL: "glm-test",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  }, {
    auth_key: "settings-token",
    default_model: "settings-model",
    auth_url: "https://settings.example.test",
  });
  const events = [];
  const tools = [{ name: "Bash", description: "Run a command", input_schema: { type: "object" as const, properties: {} } }];
  for await (const event of provider.stream(
    [{ role: "user", content: "Hi" }],
    new AbortController().signal,
    { tools },
  )) {
    events.push(event);
  }

  assert.equal(receivedAuthorization, "Bearer test-token");
  assert.equal(receivedPath, "/v1/messages?beta=true");
  assert.equal(receivedBetas, "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24");
  assert.equal(receivedUserAgent, "claude-cli/2.1.88 (undefined, sdk-cli)");
  assert.equal(receivedSdkVersion, "0.74.0");
  assert.equal(receivedModel, "glm-test");
  assert.equal(receivedMaxTokens, 32_000);
  assert.deepEqual(receivedThinking, { type: "adaptive" });
  assert.deepEqual(receivedTools, tools);
  assert.deepEqual(events, [
    { type: "usage", usage: { input: 149 } },
    { type: "thinking_delta", thinking: "Working it out" },
    { type: "thinking_signature_delta", signature: "signed-thought" },
    { type: "delta", text: "Hello" },
    { type: "tool_use_start", index: 2, id: "tool-1", name: "Bash" },
    { type: "tool_input_delta", index: 2, partialJson: '{"command":"pwd"}' },
    { type: "usage", usage: { output: 2 } },
    { type: "done", stopReason: "end_turn" },
  ]);
});

test("requires credentials and an explicit model", () => {
  assert.throws(() => createProvider({}), /ANTHROPIC_AUTH_TOKEN/);
  assert.throws(() => createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
  }), /ANTHROPIC_MODEL/);
  assert.throws(() => createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_MODEL: "   ",
  }), /ANTHROPIC_MODEL/);
  const provider = createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_MODEL: "mimo-v2.5",
  });
  assert.equal(provider.model, "mimo-v2.5");
  assert.equal(provider.mode, "live");
});

test("uses independent agent overrides with application fallbacks", async (context) => {
  const requests: Array<{ authorization: string; apiKey: string; model: string }> = [];
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    requests.push({
      authorization: request.headers.authorization ?? "",
      apiKey: String(request.headers["x-api-key"] ?? ""),
      model: body.model,
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const overridden = createProvider({
    ANTHROPIC_API_KEY: "application-api-key",
    ANTHROPIC_MODEL: "application-model",
    ANTHROPIC_BASE_URL: "https://unused.example.test",
  }, {}, {
    auth_key: "agent-token",
    model: "agent-model",
    auth_url: baseUrl,
  });
  for await (const _event of overridden.stream([], new AbortController().signal)) { /* drain */ }

  const inherited = createProvider({
    ANTHROPIC_AUTH_TOKEN: "application-token",
    ANTHROPIC_MODEL: "application-model",
    ANTHROPIC_BASE_URL: baseUrl,
  }, {}, { model: "specialized-model" });
  for await (const _event of inherited.stream([], new AbortController().signal)) { /* drain */ }

  assert.deepEqual(requests, [
    { authorization: "Bearer agent-token", apiKey: "", model: "agent-model" },
    { authorization: "Bearer application-token", apiKey: "", model: "specialized-model" },
  ]);
});

test("uses settings with environment variable overrides", () => {
  const settings = {
    auth_key: "settings-token",
    auth_url: "https://settings.example.test",
    default_model: "settings-model",
  };
  assert.equal(createProvider({}, settings).model, "settings-model");
  assert.equal(createProvider({ ANTHROPIC_MODEL: "environment-model" }, settings).model, "environment-model");

  assert.throws(() => createProvider({
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_MODEL: "environment-model",
  }, settings), /ANTHROPIC_AUTH_TOKEN/);
  assert.throws(() => createProvider({}, {
    auth_key: "<INSERT_AUTH_KEY_HERE>",
    default_model: "<INSERT_DEFAULT_MODEL_HERE>",
  }), /auth_key/);
});
