import test from "node:test";
import assert from "node:assert/strict";
import {
  compactHeaderPath,
  formatDuration,
  formatTokenCountInThousands,
  GIT_COMMAND_SUGGESTIONS,
  gitCommandSuggestions,
  messageFrom,
  parseGitCommand,
  promptFileReferenceAt,
  replacePromptFileReference,
  skillCommandSuggestions,
  taskRuntime,
} from "../src/client-formatters.js";
import { BUILT_IN_COMMANDS, builtInCommand } from "../src/built-in-commands.js";

test("classifies built-in commands that can run during a response", () => {
  assert.deepEqual(
    BUILT_IN_COMMANDS.filter((command) => command.runsDuringResponse).map((command) => command.name),
    ["/add-dir", "/context", "/tasks"],
  );
  assert.equal(builtInCommand(" /CONTEXT ")?.runsDuringResponse, true);
  assert.equal(builtInCommand("/compact")?.runsDuringResponse, false);
  assert.equal(builtInCommand("/bashes")?.name, "/tasks");
  assert.equal(builtInCommand("ordinary message"), undefined);
});

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

test("suggests session skills as slash commands without built-in collisions", () => {
  const skills = [
    { name: "commit", description: "Commit current changes" },
    { name: "review-pr", description: "Review a pull request" },
    { name: "ns:deploy", description: "Deploy the app" },
  ];
  const commands = [{ name: "/commit" }, { name: "/tasks" }];

  assert.deepEqual(skillCommandSuggestions(skills, "/", commands), [
    { value: "/review-pr", description: "Review a pull request" },
    { value: "/ns:deploy", description: "Deploy the app" },
  ]);
  assert.deepEqual(skillCommandSuggestions(skills, "/c", commands), []);
  assert.deepEqual(skillCommandSuggestions(skills, "/rev", []), [
    { value: "/review-pr", description: "Review a pull request" },
  ]);
  assert.deepEqual(skillCommandSuggestions(skills, "/ns:", commands), [
    { value: "/ns:deploy", description: "Deploy the app" },
  ]);
  assert.deepEqual(skillCommandSuggestions(skills, "commit", commands), []);
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

test("finds and replaces the file reference at the prompt caret", () => {
  assert.deepEqual(promptFileReferenceAt("Review @src/ser", 15), {
    start: 7,
    end: 15,
    path: "src/ser",
  });
  assert.deepEqual(promptFileReferenceAt("@README.md then continue", 10), {
    start: 0,
    end: 10,
    path: "README.md",
  });
  assert.equal(promptFileReferenceAt("email@example.com", 17), null);
  assert.equal(promptFileReferenceAt("Review @src/file", 7), null);

  assert.deepEqual(
    replacePromptFileReference("Review @src/ser then continue", { start: 7, end: 15, path: "src/ser" }, "src/server.ts"),
    { value: "Review @src/server.ts then continue", caret: 21 },
  );
});
