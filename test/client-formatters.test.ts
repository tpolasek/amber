import test from "node:test";
import assert from "node:assert/strict";
import {
  commitCommandPrompt,
  compactHeaderPath,
  formatDuration,
  formatTokenCountInThousands,
  GIT_COMMAND_SUGGESTIONS,
  gitCommandSuggestions,
  messageFrom,
  parseGitCommand,
  taskRuntime,
} from "../src/client-formatters.js";

test("compacts header paths while preserving useful trailing directories", () => {
  assert.equal(compactHeaderPath("/Users/amber", "/Users/amber"), "~");
  assert.equal(compactHeaderPath("/Users/amber/code/project", "/Users/amber"), "~/code/project");
  assert.equal(
    compactHeaderPath("/Users/amber/a-very-long-directory-name/another-long-directory/packages/client", "/Users/amber"),
    "~/…/packages/client",
  );
  assert.equal(
    compactHeaderPath("/srv/a-very-long-directory-name/another-long-directory/packages/server", "/Users/amber"),
    "/…/packages/server",
  );
});

test("formats client counts, durations, runtimes, and errors", () => {
  assert.equal(formatTokenCountInThousands(0), "0");
  assert.equal(formatTokenCountInThousands(12_345), "12.3");
  assert.equal(formatDuration(750), "750ms");
  assert.equal(formatDuration(1_250), "1.3s");
  assert.equal(taskRuntime({ startedAt: "2026-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:00:02.000Z")), 2_000);
  assert.equal(taskRuntime({ startedAt: "2026-01-01T00:00:00.000Z", durationMs: 500 }, 0), 500);
  assert.equal(messageFrom(new Error("Broken")), "Broken");
  assert.equal(messageFrom("Broken"), "Something went wrong");
});

test("expands /commit into a commit prompt and only /commit push mentions pushing", () => {
  const commit = commitCommandPrompt("/commit");
  const push = commitCommandPrompt("/commit push");
  const upper = commitCommandPrompt("  /Commit   PUSH  ");
  assert.ok(commit?.includes("concise, to-the-point commit title"));
  assert.ok(commit?.includes("bullet points"));
  assert.ok(commit?.includes("high-level details"));
  assert.ok(commit?.includes("Do not push"));
  assert.ok(!commit?.includes("push it to the remote"));
  assert.ok(push?.includes("push it to the remote"));
  assert.ok(!push?.includes("Do not push"));
  assert.equal(upper, push);
  assert.equal(commitCommandPrompt("/commit bad arg"), null);
  assert.equal(commitCommandPrompt("/commit push extra"), null);
});

test("suggests supported /git parameters as the command is typed", () => {
  assert.equal(gitCommandSuggestions("/commit"), null);
  assert.equal(gitCommandSuggestions("/g"), null);
  assert.equal(gitCommandSuggestions("/gitignore"), null);
  assert.deepEqual(gitCommandSuggestions("/git"), GIT_COMMAND_SUGGESTIONS);
  assert.deepEqual(gitCommandSuggestions("/git "), GIT_COMMAND_SUGGESTIONS);
  assert.deepEqual(gitCommandSuggestions("  /Git"), GIT_COMMAND_SUGGESTIONS);
  assert.deepEqual((gitCommandSuggestions("/git d") ?? []).map((item) => item.value), ["/git diff"]);
  assert.deepEqual((gitCommandSuggestions("/git show") ?? []).map((item) => item.value), ["/git show"]);
  assert.deepEqual(
    (gitCommandSuggestions("/git commit") ?? []).map((item) => item.value),
    ["/git commit", "/git commit push"],
  );
  assert.deepEqual((gitCommandSuggestions("/git commit p") ?? []).map((item) => item.value), ["/git commit push"]);
  assert.deepEqual(gitCommandSuggestions("/git log"), []);
});

test("parses /git subcommands into views and commit requests", () => {
  assert.deepEqual(parseGitCommand("/git diff"), { kind: "git-view", view: "diff" });
  assert.deepEqual(parseGitCommand("  /Git   SHOW  "), { kind: "git-view", view: "show" });
  assert.deepEqual(parseGitCommand("/git status"), { kind: "git-view", view: "status" });
  assert.deepEqual(parseGitCommand("/git commit"), { kind: "commit", push: false });
  assert.deepEqual(parseGitCommand("/git commit push"), { kind: "commit", push: true });
  assert.deepEqual(parseGitCommand("/Git COMMIT Push"), { kind: "commit", push: true });
  assert.equal(parseGitCommand("/git"), null);
  assert.equal(parseGitCommand("/git log"), null);
  assert.equal(parseGitCommand("/git diff --cached"), null);
  assert.equal(parseGitCommand("/git commit amend"), null);
  assert.equal(parseGitCommand("/commit diff"), null);
});
