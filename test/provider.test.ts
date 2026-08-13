import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicProvider, createProvider } from "../src/provider.js";

test("uses bearer auth and parses Anthropic-compatible streaming events", async (context) => {
  let receivedAuthorization = "";
  let receivedPath = "";
  let receivedModel = "";
  let receivedThinking: unknown;
  let receivedTools: unknown;
  let receivedMaxTokens = 0;
  const gateway = createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization ?? "";
    receivedPath = request.url ?? "";
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
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n');
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

  const provider = new AnthropicProvider({
    authToken: "test-token",
    model: "glm-test",
    baseUrl: `http://127.0.0.1:${address.port}`,
    thinkingBudgetTokens: 2048,
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
  assert.equal(receivedPath, "/v1/messages");
  assert.equal(receivedModel, "glm-test");
  assert.equal(receivedMaxTokens, 10_240);
  assert.deepEqual(receivedThinking, { type: "enabled", budget_tokens: 2048 });
  assert.deepEqual(receivedTools, tools);
  assert.deepEqual(events, [
    { type: "usage", usage: { input: 9 } },
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
  assert.throws(() => createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_MODEL: "mimo-v2.5",
    ANTHROPIC_THINKING_BUDGET_TOKENS: "512",
  }), /must be 0 or at least 1024/);
});
