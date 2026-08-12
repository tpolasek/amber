import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import type { Message, Session, SessionSummary } from "./types.js";
import { BASIC_ENGLISH_2000 } from "./basic-english-2000.js";

const SESSION_ID = /^(?:[a-f0-9-]{36}|[a-z]+(?:\.[a-z]+){2})(?:\.[2-9]\d*)?$/;
const SESSION_WORDS = [...new Set(
  BASIC_ENGLISH_2000
    .map((word) => word.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean),
)];

export class SessionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
  }

  async create(): Promise<Session> {
    let id = "";
    do id = randomSessionId();
    while (await this.get(id));
    return this.#createWithId(id);
  }

  async clear(session: Session): Promise<Session> {
    session.messages = [];
    delete session.compaction;
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
    const fork: Session = {
      id,
      title: id,
      createdAt: now,
      updatedAt: now,
      messages: [...structuredClone(session.messages), banner],
      ...(session.compaction ? { compaction: structuredClone(session.compaction) } : {}),
    };
    await this.save(fork);
    return fork;
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
    const temporary = `${path}.${process.pid}.tmp`;
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
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        preview: session.messages.at(-1)?.content.slice(0, 120) ?? "No messages yet",
      }));
  }

  #path(id: string): string {
    return join(this.#directory, `${id}.json`);
  }
}

function randomSessionId(): string {
  const words = new Set<string>();
  while (words.size < 3) words.add(SESSION_WORDS[randomInt(SESSION_WORDS.length)] ?? "amber");
  return [...words].join(".");
}
