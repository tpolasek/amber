import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { OpenAIProvider } from "../src/openai-provider.js";
import type { ProviderMessage, StreamEvent } from "../src/types.js";

test("streams OpenAI Responses text, reasoning, tools, and usage", async (context) => {
  let authorization = "";
  let path = "";
  let requestBody: Record<string, unknown> = {};
  const gateway = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? "";
    path = request.url ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.reasoning_summary_text.delta\r\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Checking the repository"}\r\n\r\n');
    response.write('event: response.output_item.done\r\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs-new","type":"reasoning","encrypted_content":"encrypted-new","summary":[]}}\r\n\r\n');
    response.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","output_index":1,"delta":"I found it."}\r\n\r\n');
    response.write('event: response.output_item.added\r\ndata: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc-new","type":"function_call","call_id":"call-new","name":"Read","arguments":""}}\r\n\r\n');
    response.write('event: response.function_call_arguments.delta\r\ndata: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"file_path\\":\\"README.md\\"}"}\r\n\r\n');
    response.write('event: response.function_call_arguments.done\r\ndata: {"type":"response.function_call_arguments.done","output_index":2,"name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"}\r\n\r\n');
    response.end('event: response.completed\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30}}}\r\n\r\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const provider = new OpenAIProvider({
    apiKey: "openai-key",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "gpt-test",
    thinkingLevel: "high",
  });
  const oldReasoning = 'openai-reasoning:{"type":"reasoning","id":"rs-old","encrypted_content":"encrypted-old","summary":[]}\n';
  const messages: ProviderMessage[] = [
    { role: "user", content: "Inspect the README" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Old OpenAI summary", signature: oldReasoning, provider: "openai" },
        { type: "thinking", thinking: "Old Anthropic thought", signature: "anthropic-signature", provider: "anthropic" },
        { type: "text", text: "I'll read it." },
        { type: "tool_use", id: "call-old", name: "Read", input: { file_path: "README.md" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-old", content: "README contents" }],
    },
  ];
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(messages, new AbortController().signal, {
    system: [
      { type: "text", text: "First system block" },
      { type: "text", text: "Second system block" },
    ],
    temperature: 1,
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
      },
    }],
  })) events.push(event);

  assert.equal(authorization, "Bearer openai-key");
  assert.equal(path, "/v1/responses");
  assert.equal(requestBody.model, "gpt-test");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.max_output_tokens, 32_000);
  assert.equal(requestBody.instructions, "First system block\n\nSecond system block");
  assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
  assert.equal(requestBody.temperature, undefined);
  assert.deepEqual(requestBody.tools, [{
    type: "function",
    name: "Read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  }]);
  assert.deepEqual(requestBody.input, [
    { role: "user", content: "Inspect the README" },
    { type: "reasoning", id: "rs-old", encrypted_content: "encrypted-old", summary: [] },
    { role: "assistant", content: "I'll read it." },
    { type: "function_call", call_id: "call-old", name: "Read", arguments: '{"file_path":"README.md"}' },
    { type: "function_call_output", call_id: "call-old", output: "README contents" },
  ]);
  assert.deepEqual(events, [
    { type: "thinking_delta", thinking: "Checking the repository" },
    {
      type: "thinking_signature_delta",
      signature: 'openai-reasoning:{"type":"reasoning","id":"rs-new","encrypted_content":"encrypted-new","summary":[]}\n',
    },
    { type: "delta", text: "I found it." },
    { type: "tool_use_start", index: 2, id: "call-new", name: "Read" },
    { type: "tool_input_delta", index: 2, partialJson: '{"file_path":"README.md"}' },
    { type: "usage", usage: { input: 120, output: 30 } },
    { type: "done", stopReason: "completed" },
  ]);
});

test("can disable OpenAI reasoning for non-reasoning models", async (context) => {
  let requestBody: Record<string, unknown> = {};
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const provider = new OpenAIProvider({
    apiKey: "key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "gpt-non-reasoning",
    thinkingLevel: "none",
  });
  for await (const _event of provider.stream(
    [{ role: "user", content: "Hello" }],
    new AbortController().signal,
    { temperature: 0.5 },
  )) { /* consume */ }

  assert.equal(requestBody.reasoning, undefined);
  assert.equal(requestBody.include, undefined);
  assert.equal(requestBody.temperature, 0.5);
});

test("clamps anthropic-only thinking levels to the OpenAI effort ceiling", async (context) => {
  let requestBody: Record<string, unknown> = {};
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const provider = new OpenAIProvider({
    apiKey: "key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "gpt-test",
    thinkingLevel: "max",
  });
  for await (const _event of provider.stream([{ role: "user", content: "Hello" }], new AbortController().signal)) {
    /* consume */
  }

  assert.deepEqual(requestBody.reasoning, { effort: "xhigh", summary: "auto" });
});
