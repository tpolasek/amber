/**
 * Stop choreography shared by tools that spawn child processes. `stop()` sends
 * SIGTERM and escalates to SIGKILL after one second; the AbortSignal is
 * mirrored onto the child; `settle()` unwires the escalation timer and abort
 * listener once the child settles.
 */
export class ChildStopper {
  #forceKillTimer: NodeJS.Timeout | undefined;
  readonly #abortListener = () => this.stop();

  constructor(
    private readonly kill: (signalName: NodeJS.Signals) => void,
    private readonly signal: AbortSignal,
  ) {
    this.signal.addEventListener("abort", this.#abortListener, { once: true });
    if (this.signal.aborted) this.stop();
  }

  stop(): void {
    if (this.#forceKillTimer !== undefined) return;
    this.kill("SIGTERM");
    this.#forceKillTimer = setTimeout(() => this.kill("SIGKILL"), 1_000);
  }

  settle(): void {
    if (this.#forceKillTimer) clearTimeout(this.#forceKillTimer);
    this.signal.removeEventListener("abort", this.#abortListener);
  }
}
