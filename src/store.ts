import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { AgentSessionSummary, Message, Session, SessionSummary } from "./types.js";
import { BASIC_ENGLISH_2000 } from "./basic-english-2000.js";

const SESSION_ID = /^(?:[a-f0-9-]{36}|[a-z]+(?:\.[a-z]+){2})(?:\.[2-9]\d*)?(?:\.[a-z0-9]{8})*$/;
const SHORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SESSION_WORDS = [...new Set(
  BASIC_ENGLISH_2000
    .map((word) => word.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean),
)];

// Session storage is split per session: a small `<id>.meta.json` document with
// everything except messages (plus denormalized messageCount/preview so the
// session list never loads message logs), and an append-only `<id>.log.jsonl`
// of message operations. Appending one operation replaces rewriting the whole
// document, and replaying the log replaces re-parsing it after the first load.
const META_SUFFIX = ".meta.json";
const LOG_SUFFIX = ".log.jsonl";

/** Sessions kept fully materialized in memory; the least recently used is evicted. */
const CACHE_LIMIT_DEFAULT = 10;

type MessageLogOperation =
  | { op: "add"; message: Message }
  | { op: "insert"; before: string | null; messages: Message[] }
  | { op: "update"; message: Message }
  | { op: "reset"; messages: Message[] };

interface SessionMetadata {
  /** Session fields as stored flat in `<id>.meta.json`, without messages. */
  session: Omit<Session, "messages">;
  messageCount: number;
  preview: string;
}

export class SessionStore {
  readonly #directory: string;
  readonly #planDirectory: string;
  readonly #cacheLimit: number;
  readonly #cache = new Map<string, Session>();
  readonly #writeChains = new Map<string, Promise<void>>();
  readonly #logLines = new Map<string, number>();

  constructor(directory: string, planDirectory = join(dirname(directory), "plans"), cacheLimit = CACHE_LIMIT_DEFAULT) {
    this.#directory = directory;
    this.#planDirectory = planDirectory;
    this.#cacheLimit = cacheLimit;
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

  async createAgentSession(
    parent: Session,
    agentType: string,
    description: string,
    model?: string,
    thinkingLevel?: Session["thinkingLevel"],
  ): Promise<Session> {
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
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(parent.directories ? { directories: structuredClone(parent.directories) } : {}),
      ...(parent.cwd ? { cwd: parent.cwd } : {}),
      ...(parent.addDirInitialized !== undefined ? { addDirInitialized: parent.addDirInitialized } : {}),
      ...(parent.planMode?.active ? { planMode: structuredClone(parent.planMode) } : {}),
      ...(parent.skillRoots ? { skillRoots: structuredClone(parent.skillRoots) } : {}),
      ...(parent.skillTouchedPaths ? { skillTouchedPaths: structuredClone(parent.skillTouchedPaths) } : {}),
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
    await this.saveMeta(session);
    return session;
  }

  async remove(id: string): Promise<boolean> {
    if (!SESSION_ID.test(id)) return false;
    try {
      await unlink(this.#metaPath(id));
      await unlink(this.#logPath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await unlink(this.#planPath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.#cache.delete(id);
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
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
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
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      ...(session.directories ? { directories: structuredClone(session.directories) } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.addDirInitialized !== undefined ? { addDirInitialized: session.addDirInitialized } : {}),
    };
    await this.save(implementation);
    return implementation;
  }

  /**
   * Returns the session, materialized once and kept in a bounded in-memory
   * cache. Mutating the returned session and persisting through the
   * incremental methods (appendMessages/updateMessage/...) never re-reads the
   * message log; a cache hit is a plain object lookup.
   */
  async get(id: string): Promise<Session | null> {
    if (!SESSION_ID.test(id)) return null;
    const cached = this.#cache.get(id);
    if (cached) {
      this.#cache.delete(id);
      this.#cache.set(id, cached);
      return cached;
    }
    const metadata = await this.#readMetadata(id);
    if (!metadata) return null;
    const { messages, lines, torn } = await this.#readLog(id);
    const session: Session = { ...metadata.session, messages };
    this.#cacheSession(session);
    this.#logLines.set(id, lines);
    // Log growth is bounded at write time (#appendOperations collapses a log
    // that dwarfs the conversation), so a load never rewrites for size. A torn
    // tail is the exception: a crash mid-append leaves bytes without a final
    // newline, and the next append would merge onto them and be lost. Rewrite
    // canonically from the replayed state first. A torn tail also implies the
    // previous process died, so no live writer with queued operations exists
    // to race this rewrite.
    if (torn) {
      await this.#enqueue(id, () => this.#rewriteLog(session));
    }
    return session;
  }

  /** Persists metadata and rewrites the message log canonically (one add per message). */
  async save(session: Session): Promise<void> {
    if (!SESSION_ID.test(session.id)) throw new Error("Invalid session id");
    this.#cacheSession(session);
    session.updatedAt = new Date().toISOString();
    // Both documents are serialized from one synchronous snapshot, and the log
    // commits first: it is the source of truth for messages, so a crash between
    // the two renames can leave stale metadata but never metadata advertising
    // messages the log lacks (an empty /clear resurrecting, a fork listed with
    // messages it cannot replay).
    const canonical = canonicalLines(session.messages);
    const meta = `${JSON.stringify(this.#metadataOf(session), null, 2)}\n`;
    const logPath = this.#logPath(session.id);
    const logTemporary = `${logPath}.${process.pid}.${randomUUID()}.tmp`;
    const metaPath = this.#metaPath(session.id);
    const metaTemporary = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
    const id = session.id;
    const lineCount = session.messages.length;
    await this.#enqueue(id, async () => {
      await writeFile(logTemporary, canonical, "utf8");
      await rename(logTemporary, logPath);
      await writeFile(metaTemporary, meta, "utf8");
      await rename(metaTemporary, metaPath);
      this.#logLines.set(id, lineCount);
    });
  }

  /** Persists metadata only, for changes that do not touch messages. */
  async saveMeta(session: Session): Promise<void> {
    if (!SESSION_ID.test(session.id)) throw new Error("Invalid session id");
    this.#cacheSession(session);
    session.updatedAt = new Date().toISOString();
    const metaPath = this.#metaPath(session.id);
    const metaTemporary = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
    const meta = `${JSON.stringify(this.#metadataOf(session), null, 2)}\n`;
    await this.#enqueue(session.id, async () => {
      await writeFile(metaTemporary, meta, "utf8");
      await rename(metaTemporary, metaPath);
    });
  }

  /** Appends new messages that were pushed onto the end of `session.messages`. */
  async appendMessages(session: Session, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await this.#appendOperations(
      session,
      messages.map((message) => ({ op: "add", message } as const)),
      messages.length,
    );
  }

  /** Records messages inserted before an existing message (null appends). */
  async insertMessages(session: Session, before: string | null, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await this.#appendOperations(session, [{ op: "insert", before, messages }], 1);
  }

  /** Records the latest state of messages that were mutated in place. */
  async updateMessage(session: Session, message: Message): Promise<void> {
    await this.updateMessages(session, [message]);
  }

  async updateMessages(session: Session, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    await this.#appendOperations(
      session,
      messages.map((message) => ({ op: "update", message } as const)),
      messages.length,
    );
  }

  async list(limit = 30): Promise<SessionSummary[]> {
    const entries = await this.#readMetadataEntries();
    return entries
      .filter((metadata) => !metadata.session.parentSessionId)
      .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
      .slice(0, limit)
      .map((metadata) => ({
        id: metadata.session.id,
        title: metadata.session.title,
        createdAt: metadata.session.createdAt,
        updatedAt: metadata.session.updatedAt,
        messageCount: metadata.messageCount,
        preview: metadata.preview,
      }));
  }

  async listAgents(parentSessionId: string): Promise<AgentSessionSummary[]> {
    if (!SESSION_ID.test(parentSessionId)) return [];
    const entries = await this.#readMetadataEntries(parentSessionId);
    return entries
      .filter((metadata) =>
        metadata.session.parentSessionId === parentSessionId
        && metadata.session.agentStatus !== undefined
      )
      .sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt))
      .map((metadata) => ({
        id: metadata.session.id,
        description: metadata.session.agentDescription ?? metadata.session.title,
        status: metadata.session.agentStatus!,
      }));
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

    const entries = await this.#readMetadataEntries();
    const familyIds = new Set([root.id]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const metadata of entries) {
        const parentId = metadata.session.parentSessionId;
        if (parentId && familyIds.has(parentId) && !familyIds.has(metadata.session.id)) {
          familyIds.add(metadata.session.id);
          foundDescendant = true;
        }
      }
    }
    const family: Session[] = [root];
    for (const memberId of familyIds) {
      if (memberId === root.id) continue;
      const member = await this.get(memberId);
      if (member) family.push(member);
    }
    return family;
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

  async #appendOperations(session: Session, operations: MessageLogOperation[], lineCount: number): Promise<void> {
    if (!SESSION_ID.test(session.id)) throw new Error("Invalid session id");
    this.#cacheSession(session);
    session.updatedAt = new Date().toISOString();
    const logPath = this.#logPath(session.id);
    // Serialized synchronously so later mutations of the live session cannot
    // tear a write that is queued behind the session's write chain.
    const lines = `${operations.map((operation) => JSON.stringify(operation)).join("\n")}\n`;
    const metaPath = this.#metaPath(session.id);
    const metaTemporary = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
    const meta = `${JSON.stringify(this.#metadataOf(session), null, 2)}\n`;
    const id = session.id;
    await this.#enqueue(id, async () => {
      await appendFile(logPath, lines);
      await writeFile(metaTemporary, meta, "utf8");
      await rename(metaTemporary, metaPath);
      const lines_ = (this.#logLines.get(id) ?? 0) + lineCount;
      this.#logLines.set(id, lines_);
      if (lines_ > this.#compactionThreshold(session.messages.length)) {
        await this.#rewriteLog(session);
      }
    });
  }

  /** Serializes per-session writes so appended operations keep their order. */
  #enqueue(id: string, write: () => Promise<void>): Promise<void> {
    const previous = this.#writeChains.get(id) ?? Promise.resolve();
    const chained = previous.then(write, write);
    this.#writeChains.set(id, chained.catch(() => undefined));
    return chained;
  }

  #compactionThreshold(messageCount: number): number {
    return messageCount * 4 + 256;
  }

  async #rewriteLog(session: Session): Promise<void> {
    const logPath = this.#logPath(session.id);
    const temporary = `${logPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalLines(session.messages), "utf8");
    await rename(temporary, logPath);
    this.#logLines.set(session.id, session.messages.length);
  }

  #cacheSession(session: Session): void {
    this.#cache.delete(session.id);
    this.#cache.set(session.id, session);
    while (this.#cache.size > this.#cacheLimit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }

  async #readMetadata(id: string): Promise<SessionMetadata | null> {
    let contents: string;
    try {
      contents = await readFile(this.#metaPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const parsed = JSON.parse(contents) as Partial<SessionMetadata["session"]> & {
      messageCount?: unknown;
      preview?: unknown;
    };
    if (typeof parsed.id !== "string") return null;
    const { messageCount, preview, ...session } = parsed;
    return {
      session: { ...session, id: parsed.id } as Omit<Session, "messages">,
      messageCount: typeof messageCount === "number" ? messageCount : 0,
      preview: typeof preview === "string" ? preview : "No messages yet",
    };
  }

  async #readMetadataEntries(prefix?: string): Promise<SessionMetadata[]> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(META_SUFFIX))
      .filter((entry) => prefix === undefined || entry.name.startsWith(`${prefix}.`))
      .map((entry) => entry.name.slice(0, -META_SUFFIX.length))
      .filter((id) => SESSION_ID.test(id));
    const metadata = await Promise.all(names.map((id) => this.#readMetadata(id)));
    return metadata.filter((entry): entry is SessionMetadata => entry !== null);
  }

  async #readLog(id: string): Promise<{ messages: Message[]; lines: number; torn: boolean }> {
    let contents: string;
    try {
      contents = await readFile(this.#logPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { messages: [], lines: 0, torn: false };
      throw error;
    }
    // A well-formed log ends with a newline. Anything after the last newline is
    // a write the crash interrupted; an unparseable final complete line is the
    // same damage after a later append merged onto it.
    const rawLines = contents.split("\n");
    const partialTail = contents.endsWith("\n") ? "" : (rawLines.pop() ?? "");
    let lastCompleteIndex = -1;
    for (let index = 0; index < rawLines.length; index += 1) {
      if (rawLines[index]) lastCompleteIndex = index;
    }
    let torn = partialTail !== "";
    // A Map preserves insertion order, and re-setting an existing key replaces
    // it in place, which is exactly the update-in-place replay semantic.
    const replayed = new Map<string, Message>();
    let lines = 0;
    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      if (!line) continue;
      let operation: MessageLogOperation;
      try {
        operation = JSON.parse(line) as MessageLogOperation;
      } catch {
        if (index === lastCompleteIndex) torn = true;
        continue;
      }
      applyOperation(replayed, operation);
      lines += 1;
    }
    return { messages: [...replayed.values()], lines, torn };
  }

  /** The flat `<id>.meta.json` document: session fields plus list summaries. */
  #metadataOf(session: Session): Omit<Session, "messages"> & { messageCount: number; preview: string } {
    const { messages, ...sessionFields } = session;
    let messageCount = 0;
    let lastVisible: Message | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.kind === "tool-result" || message.kind === "skill" || message.kind === "agent-notification") continue;
      messageCount += 1;
      lastVisible ??= message;
    }
    return {
      ...sessionFields,
      messageCount,
      preview: lastVisible?.content.slice(0, 120)
        || (lastVisible?.images?.length ? "[image message]" : "")
        || "No messages yet",
    };
  }

  #metaPath(id: string): string {
    return join(this.#directory, `${id}${META_SUFFIX}`);
  }

  #logPath(id: string): string {
    return join(this.#directory, `${id}${LOG_SUFFIX}`);
  }

  #planPath(id: string): string {
    return join(this.#planDirectory, `${id}.md`);
  }
}

/** The canonical log body: one add operation per message, newline-terminated. */
function canonicalLines(messages: Message[]): string {
  return messages.length
    ? `${messages.map((message) => JSON.stringify({ op: "add", message })).join("\n")}\n`
    : "";
}

function applyOperation(replayed: Map<string, Message>, operation: MessageLogOperation): void {  if (operation.op === "add" || operation.op === "update") {
    replayed.set(operation.message.id, operation.message);
    return;
  }
  if (operation.op === "insert") {
    const anchor = operation.before !== null && replayed.has(operation.before) ? operation.before : null;
    if (anchor === null) {
      for (const message of operation.messages) replayed.set(message.id, message);
      return;
    }
    const rebuilt = new Map<string, Message>();
    for (const [id, message] of replayed) {
      if (id === anchor) for (const inserted of operation.messages) rebuilt.set(inserted.id, inserted);
      rebuilt.set(id, message);
    }
    replayed.clear();
    for (const [id, message] of rebuilt) replayed.set(id, message);
    return;
  }
  if (operation.op === "reset") {
    replayed.clear();
    for (const message of operation.messages) replayed.set(message.id, message);
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
