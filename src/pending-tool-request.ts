import { abortError } from "./abort-error.js";

interface PendingRecord<T, P> {
  toolUseId: string;
  payload: P;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

/**
 * One pending, promise-backed tool request per session. `register` opens it,
 * `settle` delivers the outcome exactly once, and the request's AbortSignal
 * rejects it with a DOM-style AbortError. Subclasses hang their own payload
 * (questions, request kind, …) off the record via the generic `P`.
 */
export class PendingToolRequests<T, P> {
  readonly #pending = new Map<string, PendingRecord<T, P>>();
  readonly #labels: { abort: string; alreadyPending: string; gone: string };

  protected constructor(labels: { abort: string; alreadyPending: string; gone: string }) {
    this.#labels = labels;
  }

  protected register(sessionId: string, toolUseId: string, payload: P, signal: AbortSignal): Promise<T> {
    if (this.#pending.has(sessionId)) throw new Error(this.#labels.alreadyPending);
    if (signal.aborted) return Promise.reject(abortError(this.#labels.abort));
    return new Promise((resolve, reject) => {
      const onAbort = () => this.settle(sessionId, toolUseId, undefined, abortError(this.#labels.abort));
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(sessionId, {
        toolUseId,
        payload,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
      });
    });
  }

  protected payloadOrThrow(sessionId: string, toolUseId: string): P {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) throw new Error(this.#labels.gone);
    return pending.payload;
  }

  protected settle(sessionId: string, toolUseId: string, value?: T, error?: Error): void {
    const pending = this.#pending.get(sessionId);
    if (!pending || pending.toolUseId !== toolUseId) return;
    this.#pending.delete(sessionId);
    pending.removeAbortListener();
    if (error) pending.reject(error);
    else pending.resolve(value as T);
  }

  protected peek(sessionId: string): { toolUseId: string; payload: P } | undefined {
    const pending = this.#pending.get(sessionId);
    if (!pending) return undefined;
    return { toolUseId: pending.toolUseId, payload: pending.payload };
  }

  stopAll(): void {
    for (const [sessionId, pending] of this.#pending) {
      this.settle(sessionId, pending.toolUseId, undefined, abortError(this.#labels.abort));
    }
  }
}
