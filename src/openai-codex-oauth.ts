import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AuthStorage, OAuthCredential } from "./auth-storage.js";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const LOGIN_RECORD_RETENTION_MS = 5 * 60_000;

export type OpenAICodexLoginStatus =
  | { status: "pending" }
  | { status: "complete" }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export interface BrowserLoginStart {
  id: string;
  method: "browser";
  authorizationUrl: string;
  redirectUri: string;
  callbackAvailable: boolean;
}

export interface DeviceLoginStart {
  id: string;
  method: "device_code";
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}

export interface ResolvedOpenAICodexAuth {
  accessToken: string;
  accountId: string;
}

interface OpenAICodexAuthOptions {
  storage: AuthStorage;
  fetcher?: typeof fetch;
  callbackHost?: string;
  callbackPort?: number;
  now?: () => number;
}

interface LoginRecord {
  id: string;
  status: OpenAICodexLoginStatus;
  controller: AbortController;
  claimed: boolean;
  expiresTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  state?: string;
  verifier?: string;
  redirectUri?: string;
  callback?: LocalCallbackServer;
}

interface LocalCallbackServer {
  available: boolean;
  redirectUri: string;
  waitForCode(): Promise<string>;
  cancelWait(): void;
  close(): void;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

export class OpenAICodexAuth {
  readonly #storage: AuthStorage;
  readonly #fetch: typeof fetch;
  readonly #callbackHost: string;
  readonly #callbackPort: number;
  readonly #now: () => number;
  readonly #logins = new Map<string, LoginRecord>();
  #loginStarting = false;

  constructor(options: OpenAICodexAuthOptions) {
    this.#storage = options.storage;
    this.#fetch = options.fetcher ?? fetch;
    this.#callbackHost = options.callbackHost ?? process.env.AMBER_OAUTH_CALLBACK_HOST ?? "127.0.0.1";
    this.#callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.#now = options.now ?? Date.now;
  }

  async configured(): Promise<boolean> {
    return Boolean(await this.#storage.read(OPENAI_CODEX_PROVIDER_ID));
  }

  async beginBrowserLogin(): Promise<BrowserLoginStart> {
    this.reserveLoginStart();
    try {
      const { verifier, challenge } = generatePkce();
      const state = randomBytes(16).toString("hex");
      const callback = await startLocalCallbackServer(state, this.#callbackHost, this.#callbackPort);
      const id = randomUUID();
      const record: LoginRecord = {
        id,
        status: { status: "pending" },
        controller: new AbortController(),
        claimed: false,
        state,
        verifier,
        redirectUri: callback.redirectUri,
        callback,
      };
      this.trackLogin(record);

      const authorizationUrl = new URL(AUTHORIZE_URL);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
      authorizationUrl.searchParams.set("redirect_uri", callback.redirectUri);
      authorizationUrl.searchParams.set("scope", SCOPE);
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("id_token_add_organizations", "true");
      authorizationUrl.searchParams.set("codex_cli_simplified_flow", "true");
      authorizationUrl.searchParams.set("originator", "amber");

      void callback.waitForCode()
        .then((code) => this.finishAuthorization(record, code, verifier, callback.redirectUri))
        .catch((error) => this.failPendingLogin(record, error));

      return {
        id,
        method: "browser",
        authorizationUrl: authorizationUrl.toString(),
        redirectUri: callback.redirectUri,
        callbackAvailable: callback.available,
      };
    } finally {
      this.#loginStarting = false;
    }
  }

  async beginDeviceLogin(): Promise<DeviceLoginStart> {
    this.reserveLoginStart();
    try {
      const controller = new AbortController();
      const response = await this.fetchWithTimeout(DEVICE_USER_CODE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
        signal: controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI Codex device code request failed (${response.status}): ${body || response.statusText}`);
      }
      const body = await response.json() as Record<string, unknown>;
      const deviceAuthId = nonEmptyString(body.device_auth_id);
      const userCode = nonEmptyString(body.user_code);
      const rawInterval = typeof body.interval === "string" ? Number(body.interval) : body.interval;
      if (!deviceAuthId || !userCode || typeof rawInterval !== "number" || !Number.isFinite(rawInterval) || rawInterval < 0) {
        throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(body)}`);
      }

      const id = randomUUID();
      const record: LoginRecord = { id, status: { status: "pending" }, controller, claimed: false };
      this.trackLogin(record);
      void this.pollDeviceLogin(record, deviceAuthId, userCode, rawInterval)
        .catch((error) => this.failPendingLogin(record, error));
      return {
        id,
        method: "device_code",
        userCode,
        verificationUri: DEVICE_VERIFICATION_URI,
        expiresInSeconds: DEVICE_TIMEOUT_MS / 1000,
      };
    } finally {
      this.#loginStarting = false;
    }
  }

  loginStatus(loginId: string): OpenAICodexLoginStatus {
    const record = this.#logins.get(loginId);
    if (!record) throw new Error("Unknown OpenAI Codex login");
    return { ...record.status };
  }

  async completeBrowserLogin(loginId: string, input: string): Promise<void> {
    const record = this.#logins.get(loginId);
    if (!record || !record.state || !record.verifier || !record.redirectUri) {
      throw new Error("Unknown browser login");
    }
    if (record.status.status !== "pending") throw new Error("OpenAI Codex login is no longer pending");
    const parsed = parseAuthorizationInput(input);
    if (parsed.state && parsed.state !== record.state) throw new Error("State mismatch");
    if (!parsed.code) throw new Error("Missing authorization code");
    record.callback?.cancelWait();
    await this.finishAuthorization(record, parsed.code, record.verifier, record.redirectUri);
  }

  cancelLogin(loginId: string): void {
    const record = this.#logins.get(loginId);
    if (!record || record.status.status !== "pending") return;
    this.setLoginStatus(record, { status: "cancelled" });
    record.controller.abort(new Error("Login cancelled"));
    record.callback?.cancelWait();
    record.callback?.close();
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.#storage.delete(OPENAI_CODEX_PROVIDER_ID, signal);
  }

  async resolveAuth(signal?: AbortSignal): Promise<ResolvedOpenAICodexAuth> {
    signal?.throwIfAborted();
    let credential = await this.#storage.read(OPENAI_CODEX_PROVIDER_ID, signal);
    if (!credential) throw new Error("OpenAI Codex is not signed in. Open Auth settings to connect ChatGPT.");
    if (credential.expires <= this.#now() + DEFAULT_REFRESH_WINDOW_MS) {
      const refreshed = await this.#storage.modify(OPENAI_CODEX_PROVIDER_ID, async (current) => {
        signal?.throwIfAborted();
        if (!current) return undefined;
        if (current.expires > this.#now() + DEFAULT_REFRESH_WINDOW_MS) return undefined;
        return this.refreshCredential(current);
      });
      signal?.throwIfAborted();
      if (!refreshed) throw new Error("OpenAI Codex was logged out while refreshing credentials");
      credential = refreshed;
    }
    return { accessToken: credential.access, accountId: credential.accountId };
  }

  dispose(): void {
    for (const record of this.#logins.values()) {
      this.cancelLogin(record.id);
      if (record.expiresTimer) clearTimeout(record.expiresTimer);
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    }
    this.#logins.clear();
  }

  private reserveLoginStart(): void {
    if (this.#loginStarting || [...this.#logins.values()].some((record) => record.status.status === "pending")) {
      throw new Error("An OpenAI Codex login is already in progress");
    }
    this.#loginStarting = true;
  }

  private trackLogin(record: LoginRecord): void {
    this.#logins.set(record.id, record);
    record.expiresTimer = setTimeout(() => {
      if (record.status.status !== "pending") return;
      this.setLoginStatus(record, { status: "failed", error: "OpenAI Codex login timed out" });
      record.controller.abort(new Error("Login timed out"));
      record.callback?.cancelWait();
      record.callback?.close();
    }, DEVICE_TIMEOUT_MS);
    record.expiresTimer.unref();
  }

  private setLoginStatus(record: LoginRecord, status: OpenAICodexLoginStatus): void {
    record.status = status;
    if (status.status === "pending") return;
    if (record.expiresTimer) clearTimeout(record.expiresTimer);
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = setTimeout(() => {
      if (this.#logins.get(record.id) === record) this.#logins.delete(record.id);
    }, LOGIN_RECORD_RETENTION_MS);
    record.cleanupTimer.unref();
  }

  private async finishAuthorization(
    record: LoginRecord,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<void> {
    if (record.status.status !== "pending") return;
    if (record.claimed) return;
    record.claimed = true;
    try {
      const credential = await this.exchangeAuthorizationCode(code, verifier, redirectUri, record.controller.signal);
      await this.#storage.modify(OPENAI_CODEX_PROVIDER_ID, async () => credential, record.controller.signal);
      this.setLoginStatus(record, { status: "complete" });
    } catch (error) {
      this.setLoginStatus(record, { status: "failed", error: errorMessage(error) });
      throw error;
    } finally {
      record.callback?.close();
    }
  }

  private failPendingLogin(record: LoginRecord, error: unknown): void {
    if (record.status.status !== "pending" || record.claimed) return;
    if (record.controller.signal.aborted) {
      this.setLoginStatus(record, { status: "cancelled" });
    } else {
      this.setLoginStatus(record, { status: "failed", error: errorMessage(error) });
    }
    record.callback?.close();
  }

  private async pollDeviceLogin(
    record: LoginRecord,
    deviceAuthId: string,
    userCode: string,
    intervalSeconds: number,
  ): Promise<void> {
    const deadline = this.#now() + DEVICE_TIMEOUT_MS;
    let intervalMs = Math.max(10, intervalSeconds * 1000);
    while (this.#now() < deadline) {
      record.controller.signal.throwIfAborted();
      const response = await this.fetchWithTimeout(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal: record.controller.signal,
      }, REQUEST_TIMEOUT_MS);
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        const authorizationCode = nonEmptyString(body.authorization_code);
        const codeVerifier = nonEmptyString(body.code_verifier);
        if (!authorizationCode || !codeVerifier) {
          throw new Error(`Invalid OpenAI Codex device token response: ${JSON.stringify(body)}`);
        }
        await this.finishAuthorization(record, authorizationCode, codeVerifier, DEVICE_REDIRECT_URI);
        return;
      }
      const responseBody = await response.text().catch(() => "");
      if (response.status !== 403 && response.status !== 404) {
        let code: string | undefined;
        try {
          const parsed = JSON.parse(responseBody) as { error?: string | { code?: string } };
          code = typeof parsed.error === "string" ? parsed.error : parsed.error?.code;
        } catch {}
        if (code === "slow_down") intervalMs += 5_000;
        else if (code !== "deviceauth_authorization_pending") {
          throw new Error(`OpenAI Codex device auth failed (${response.status}): ${responseBody || response.statusText}`);
        }
      }
      await abortableDelay(intervalMs, record.controller.signal);
    }
    throw new Error("OpenAI Codex device flow timed out");
  }

  private async exchangeAuthorizationCode(
    code: string,
    verifier: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    const response = await this.fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
      ...(signal ? { signal } : {}),
    }, REQUEST_TIMEOUT_MS);
    return this.readCredentialResponse(response, "exchange");
  }

  private async refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
    const response = await this.fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    }, REQUEST_TIMEOUT_MS);
    return this.readCredentialResponse(response, "refresh");
  }

  private async readCredentialResponse(response: Response, operation: "exchange" | "refresh"): Promise<OAuthCredential> {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${body || response.statusText}`);
    }
    const body = await response.json() as TokenResponse;
    if (typeof body.access_token !== "string" || !body.access_token
      || typeof body.refresh_token !== "string" || !body.refresh_token
      || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)) {
      throw new Error(`OpenAI Codex token ${operation} response missing fields`);
    }
    return {
      type: "oauth",
      access: body.access_token,
      refresh: body.refresh_token,
      expires: this.#now() + body.expires_in * 1000,
      accountId: accountIdFromToken(body.access_token),
    };
  }

  private async fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const request = requestSignal(init.signal, timeoutMs);
    try {
      return await this.#fetch(input, { ...init, signal: request.signal });
    } catch (error) {
      if (request.timedOut()) throw new Error(`OpenAI Codex request timed out after ${timeoutMs}ms`);
      if (request.signal.aborted) throw new Error("Login cancelled");
      throw error;
    } finally {
      request.dispose();
    }
  }
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
      ...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}),
    };
  } catch {}
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    const code = params.get("code");
    const state = params.get("state");
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  return { code: value };
}

async function startLocalCallbackServer(state: string, host: string, port: number): Promise<LocalCallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let server: Server | undefined;
  const close = () => server?.close();
  const cancelWait = () => {
    if (settled) return;
    settled = true;
    rejectCode(new Error("Login cancelled"));
  };
  const handleRequest = (requestUrl: string | undefined, response: ServerResponse): void => {
    const url = new URL(requestUrl ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") return sendHtml(response, 404, "Callback route not found.");
    if (url.searchParams.get("state") !== state) return sendHtml(response, 400, "State mismatch.");
    const code = url.searchParams.get("code");
    if (!code) return sendHtml(response, 400, "Missing authorization code.");
    sendHtml(response, 200, "OpenAI authentication completed. You can close this window.");
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  };

  const listening = await new Promise<{ available: boolean; actualPort: number }>((resolve) => {
    server = createServer((request, response) => handleRequest(request.url, response));
    server.once("error", () => resolve({ available: false, actualPort: port }));
    server.listen(port, host, () => {
      const address = server?.address();
      resolve({
        available: true,
        actualPort: address && typeof address === "object" ? address.port : port,
      });
    });
  });
  if (!listening.available) close();
  return {
    available: listening.available,
    redirectUri: `http://localhost:${listening.actualPort}/auth/callback`,
    waitForCode: () => codePromise,
    cancelWait,
    close,
  };
}

function sendHtml(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

function accountIdFromToken(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId) throw new Error("Missing account id");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from OpenAI Codex token");
  }
}

function requestSignal(parent: AbortSignal | null | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error("Request timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timeout = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal.reason);
    };
    function cleanup(): void {
      signal.removeEventListener("abort", onAbort);
    }
    function done(): void {
      cleanup();
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
