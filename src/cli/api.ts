import type { Message, Session, SessionSummary, ThinkingLevel } from "../types.js";

async function responseError(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { error?: string }).error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export interface ModelCatalogEntry {
  key: string;
  model: string;
  displayName: string;
  thinkingLevel: ThinkingLevel;
}

export interface ModelCatalog {
  defaultModel: string;
  models: ModelCatalogEntry[];
}

export class AmberApi {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string { return `${this.baseUrl}${path}`; }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new Error(await responseError(response));
    return response.json().catch(() => undefined);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const body = await this.request("/api/sessions") as { sessions?: SessionSummary[] };
    return body.sessions ?? [];
  }

  async getSession(sessionId: string): Promise<Session> {
    const body = await this.request(`/api/sessions/${sessionId}`) as { session?: Session };
    if (!body.session) throw new Error("Session not found");
    return body.session;
  }

  async modelCatalog(): Promise<ModelCatalog> {
    const body = await this.request("/api/config") as { models?: ModelCatalogEntry[]; defaultModel?: string };
    return { defaultModel: body.defaultModel ?? "", models: body.models ?? [] };
  }

  async skills(sessionId: string): Promise<string[]> {
    const body = await this.request(`/api/sessions/${sessionId}/skills`) as { skills?: Array<{ name: string }> };
    return (body.skills ?? []).map((skill) => skill.name);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/model`, { method: "POST", body: JSON.stringify({ model }) });
  }

  async setThinkingLevel(sessionId: string, thinkingLevel: ThinkingLevel): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/thinking-level`, { method: "POST", body: JSON.stringify({ thinkingLevel }) });
  }

  async createSession(path: string, name?: string): Promise<Session> {
    const body = await this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ path, ...(name ? { name } : {}) }),
    }) as { session: Session };
    return body.session;
  }

  async history(sessionId: string, before?: string): Promise<{ messages: Message[]; hasMore: boolean }> {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
    return await this.request(`/api/sessions/${sessionId}/messages${query}`) as {
      messages: Message[];
      hasMore: boolean;
    };
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    // The run's events arrive on the /events subscription; drain this body.
    const response = await fetch(this.url(`/api/sessions/${sessionId}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    await response.body?.cancel();
  }

  async queuedMessage(sessionId: string, content: string, kind: "message" | "command"): Promise<"queued" | "busy"> {
    const response = await fetch(this.url(`/api/sessions/${sessionId}/queued-message`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind }),
    });
    if (response.status === 409) return "busy";
    if (!response.ok) throw new Error(await responseError(response));
    return "queued";
  }

  async command(sessionId: string, command: string): Promise<Record<string, unknown>> {
    return await this.request(`/api/sessions/${sessionId}/commands`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }) as Record<string, unknown>;
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/abort`, { method: "POST" });
  }

  async answerQuestions(
    sessionId: string,
    toolUseId: string,
    answers: Record<string, string> | { cancelled: true },
  ): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/questions/${encodeURIComponent(toolUseId)}/answers`, {
      method: "POST",
      body: JSON.stringify("cancelled" in answers ? answers : { answers }),
    });
  }

  async planDecision(
    sessionId: string,
    toolUseId: string,
    decision: { approved: true } | { approved: false } | { newSession: true },
  ): Promise<unknown> {
    return await this.request(`/api/sessions/${sessionId}/plan-mode/${encodeURIComponent(toolUseId)}/decision`, {
      method: "POST",
      body: JSON.stringify(decision),
    });
  }
}
