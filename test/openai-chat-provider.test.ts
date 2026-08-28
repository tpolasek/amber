import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { OpenAIProvider } from "../src/openai-provider.js";
import { streamChatCompletions } from "../src/openai-chat-provider.js";
import type { ProviderMessage, StreamEvent } from "../src/types.js";

interface CapturedRequest {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
}

async function startGateway(
  handler: (request: CapturedRequest, response: import("node:http").ServerResponse) => void,
): Promise<{ url: string; requests: CapturedRequest[]; close(): void }> {
  const requests: CapturedRequest[] = [];
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const captured: CapturedRequest = {
      path: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    };
    requests.push(captured);
    handler(captured, response);
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => gateway.close(),
  };
}

function writeChunks(response: import("node:http").ServerResponse, chunks: string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${chunk}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("falls back to chat completions when /v1/responses is missing and remembers it", async (context) => {
  const gateway = await startGateway((request, response) => {
    if (request.path === "/v1/chat/completions") {
      writeChunks(response, [
        '{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      ]);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"detail":"Not Found"}');
  });
  context.after(() => gateway.close());

  const provider = new OpenAIProvider({
    apiKey: "local-key",
    baseUrl: gateway.url,
    model: "local-model",
    thinkingLevel: "high",
  });

  const events: StreamEvent[] = [];
  for await (const event of provider.stream(
    [{ role: "user", content: "Hi" }],
    new AbortController().signal,
  )) events.push(event);
  assert.deepEqual(events, [
    { type: "delta", text: "Hello" },
    { type: "done", stopReason: "stop" },
  ]);

  for await (const _event of provider.stream(
    [{ role: "user", content: "Again" }],
    new AbortController().signal,
  )) {
    /* consume */
  }

  assert.deepEqual(gateway.requests.map((request) => request.path), [
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/chat/completions",
  ]);
  const chatRequest = gateway.requests[1]!;
  assert.equal(chatRequest.authorization, "Bearer local-key");
  assert.equal(chatRequest.body.model, "local-model");
  assert.equal(chatRequest.body.stream, true);
});

test("converts provider messages and tools to the chat completions shape", async (context) => {
  const gateway = await startGateway((_request, response) => {
    writeChunks(response, [
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ]);
  });
  context.after(() => gateway.close());

  const messages: ProviderMessage[] = [
    { role: "user", content: "Inspect the README" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Old thought", signature: "sig", provider: "anthropic" },
        { type: "text", text: "I'll read it." },
        { type: "tool_use", id: "call-old", name: "Read", input: { file_path: "README.md" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-old", content: "README contents", is_error: true },
      ],
    },
  ];
  for await (const _event of streamChatCompletions({
    apiKey: "local-key",
    baseUrl: gateway.url,
    model: "local-model",
    messages,
    system: [{ type: "text", text: "First" }, { type: "text", text: "Second" }],
    temperature: 0.5,
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    }],
    signal: new AbortController().signal,
  })) {
    /* consume */
  }

  const body = gateway.requests[0]!.body;
  assert.equal(body.max_tokens, 32_000);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.tool_choice, "auto");
  assert.deepEqual(body.tools, [{
    type: "function",
    function: {
      name: "Read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    },
  }]);
  assert.deepEqual(body.messages, [
    { role: "system", content: "First\n\nSecond" },
    { role: "user", content: "Inspect the README" },
    {
      role: "assistant",
      content: "I'll read it.",
      tool_calls: [{
        id: "call-old",
        type: "function",
        function: { name: "Read", arguments: '{"file_path":"README.md"}' },
      }],
    },
    { role: "tool", tool_call_id: "call-old", content: "Error: README contents" },
  ]);
});

test("explicitly omits the chat-completions system message", async (context) => {
  const gateway = await startGateway((_request, response) => {
    writeChunks(response, ['{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}']);
  });
  context.after(() => gateway.close());

  for await (const _event of streamChatCompletions({
    apiKey: "local-key",
    baseUrl: gateway.url,
    model: "local-model",
    messages: [{ role: "user", content: "Summarize this" }],
    system: null,
    signal: new AbortController().signal,
  })) { /* consume */ }

  assert.deepEqual(gateway.requests[0]?.body.messages, [
    { role: "user", content: "Summarize this" },
  ]);
});

test("maps reasoning, tool call deltas, usage, and finish reason from chat chunks", async (context) => {
  const gateway = await startGateway((_request, response) => {
    writeChunks(response, [
      '{"choices":[{"index":0,"delta":{"reasoning_content":"Thinking about it"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"content":"Reading."},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-new","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30}}',
    ]);
  });
  context.after(() => gateway.close());

  const events: StreamEvent[] = [];
  for await (const event of streamChatCompletions({
    apiKey: "local-key",
    baseUrl: gateway.url,
    model: "local-model",
    messages: [{ role: "user", content: "Inspect the README" }],
    signal: new AbortController().signal,
  })) events.push(event);

  assert.deepEqual(events, [
    { type: "thinking_delta", thinking: "Thinking about it" },
    { type: "delta", text: "Reading." },
    { type: "tool_use_start", index: 0, id: "call-new", name: "Read" },
    { type: "tool_input_delta", index: 0, partialJson: '{"file_path":"README.md"}' },
    { type: "done", stopReason: "tool_calls" },
    { type: "usage", usage: { input: 120, output: 30 } },
  ]);
});

test("throws when the chat stream ends without a finish reason", async (context) => {
  const gateway = await startGateway((_request, response) => {
    writeChunks(response, [
      '{"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}',
    ]);
  });
  context.after(() => gateway.close());

  await assert.rejects(async () => {
    for await (const _event of streamChatCompletions({
      apiKey: "local-key",
      baseUrl: gateway.url,
      model: "local-model",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
    })) {
      /* consume */
    }
  }, /ended before completion/);
});

test("surfaces chat completions error responses", async (context) => {
  const gateway = await startGateway((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"message":"missing or invalid API key"}}');
  });
  context.after(() => gateway.close());

  await assert.rejects(streamChatCompletions({
    apiKey: "wrong-key",
    baseUrl: gateway.url,
    model: "local-model",
    messages: [{ role: "user", content: "Hi" }],
    signal: new AbortController().signal,
  }).next(), /Chat completions request failed \(401\): missing or invalid API key/);
});
