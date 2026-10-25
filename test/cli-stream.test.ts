import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { subscribeSessionEvents } from "../src/cli/stream.js";

function sseServer(frames: string[]): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) response.write(frame);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test("delivers parsed events from the subscription", async () => {
  const { server, port } = await sseServer(['event: snapshot\ndata: {"active":false}\n\n']);
  const events: { event: string; data: unknown }[] = [];
  const controller = new AbortController();
  const done = subscribeSessionEvents(`http://127.0.0.1:${port}`, "s1", (event) => events.push(event), controller.signal, [5, 5]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await done;
  assert.deepEqual(events, [{ event: "snapshot", data: { active: false } }]);
  server.close();
});

test("reconnects after the stream drops and replays the snapshot", async () => {
  let generation = 0;
  const drops: Server[] = [];
  const events: { event: string; data: unknown }[] = [];
  const controller = new AbortController();
  const spawn = async () => {
    const server = createServer((_request, response) => {
      generation += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: snapshot\ndata: {"generation":${generation}}\n\n`);
      response.end();
    });
    drops.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  };
  const throwaway = createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  const port = (throwaway.address() as { port: number }).port;
  throwaway.close();
  await spawn();
  const done = subscribeSessionEvents(`http://127.0.0.1:${port}`, "s1", (event) => events.push(event), controller.signal, [10, 10]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await done;
  for (const server of drops) server.close();
  assert.equal(events.length, 2);
  assert.equal((events[0]!.data as { generation: number }).generation, 1);
  assert.equal((events[1]!.data as { generation: number }).generation, 2);
});
