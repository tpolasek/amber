import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export type StoredCredential = OAuthCredential;
type AuthData = Record<string, StoredCredential>;

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export class AuthStorage {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(providerId: string, signal?: AbortSignal): Promise<StoredCredential | undefined> {
    signal?.throwIfAborted();
    const data = await this.readData();
    signal?.throwIfAborted();
    return data[providerId];
  }

  async modify(
    providerId: string,
    update: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<StoredCredential | undefined> {
    return this.withLock(async () => {
      signal?.throwIfAborted();
      const data = await this.readData();
      const current = data[providerId];
      const next = await update(current);
      signal?.throwIfAborted();
      if (next === undefined) return current;
      data[providerId] = next;
      await this.writeData(data);
      return next;
    }, signal);
  }

  async delete(providerId: string, signal?: AbortSignal): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readData();
      if (!(providerId in data)) return;
      delete data[providerId];
      signal?.throwIfAborted();
      await this.writeData(data);
    }, signal);
  }

  private async readData(): Promise<AuthData> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Could not parse ${this.path}: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${this.path} must contain a JSON object`);
    }
    const data: AuthData = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      if (!isOAuthCredential(value)) {
        throw new Error(`Invalid OAuth credential for provider '${providerId}' in ${this.path}`);
      }
      data[providerId] = value;
    }
    return data;
  }

  private async writeData(data: AuthData): Promise<void> {
    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.${randomUUID()}.auth.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lockPath = `${this.path}.lock`;
    const release = await acquireLock(lockPath, signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

async function acquireLock(path: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let retry = 0;
  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, "wx", 0o600);
      const owner = `${process.pid}:${randomUUID()}`;
      try {
        await handle.writeFile(`${owner}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        const currentOwner = await readFile(path, "utf8").catch(() => "");
        if (currentOwner.trim() !== owner) return;
        await unlink(path).catch((error) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (await isStaleLock(path)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for credential lock ${path}`);
      const delayMs = Math.min(25 * 2 ** retry, 500);
      retry++;
      await abortableDelay(delayMs, signal);
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= LOCK_STALE_MS;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timeout = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    function cleanup(): void {
      signal?.removeEventListener("abort", onAbort);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  return credential.type === "oauth"
    && typeof credential.access === "string" && Boolean(credential.access)
    && typeof credential.refresh === "string" && Boolean(credential.refresh)
    && typeof credential.expires === "number" && Number.isFinite(credential.expires)
    && typeof credential.accountId === "string" && Boolean(credential.accountId);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
