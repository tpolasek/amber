import { buildProviderHistory } from "./history.js";
import { SESSION_TITLE_PROMPT } from "./prompts.js";
import type { LlmProvider, Message } from "./types.js";

export async function generateSessionTitle(
  provider: LlmProvider,
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  const history = buildProviderHistory(messages);
  history.push({ role: "user", content: SESSION_TITLE_PROMPT });

  let output = "";
  for await (const event of provider.stream(history, signal)) {
    if (event.type === "delta") output += event.text;
  }
  return parseSessionTitle(output);
}

export function parseSessionTitle(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const candidates = [trimmed, fenced, objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { title?: unknown };
      if (typeof parsed.title !== "string") continue;
      const title = parsed.title.replace(/\s+/g, " ").trim();
      if (title && title.length <= 80) return title;
    } catch { /* try the next representation */ }
  }
  throw new Error("The model returned an invalid session title");
}
