import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { runCli } from "../src/cli/main.js";

test("a failing history fetch on repl startup aborts the subscription and closes readline", async () => {
  let eventsRequests = 0;
  let eventsClosed = false;
  const server: Server = createServer((request, response) => {
    const url = request.url ?? "";
    if (url === "/api/sessions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        sessions: [{ id: "abc1234567", title: "T", createdAt: "", updatedAt: "", messageCount: 1, preview: "" }],
      }));
    } else if (url === "/api/sessions/abc1234567/messages") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    } else if (url === "/api/sessions/abc1234567/events") {
      eventsRequests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Never end the response; the client abort must close the stream.
      response.on("close", () => { eventsClosed = true; });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const code = await runCli(["--server", `http://127.0.0.1:${port}`]);
    assert.equal(code, 1);
    // Give the abort a tick to propagate to the open event-stream socket.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(eventsRequests, 1);
    assert.equal(eventsClosed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
