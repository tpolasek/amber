import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicProvider } from "../src/provider.js";

test("uses bearer auth and parses Anthropic-compatible streaming events", async (context) => {
  let receivedAuthorization = "";
  let receivedPath = "";
  let receivedBetas = "";
  let receivedUserAgent = "";
  let receivedSdkVersion = "";
  let receivedModel = "";
  let receivedThinking: unknown;
  let receivedOutputConfig: unknown;
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
      output_config?: unknown;
      tools?: unknown;
    };
    receivedModel = body.model;
    receivedMaxTokens = body.max_tokens;
    receivedThinking = body.thinking;
    receivedOutputConfig = body.output_config;
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

  const provider = new AnthropicProvider({
    authToken: "test-token",
    model: "glm-test",
    baseUrl: `http://127.0.0.1:${address.port}`,
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
  assert.deepEqual(receivedOutputConfig, { effort: "max" });
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

test("clamps openai-only thinking levels to the anthropic effort ceiling", async (context) => {
  let receivedOutputConfig: unknown;
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { output_config?: unknown };
    receivedOutputConfig = body.output_config;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const provider = new AnthropicProvider({
    authToken: "test-token",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "glm-test",
    thinkingLevel: "xhigh",
  });
  for await (const _event of provider.stream([{ role: "user", content: "Hi" }], new AbortController().signal)) {
    /* consume */
  }

  assert.deepEqual(receivedOutputConfig, { effort: "max" });
});
