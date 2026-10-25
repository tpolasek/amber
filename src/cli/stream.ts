import { readServerSentEvents } from "../sse.js";

export interface CliSessionEvent { event: string; data: unknown }

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

/** Subscribes to /api/sessions/:id/events forever, reconnecting with capped
 * backoff. Every (re)connection starts with a snapshot the caller diffs. */
export async function subscribeSessionEvents(
  baseUrl: string,
  sessionId: string,
  onEvent: (event: CliSessionEvent) => void,
  signal: AbortSignal,
  backoffMs: number[] = DEFAULT_BACKOFF_MS,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, { signal });
      if (!response.ok || !response.body) throw new Error(`event stream failed (${response.status})`);
      attempt = 0;
      for await (const { event, data } of readServerSentEvents(response)) {
        onEvent({ event, data: JSON.parse(data) });
      }
      throw new Error("event stream ended");
    } catch {
      if (signal.aborted) return;
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)]!;
      attempt += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}
