export interface PlanHandoff {
  sessionId: string;
  prompt: string;
}

/**
 * Delivers a plan handoff to its implementation session.
 *
 * The decision response and the end of the run's event stream race: the run
 * ends as soon as the decision settles, so the handoff may be offered before,
 * during, or after the stream that would deliver it. Callers offer the handoff
 * when the user decides and call deliver() at every point the stream settles;
 * the dispatcher defers while a response is streaming and dispatches exactly
 * once as soon as the session is idle.
 *
 * This module is served to the browser as part of the app.js module graph, so
 * it must stay free of node: imports.
 */
export class PlanHandoffDispatcher {
  #pending: PlanHandoff | null = null;

  constructor(
    private readonly dispatch: (handoff: PlanHandoff) => void,
    private readonly isStreaming: () => boolean,
  ) {}

  get pending(): boolean {
    return this.#pending !== null;
  }

  offer(handoff: PlanHandoff): void {
    this.#pending = handoff;
    this.deliver();
  }

  deliver(): void {
    if (!this.#pending || this.isStreaming()) return;
    const handoff = this.#pending;
    this.#pending = null;
    this.dispatch(handoff);
  }
}
