import type { Session } from "./types.js";

interface ActiveSessionRun {
  parentSessionId?: string;
  controller: AbortController;
  session?: Session;
}

interface SessionFamilyMember {
  id: string;
}

interface BackgroundSessionTasks {
  stopSession(sessionId: string): Array<{ id: string }>;
}

export interface SessionAbortResult {
  sessionIds: string[];
  backgroundTaskIds: string[];
}

export class ActiveSessionRuns {
  readonly #runs = new Map<string, ActiveSessionRun>();

  has(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  register(
    sessionId: string,
    parentSessionId: string | undefined,
    controller: AbortController,
    session?: Session,
  ): void {
    this.#runs.set(sessionId, {
      controller,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(session ? { session } : {}),
    });
  }

  session(sessionId: string): Session | undefined {
    return this.#runs.get(sessionId)?.session;
  }

  unregister(sessionId: string, controller: AbortController): void {
    if (this.#runs.get(sessionId)?.controller === controller) this.#runs.delete(sessionId);
  }

  abortTree(sessionId: string, abortRelatedOperation?: (sessionId: string) => void): string[] {
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
      if (run && !run.controller.signal.aborted) {
        run.controller.abort();
        aborted.push(candidateId);
      }
      // Nested compaction has a distinct controller, while standalone
      // compaction may share this active controller. Run this second so the
      // active abort is still represented in the result in either case.
      abortRelatedOperation?.(candidateId);
    }
    return aborted;
  }

  abortAll(): void {
    for (const run of this.#runs.values()) run.controller.abort();
  }
}

export async function abortSessionOperations(
  rootSessionId: string,
  activeSessions: ActiveSessionRuns,
  backgroundTasks: BackgroundSessionTasks,
  loadFamily: () => Promise<readonly SessionFamilyMember[]>,
  abortRelatedOperation?: (sessionId: string) => void,
): Promise<SessionAbortResult> {
  const sessionIds = activeSessions.abortTree(rootSessionId, abortRelatedOperation);
  const backgroundTaskIds: string[] = [];
  const stoppedSessions = new Set<string>();

  const stopAgentBackgroundTasks = (sessionId: string) => {
    if (sessionId === rootSessionId || stoppedSessions.has(sessionId)) return;
    stoppedSessions.add(sessionId);
    backgroundTaskIds.push(...backgroundTasks.stopSession(sessionId).map((task) => task.id));
  };

  // Stop background work for active agents immediately, then sweep persisted
  // descendants to catch background work belonging to agents that already exited.
  for (const sessionId of sessionIds) stopAgentBackgroundTasks(sessionId);
  const family = await loadFamily();
  for (const session of family) stopAgentBackgroundTasks(session.id);

  return { sessionIds, backgroundTaskIds };
}
