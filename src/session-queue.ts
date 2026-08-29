/**
 * Inputs queued while a response is streaming. At the next tool boundary,
 * the server-inserted /compact runs first, then user messages are handed to
 * the model while built-in commands return control to the client.
 *
 * Each session has one replaceable user slot plus one server /compact slot.
 */
export interface QueuedSessionInput {
  content: string;
  kind: "message" | "command";
  priority: 0 | 2; // 0 = server-inserted /compact, 2 = user input
}

export class SessionInputPriorityQueue {
  readonly #queued = new Map<string, QueuedSessionInput[]>();

  enqueueUser(sessionId: string, input: Pick<QueuedSessionInput, "content" | "kind">): void {
    const queue = this.#queued.get(sessionId) ?? [];
    const preserved = queue.filter((entry) => entry.priority === 0);
    preserved.push({ ...input, priority: 2 });
    this.#queued.set(sessionId, preserved);
  }

  /** Inserts the auto-triggered /compact at top priority; no-op if one is already queued. */
  enqueueCompaction(sessionId: string): void {
    const queue = this.#queued.get(sessionId) ?? [];
    if (queue.some((entry) => entry.kind === "command" && entry.content.trim().toLowerCase() === "/compact")) return;
    queue.push({ content: "/compact", kind: "command", priority: 0 });
    this.#queued.set(sessionId, queue);
  }

  /** Returns and removes every input in priority order. */
  takeReady(sessionId: string): QueuedSessionInput[] {
    const queue = this.#queued.get(sessionId) ?? [];
    const ready = [...queue].sort((left, right) => left.priority - right.priority);
    this.#queued.delete(sessionId);
    return ready;
  }

  clear(sessionId: string): void {
    this.#queued.delete(sessionId);
  }
}
