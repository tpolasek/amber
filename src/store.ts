import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { Message, Session, SessionSummary } from "./types.js";
import { BASIC_ENGLISH_2000 } from "./basic-english-2000.js";

const SESSION_ID = /^(?:[a-f0-9-]{36}|[a-z]+(?:\.[a-z]+){2})(?:\.[2-9]\d*)?(?:\.[a-z0-9]{8})*$/;
const SHORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SESSION_WORDS = [...new Set(
  BASIC_ENGLISH_2000
    .map((word) => word.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean),
)];

export class SessionStore {
  readonly #directory: string;
  readonly #planDirectory: string;

  constructor(directory: string, planDirectory = join(dirname(directory), "plans")) {
    this.#directory = directory;
    this.#planDirectory = planDirectory;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#directory, { recursive: true }),
      mkdir(this.#planDirectory, { recursive: true }),
    ]);
  }

  async create(): Promise<Session> {
    let id = "";
    do id = randomSessionId();
    while (await this.get(id));
    return this.#createWithId(id);
  }

  async createAgentSession(parent: Session, agentType: string, description: string, model?: string): Promise<Session> {
    let id = "";
    do id = `${parent.id}.${randomShortId()}`;
    while (await this.get(id));

    const now = new Date().toISOString();
    const sessionModel = model ?? parent.model;
    const session: Session = {
      id,
      title: description,
      createdAt: now,
      updatedAt: now,
      messages: [{
        id: randomShortId(),
        role: "assistant",
        content: `Agent sub-session of: ${parent.id}`,
        createdAt: now,
        status: "complete",
        kind: "agent-banner",
        sourceSessionId: parent.id,
      }],
      parentSessionId: parent.id,
      agentType,
      agentDescription: description,
      agentStatus: "running",
      ...(sessionModel ? { model: sessionModel } : {}),
      ...(parent.directories ? { directories: structuredClone(parent.directories) } : {}),
      ...(parent.cwd ? { cwd: parent.cwd } : {}),
      ...(parent.addDirInitialized !== undefined ? { addDirInitialized: parent.addDirInitialized } : {}),
      ...(parent.planMode?.active ? { planMode: structuredClone(parent.planMode) } : {}),
    };
    await this.save(session);
    return session;
  }

  async clear(session: Session): Promise<Session> {
    session.messages = [];
    delete session.compaction;
    delete session.fileReadState;
    delete session.contextTokens;
    delete session.planMode;
    delete session.skillRoots;
    delete session.skillTouchedPaths;
    delete session.invokedSkills;
    await this.save(session);
    return session;
  }

  async rename(session: Session, title: string): Promise<Session> {
    session.title = title;
    await this.save(session);
    return session;
  }

  async remove(id: string): Promise<boolean> {
    if (!SESSION_ID.test(id)) return false;
    try {
      await unlink(this.#path(id));
      await unlink(this.#planPath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async createFork(session: Session, banner: Message): Promise<Session> {
    let id = "";
    do id = randomSessionId();
    while (await this.get(id));

    const now = new Date().toISOString();
    const forkPlanMode = session.planMode
      ? { active: session.planMode.active, planFilePath: this.#planPath(id) }
      : undefined;
    if (forkPlanMode) {
      const plan = await readFile(session.planMode!.planFilePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (plan !== undefined) await writeFile(forkPlanMode.planFilePath, plan, "utf8");
    }
    const fork: Session = {
      id,
      title: id,
      createdAt: now,
      updatedAt: now,
      messages: [...structuredClone(session.messages), banner],
      ...(session.compaction ? { compaction: structuredClone(session.compaction) } : {}),
      ...(session.directories ? { directories: structuredClone(session.directories) } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.addDirInitialized !== undefined ? { addDirInitialized: session.addDirInitialized } : {}),
      ...(session.fileReadState ? { fileReadState: structuredClone(session.fileReadState) } : {}),
      ...(session.planningTasks ? { planningTasks: structuredClone(session.planningTasks) } : {}),
      ...(session.planningTaskHighWaterMark !== undefined
        ? { planningTaskHighWaterMark: session.planningTaskHighWaterMark }
        : {}),
      ...(session.planningTaskArchiveHighWaterMark !== undefined
        ? { planningTaskArchiveHighWaterMark: session.planningTaskArchiveHighWaterMark }
        : {}),
      ...(session.contextTokens !== undefined ? { contextTokens: session.contextTokens } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(forkPlanMode ? { planMode: forkPlanMode } : {}),
      ...(session.skillRoots ? { skillRoots: structuredClone(session.skillRoots) } : {}),
      ...(session.skillTouchedPaths ? { skillTouchedPaths: structuredClone(session.skillTouchedPaths) } : {}),
      ...(session.invokedSkills ? { invokedSkills: structuredClone(session.invokedSkills) } : {}),
    };
    await this.save(fork);
    return fork;
  }

  async createPlanImplementation(session: Session, banner: Message): Promise<Session> {
    let id = "";
    do id = randomSessionId();
    while (await this.get(id));

    const now = new Date().toISOString();
    const implementation: Session = {
      id,
      title: id,
      createdAt: now,
      updatedAt: now,
      messages: [banner],
      ...(session.model ? { model: session.model } : {}),
      ...(session.directories ? { directories: structuredClone(session.directories) } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.addDirInitialized !== undefined ? { addDirInitialized: session.addDirInitialized } : {}),
    };
    await this.save(implementation);
    return implementation;
  }

  async #createWithId(id: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: id,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.save(session);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    if (!SESSION_ID.test(id)) return null;
    try {
      const contents = await readFile(this.#path(id), "utf8");
      return JSON.parse(contents) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session: Session): Promise<void> {
    if (!SESSION_ID.test(session.id)) throw new Error("Invalid session id");
    session.updatedAt = new Date().toISOString();
    const path = this.#path(session.id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  async list(limit = 30): Promise<SessionSummary[]> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => this.get(entry.name.slice(0, -5))),
    );

    return sessions
      .filter((session): session is Session => session !== null)
      .filter((session) => !session.parentSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((session) => {
        const visibleMessages = session.messages.filter((message) =>
          message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification"
        );
        return {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: visibleMessages.length,
          preview: visibleMessages.at(-1)?.content.slice(0, 120) ?? "No messages yet",
        };
      });
  }

  async family(id: string): Promise<Session[]> {
    let root = await this.get(id);
    if (!root) return [];
    const ancestors = new Set([root.id]);
    while (root.parentSessionId && !ancestors.has(root.parentSessionId)) {
      const parent = await this.get(root.parentSessionId);
      if (!parent) break;
      root = parent;
      ancestors.add(root.id);
    }

    const entries = await readdir(this.#directory, { withFileTypes: true });
    const sessions = (await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.get(entry.name.slice(0, -5)))))
      .filter((session): session is Session => session !== null);
    const familyIds = new Set([root.id]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const session of sessions) {
        if (session.parentSessionId && familyIds.has(session.parentSessionId) && !familyIds.has(session.id)) {
          familyIds.add(session.id);
          foundDescendant = true;
        }
      }
    }
    return [root, ...sessions.filter((session) => session.id !== root.id && familyIds.has(session.id))];
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.json`);
  }

  #planPath(id: string): string {
    return join(this.#planDirectory, `${id}.md`);
  }
}

function randomSessionId(): string {
  const words = new Set<string>();
  while (words.size < 3) words.add(SESSION_WORDS[randomInt(SESSION_WORDS.length)] ?? "amber");
  return [...words].join(".");
}

function randomShortId(): string {
  return Array.from({ length: 8 }, () => SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)]).join("");
}
