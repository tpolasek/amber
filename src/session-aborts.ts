interface ActiveSessionRun {
  parentSessionId?: string;
  controller: AbortController;
}

export class ActiveSessionRuns {
  readonly #runs = new Map<string, ActiveSessionRun>();

  has(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  register(sessionId: string, parentSessionId: string | undefined, controller: AbortController): void {
    this.#runs.set(sessionId, {
      controller,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  }

  unregister(sessionId: string, controller: AbortController): void {
    if (this.#runs.get(sessionId)?.controller === controller) this.#runs.delete(sessionId);
  }

  abortTree(sessionId: string): string[] {
    const sessionIds = new Set([sessionId]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const [candidateId, run] of this.#runs) {
        if (run.parentSessionId && sessionIds.has(run.parentSessionId) && !sessionIds.has(candidateId)) {
          sessionIds.add(candidateId);
          foundDescendant = true;
        }
      }
    }

    const aborted: string[] = [];
    for (const candidateId of sessionIds) {
      const run = this.#runs.get(candidateId);
      if (!run || run.controller.signal.aborted) continue;
      run.controller.abort();
      aborted.push(candidateId);
    }
    return aborted;
  }

  abortAll(): void {
    for (const run of this.#runs.values()) run.controller.abort();
  }
}
