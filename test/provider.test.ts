import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicProvider, createProvider } from "../src/provider.js";

test("uses bearer auth and parses Anthropic-compatible streaming events", async (context) => {
  let receivedAuthorization = "";
  let receivedPath = "";
  let receivedModel = "";
  const gateway = createServer(async (request, response) => {
    receivedAuthorization = request.headers.authorization ?? "";
    receivedPath = request.url ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receivedModel = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string }).model;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n');
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
  for await (const event of provider.stream([{ role: "user", content: "Hi" }], new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(receivedAuthorization, "Bearer test-token");
  assert.equal(receivedPath, "/v1/messages");
  assert.equal(receivedModel, "glm-test");
  assert.deepEqual(events, [
    { type: "usage", usage: { input: 9 } },
    { type: "delta", text: "Hello" },
    { type: "usage", usage: { output: 2 } },
    { type: "done", stopReason: "end_turn" },
  ]);
});

test("requires credentials and selects the Z.AI model default", () => {
  assert.throws(() => createProvider({}), /ANTHROPIC_AUTH_TOKEN/);
  const provider = createProvider({
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  });
  assert.equal(provider.model, "glm-4.7");
  assert.equal(provider.mode, "live");
});
