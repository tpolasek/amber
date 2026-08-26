export interface ServerSentEvent {
  event: string;
  data: string;
}

export async function* readServerSentEvents(response: Response): AsyncGenerator<ServerSentEvent> {
  if (!response.body) throw new Error("The provider returned an empty response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseServerSentEvent(frame);
        if (parsed) yield parsed;
      }
      if (done) {
        const parsed = parseServerSentEvent(buffer);
        if (parsed) yield parsed;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseServerSentEvent(frame: string): ServerSentEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}
