import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { AuthStorage, type OAuthCredential } from "../src/auth-storage.js";
import { createOpenAICodexDriver } from "../src/openai-provider.js";
import {
  OPENAI_CODEX_CLIENT_ID,
  OpenAICodexAuth,
  type OpenAICodexLoginStatus,
} from "../src/openai-codex-oauth.js";

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`;
}

async function authHarness(fetcher: typeof fetch, now = Date.now()): Promise<{
  auth: OpenAICodexAuth;
  storage: AuthStorage;
}> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-oauth-"));
  const storage = new AuthStorage(join(homeDirectory, ".amber", "auth.json"));
  return {
    storage,
    auth: new OpenAICodexAuth({ storage, fetcher, callbackPort: 0, now: () => now }),
  };
}

async function waitForTerminalStatus(auth: OpenAICodexAuth, loginId: string): Promise<OpenAICodexLoginStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = auth.loginStatus(loginId);
    if (status.status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("OAuth login did not finish");
}

test("browser login uses OpenAI Codex PKCE with originator=amber and persists callback credentials", async (context) => {
  let tokenRequest = new URLSearchParams();
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    tokenRequest = new URLSearchParams(String(init?.body));
    return Response.json({
      access_token: jwt("account-browser"),
      refresh_token: "refresh-browser",
      expires_in: 3600,
    });
  };
  const { auth, storage } = await authHarness(fetcher, 1_000_000);
  context.after(() => auth.dispose());

  const login = await auth.beginBrowserLogin();
  const authorizeUrl = new URL(login.authorizationUrl);
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("client_id"), OPENAI_CODEX_CLIENT_ID);
  assert.equal(authorizeUrl.searchParams.get("originator"), "amber");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), login.redirectUri);

  const callback = new URL(login.redirectUri);
  callback.searchParams.set("code", "browser-code");
  callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
  const callbackResponse = await fetch(callback);
  assert.equal(callbackResponse.status, 200);

  assert.deepEqual(await waitForTerminalStatus(auth, login.id), { status: "complete" });
  assert.equal(tokenRequest.get("grant_type"), "authorization_code");
  assert.equal(tokenRequest.get("code"), "browser-code");
  assert.equal(tokenRequest.get("redirect_uri"), login.redirectUri);
  assert.ok(tokenRequest.get("code_verifier"));
  assert.deepEqual(await storage.read("openai-codex"), {
    type: "oauth",
    access: jwt("account-browser"),
    refresh: "refresh-browser",
    expires: 4_600_000,
    accountId: "account-browser",
  });
});

test("allows only one login start while callback setup is in progress", async (context) => {
  const { auth } = await authHarness(async () => {
    throw new Error("Token exchange should not run");
  });
  context.after(() => auth.dispose());

  const first = auth.beginBrowserLogin();
  await assert.rejects(auth.beginBrowserLogin(), /already in progress/);
  const login = await first;
  auth.cancelLogin(login.id);
});

test("browser login accepts a manually pasted redirect URL and validates state", async (context) => {
  const fetcher: typeof fetch = async () => Response.json({
    access_token: jwt("account-manual"),
    refresh_token: "refresh-manual",
    expires_in: 3600,
  });
  const { auth } = await authHarness(fetcher);
  context.after(() => auth.dispose());
  const login = await auth.beginBrowserLogin();
  const state = new URL(login.authorizationUrl).searchParams.get("state")!;

  await assert.rejects(
    auth.completeBrowserLogin(login.id, `${login.redirectUri}?code=manual-code&state=wrong`),
    /State mismatch/,
  );
  await auth.completeBrowserLogin(login.id, `${login.redirectUri}?code=manual-code&state=${state}`);

  assert.deepEqual(auth.loginStatus(login.id), { status: "complete" });
});

test("device-code login polls OpenAI and exchanges the returned authorization code", async () => {
  let devicePolls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { client_id: OPENAI_CODEX_CLIENT_ID });
      return Response.json({ device_auth_id: "device-id", user_code: "ABCD-1234", interval: 0 });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      devicePolls++;
      if (devicePolls === 1) return new Response("", { status: 403 });
      return Response.json({ authorization_code: "device-code", code_verifier: "device-verifier" });
    }
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("code"), "device-code");
      assert.equal(body.get("code_verifier"), "device-verifier");
      assert.equal(body.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
      return Response.json({
        access_token: jwt("account-device"),
        refresh_token: "refresh-device",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const { auth } = await authHarness(fetcher);

  const login = await auth.beginDeviceLogin();
  assert.equal(login.userCode, "ABCD-1234");
  assert.equal(login.verificationUri, "https://auth.openai.com/codex/device");
  assert.deepEqual(await waitForTerminalStatus(auth, login.id), { status: "complete" });
  assert.equal(devicePolls, 2);
});

test("automatically refreshes expiring credentials once across concurrent requests", async () => {
  const now = 2_000_000;
  let refreshes = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    refreshes++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-old");
    return Response.json({
      access_token: jwt("account-refreshed"),
      refresh_token: "refresh-new",
      expires_in: 3600,
    });
  };
  const { auth, storage } = await authHarness(fetcher, now);
  const expiring: OAuthCredential = {
    type: "oauth",
    access: jwt("account-old"),
    refresh: "refresh-old",
    expires: now + 30_000,
    accountId: "account-old",
  };
  await storage.modify("openai-codex", async () => expiring);

  const [first, second] = await Promise.all([
    auth.resolveAuth(),
    auth.resolveAuth(),
  ]);

  assert.equal(refreshes, 1);
  assert.deepEqual(first, { accessToken: jwt("account-refreshed"), accountId: "account-refreshed" });
  assert.deepEqual(second, first);
  assert.equal((await storage.read("openai-codex"))?.refresh, "refresh-new");
});

test("refreshes through the real provider request chain before sending Codex auth headers", async (context) => {
  const now = 2_500_000;
  let receivedAuthorization = "";
  const gateway = createServer((_request, response) => {
    receivedAuthorization = _request.headers.authorization ?? "";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  context.after(() => gateway.close());
  const address = gateway.address();
  assert(address && typeof address === "object");

  const { auth, storage } = await authHarness(async () => Response.json({
    access_token: jwt("account-chain"),
    refresh_token: "refresh-chain-new",
    expires_in: 3600,
  }), now);
  await storage.modify("openai-codex", async () => ({
    type: "oauth",
    access: jwt("account-chain"),
    refresh: "refresh-chain-old",
    expires: now,
    accountId: "account-chain",
  }));
  const provider = createOpenAICodexDriver((signal) => auth.resolveAuth(signal)).createProvider({
    name: "OpenAI Codex",
    authKey: "",
    baseUrl: `http://127.0.0.1:${address.port}/backend-api`,
    model: "gpt-test",
    thinkingLevel: "high",
  });

  for await (const _event of provider.stream([{ role: "user", content: "Hello" }], new AbortController().signal)) {
    /* consume */
  }

  assert.equal(receivedAuthorization, `Bearer ${jwt("account-chain")}`);
  assert.equal((await storage.read("openai-codex"))?.refresh, "refresh-chain-new");
});

test("completes a rotating refresh even when the caller aborts mid-refresh", async () => {
  const now = 4_000_000;
  const { auth, storage } = await authHarness(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return Response.json({
      access_token: jwt("account-rotated"),
      refresh_token: "refresh-rotated",
      expires_in: 3600,
    });
  }, now);
  const expiring: OAuthCredential = {
    type: "oauth",
    access: jwt("account-old"),
    refresh: "refresh-old",
    expires: now,
    accountId: "account-old",
  };
  await storage.modify("openai-codex", async () => expiring);

  const controller = new AbortController();
  const pending = auth.resolveAuth(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, /aborted/i);

  assert.equal((await storage.read("openai-codex"))?.refresh, "refresh-rotated");
  assert.equal(
    (await auth.resolveAuth()).accessToken,
    jwt("account-rotated"),
  );
});

test("preserves the stored credential when refresh fails", async () => {
  const now = 3_000_000;
  const { auth, storage } = await authHarness(async () => new Response("invalid_grant", { status: 400 }), now);
  const expiring: OAuthCredential = {
    type: "oauth",
    access: jwt("account-old"),
    refresh: "refresh-old",
    expires: now,
    accountId: "account-old",
  };
  await storage.modify("openai-codex", async () => expiring);

  await assert.rejects(auth.resolveAuth(), /token refresh failed \(400\): invalid_grant/);
  assert.deepEqual(await storage.read("openai-codex"), expiring);
});
