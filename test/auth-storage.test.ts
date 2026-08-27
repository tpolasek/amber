import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, type OAuthCredential } from "../src/auth-storage.js";

function credential(access: string, expires = Date.now() + 60_000): OAuthCredential {
  return {
    type: "oauth",
    access,
    refresh: `refresh-${access}`,
    expires,
    accountId: "account-1",
  };
}

test("persists OAuth credentials beneath ~/.amber with private permissions", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-auth-"));
  const authPath = join(homeDirectory, ".amber", "auth.json");
  const storage = new AuthStorage(authPath);

  const storedCredential = credential("access-1");
  await storage.modify("openai-codex", async () => storedCredential);

  assert.deepEqual(await storage.read("openai-codex"), storedCredential);
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
    "openai-codex": storedCredential,
  });
  assert.equal((await stat(join(homeDirectory, ".amber"))).mode & 0o777, 0o700);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
});

test("serializes credential mutations so a rotated refresh token is not overwritten", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-auth-"));
  const storage = new AuthStorage(join(homeDirectory, ".amber", "auth.json"));
  await storage.modify("openai-codex", async () => credential("initial"));

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });

  const first = storage.modify("openai-codex", async (current) => {
    assert.equal(current?.access, "initial");
    firstStarted();
    await firstMayFinish;
    return credential("rotated-1");
  });
  await firstDidStart;
  const second = storage.modify("openai-codex", async (current) => {
    assert.equal(current?.access, "rotated-1");
    return credential("rotated-2");
  });
  releaseFirst();

  await Promise.all([first, second]);
  assert.equal((await storage.read("openai-codex"))?.access, "rotated-2");
});

test("deletes stored credentials", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "amber-auth-"));
  const storage = new AuthStorage(join(homeDirectory, ".amber", "auth.json"));
  await storage.modify("openai-codex", async () => credential("access-1"));

  await storage.delete("openai-codex");

  assert.equal(await storage.read("openai-codex"), undefined);
});
