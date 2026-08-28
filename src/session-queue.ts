/**
 * Inputs queued while a response is streaming. At the next tool boundary,
 * automatic compaction runs first, then user messages are handed to the model
 * while built-in commands return control to the client.
 *
 * Each session has one replaceable user slot plus one deferred compaction slot.
 */
export interface QueuedSessionInput {
  content: string;
  kind: "message" | "command";
  priority: 1 | 2;
  source: "automatic-compaction" | "user";
}

export class SessionInputPriorityQueue {
  readonly #queued = new Map<string, Array<QueuedSessionInput & { ready: boolean }>>();

  enqueueUser(sessionId: string, input: Pick<QueuedSessionInput, "content" | "kind">): void {
    const queue = this.#queued.get(sessionId) ?? [];
    const automatic = queue.filter((entry) => entry.priority === 1);
    automatic.push({ ...input, priority: 2, source: "user", ready: true });
    this.#queued.set(sessionId, automatic);
  }

  enqueueAutomaticCompaction(sessionId: string): void {
    const queue = this.#queued.get(sessionId) ?? [];
    if (queue.some((entry) => entry.source === "automatic-compaction")) return;
    queue.push({
      content: "/compact",
      kind: "command",
      priority: 1,
      source: "automatic-compaction",
      ready: false,
    });
    this.#queued.set(sessionId, queue);
  }

  operationCompleted(sessionId: string): void {
    for (const entry of this.#queued.get(sessionId) ?? []) entry.ready = true;
  }

  /** Drops a manual /compact that was made redundant by successful automatic compaction. */
  removeManualCompaction(sessionId: string): boolean {
    const queue = this.#queued.get(sessionId) ?? [];
    const remaining = queue.filter((entry) => !(
      entry.source === "user"
      && entry.kind === "command"
      && entry.content.trim().toLowerCase() === "/compact"
    ));
    if (remaining.length === queue.length) return false;
    if (remaining.length > 0) this.#queued.set(sessionId, remaining);
    else this.#queued.delete(sessionId);
    return true;
  }

  /** Returns and removes every ready input in priority order. */
  takeReady(sessionId: string): QueuedSessionInput[] {
    const queue = this.#queued.get(sessionId) ?? [];
    const ready = queue.filter((entry) => entry.ready).sort((left, right) => left.priority - right.priority);
    const pending = queue.filter((entry) => !entry.ready);
    if (pending.length > 0) this.#queued.set(sessionId, pending);
    else this.#queued.delete(sessionId);
    return ready.map(({ ready: _ready, ...input }) => input);
  }

  clear(sessionId: string): void {
    this.#queued.delete(sessionId);
  }
}
