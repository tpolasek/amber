import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverNestedProjectRoots,
  discoverSkills,
  expandShellSubstitutions,
  expandSkill,
  invocableSkills,
  isSkillPathActive,
  normalizeSkillName,
  parseSkillArguments,
  parseSkillPaths,
  renderSkillReminder,
  resolveSkill,
  resolveSkillModel,
  skillInvocationPreview,
  SKILL_TOOL,
  stringWidth,
  substituteArguments,
  truncateToWidth,
  type SkillDefinition,
} from "../src/skill-tool.js";

interface Fixture {
  root: string;
  home: string;
  project: string;
  nested: string;
  added: string;
  cleanup: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "amber-skill-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const nested = join(project, "packages", "nested");
  const added = join(root, "added");
  await mkdir(join(home, ".amber"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(added, { recursive: true });
  return {
    root,
    home,
    project,
    nested,
    added,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function listed(name: string, description: string): SkillDefinition {
  return {
    name,
    displayName: undefined,
    description,
    hasUserSpecifiedDescription: true,
    allowedTools: [],
    argumentNames: [],
    argumentHint: undefined,
    whenToUse: undefined,
    version: undefined,
    model: undefined,
    effort: undefined,
    disableModelInvocation: false,
    userInvocable: true,
    fork: false,
    agent: undefined,
    paths: undefined,
    shell: undefined,
    content: "",
    basePath: undefined,
    filePath: `/tmp/${name}/SKILL.md`,
    realPath: `/tmp/${name}/SKILL.md`,
  };
}

function discovery(fx: Fixture, overrides: Partial<Parameters<typeof discoverSkills>[0]> = {}) {
  return discoverSkills({
    cwd: fx.project,
    homeDirectory: fx.home,
    addDirRoots: [fx.added],
    ...overrides,
  });
}

test("discovers project skills ahead of user, commands, and Claude-compatible paths", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "alpha", "SKILL.md"), "---\ndescription: project amber\n---\nProject body");
    await write(join(fx.project, ".amber", "commands", "beta.md"), "---\ndescription: project command\n---\nCommand body");
    await write(join(fx.home, ".amber", "skills", "alpha", "SKILL.md"), "---\ndescription: user amber\n---\nUser body");
    await write(join(fx.home, ".claude", "skills", "alpha", "SKILL.md"), "---\ndescription: user claude\n---\nClaude body");

    const skills = await discovery(fx);
    assert.deepEqual(skills.map((skill) => skill.name), ["alpha", "beta"]);
    assert.equal(skills[0]?.description, "project amber");
    assert.equal(skills[1]?.content, "Command body");
    assert.equal(skills.some((skill) => skill.description === "user amber"), false);
    assert.equal(skills.some((skill) => skill.description === "user claude"), false);
  } finally {
    await fx.cleanup();
  }
});

test("prefers the skills directory over legacy commands of the same name", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.home, ".amber", "commands", "shared.md"), "commands body");
    await write(join(fx.home, ".amber", "skills", "shared", "SKILL.md"), "skills body");
    const skills = await discovery(fx);
    assert.deepEqual(skills.map((skill) => skill.name), ["shared"]);
    assert.equal(skills[0]?.content, "skills body");
    assert.equal(skills[0]?.basePath, join(fx.home, ".amber", "skills", "shared"));
  } finally {
    await fx.cleanup();
  }
});

test("falls back to Claude-compatible directories and namespaces nested command markdown", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".claude", "commands", "top.md"), "top body");
    await write(join(fx.project, ".claude", "commands", "group", "inner.md"), "inner body");
    await write(join(fx.project, ".claude", "commands", "group", "pkg", "SKILL.md"), "packaged body");

    const skills = await discovery(fx);
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ["group:inner", "group:pkg", "top"]);
    const packaged = skills.find((skill) => skill.name === "group:pkg");
    assert.equal(packaged?.basePath, join(fx.project, ".claude", "commands", "group", "pkg"));
    assert.equal(skills.find((skill) => skill.name === "group:inner")?.basePath, undefined);
  } finally {
    await fx.cleanup();
  }
});

test("discovers add-dir roots and deduplicates symlinked skill directories", async () => {
  const fx = await fixture();
  try {
    const real = join(fx.added, "real");
    await write(join(real, "SKILL.md"), "---\ndescription: real\n---\nreal body");
    await mkdir(join(fx.project, ".amber", "skills"), { recursive: true });
    await symlink(real, join(fx.project, ".amber", "skills", "linked"));

    const skills = await discovery(fx);
    assert.deepEqual(skills.map((skill) => skill.name), ["linked"]);
    assert.equal(skills[0]?.description, "real");
  } finally {
    await fx.cleanup();
  }
});

test("discovers nested project roots but stops at the project root", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "root-skill", "SKILL.md"), "root");
    await write(join(fx.nested, ".amber", "skills", "nested-skill", "SKILL.md"), "nested");
    const touched = join(fx.nested, "src", "main.ts");
    await write(touched, "export {}");

    const roots = await discoverNestedProjectRoots(touched, fx.project);
    assert.deepEqual(roots, [fx.nested]);

    const skills = await discovery(fx, { extraProjectRoots: roots });
    assert.deepEqual(skills.map((skill) => skill.name), ["nested-skill", "root-skill"]);
  } finally {
    await fx.cleanup();
  }
});

test("parses frontmatter fields and falls back to the first markdown line", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.home, ".amber", "skills", "rich", "SKILL.md"), [
      "---",
      'name: "Rich Display Name"',
      "description: explicit description",
      "argument-hint: [left] [right]",
      "arguments: left right",
      "version: 2.1.0",
      "model: opus",
      "effort: high",
      "allowed-tools:",
      "  - Bash",
      "  - Read",
      "user-invocable: false",
      "paths: src/**/*.ts, docs",
      "shell: powershell",
      "---",
      "# Ignored heading",
      "Body",
    ].join("\n"));
    await write(join(fx.home, ".amber", "skills", "bare", "SKILL.md"), "# Fallback heading\n\nBody text");

    const skills = await discovery(fx);
    const rich = skills.find((skill) => skill.name === "rich");
    assert.equal(rich?.displayName, "Rich Display Name");
    assert.equal(rich?.description, "explicit description");
    assert.equal(rich?.argumentHint, "[left] [right]");
    assert.deepEqual(rich?.argumentNames, ["left", "right"]);
    assert.equal(rich?.version, "2.1.0");
    assert.equal(rich?.model, "opus");
    assert.equal(rich?.effort, "high");
    assert.deepEqual(rich?.allowedTools, ["Bash", "Read"]);
    assert.equal(rich?.userInvocable, false);
    assert.deepEqual(rich?.paths, ["src/**/*.ts", "docs"]);
    assert.equal(rich?.shell, "powershell");
    assert.equal(rich?.content, "# Ignored heading\nBody");

    const bare = skills.find((skill) => skill.name === "bare");
    assert.equal(bare?.description, "Fallback heading");
    assert.equal(bare?.hasUserSpecifiedDescription, false);
  } finally {
    await fx.cleanup();
  }
});

test("treats model inherit, invalid effort, and markdown-only files as absent", async () => {
  assert.equal(resolveSkillModel(undefined, []), undefined);
  assert.equal(resolveSkillModel("gone", [{ key: "p/one", model: "one" }]), undefined);
  assert.equal(resolveSkillModel("p/one", [{ key: "p/one", model: "one" }]), "p/one");
  assert.equal(resolveSkillModel("one", [{ key: "p/one", model: "one" }]), "p/one");
  assert.equal(
    resolveSkillModel("one", [{ key: "p/one", model: "one" }, { key: "q/one", model: "one" }]),
    undefined,
  );
  assert.deepEqual(parseSkillPaths("**"), undefined);
  assert.deepEqual(parseSkillPaths(["src/**", "docs/**"]), ["src", "docs"]);
  assert.deepEqual(parseSkillPaths("a, {b,c}/**"), ["a", "b", "c"]);
});

test("substitutes arguments, indexed positions, and named placeholders", () => {
  assert.deepEqual(parseSkillArguments('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(parseSkillArguments(String.raw`"say \"hi\" now"`), ['say "hi" now']);
  assert.deepEqual(parseSkillArguments("a $HOME"), ["a", "$HOME"]);
  assert.deepEqual(parseSkillArguments(""), []);

  assert.equal(substituteArguments("Full: $ARGUMENTS", "x y"), "Full: x y");
  assert.equal(substituteArguments("First: $ARGUMENTS[0]", "x y"), "First: x");
  assert.equal(substituteArguments("First: $1", "x y"), "First: x");
  assert.equal(substituteArguments("Second: $2", "x y"), "Second: y");
  assert.equal(substituteArguments("Missing: $3", "x y"), "Missing: ");
  assert.equal(substituteArguments("Message: $1", '"fix typo"'), "Message: fix typo");
  assert.equal(substituteArguments("Left: $left", "x y", true, ["left"]), "Left: x");
  assert.equal(substituteArguments("Nothing", undefined), "Nothing");
  assert.equal(substituteArguments("Nothing", "extra"), "Nothing\n\nARGUMENTS: extra");
  assert.equal(substituteArguments("", "extra"), "\n\nARGUMENTS: extra");
});

test("previews expanded skill output capped for the tool card", () => {
  assert.equal(skillInvocationPreview("  Computed: 42\n\n"), "Computed: 42");
  const long = "x".repeat(3_000);
  const preview = skillInvocationPreview(long);
  assert.equal(preview.length, 2_000 + "\n… [truncated]".length);
  assert.match(preview, /\n… \[truncated\]$/);
  assert.ok(!preview.startsWith(long));
});

test("expands skills with base directory, session placeholders, and shell substitutions", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "deploy", "SKILL.md"), [
      "---",
      "description: deploy",
      "---",
      "Now !`echo ready`",
      "Dir: ${CLAUDE_SKILL_DIR} / ${AMBER_SKILL_DIR}",
      "Session: ${CLAUDE_SESSION_ID} / ${AMBER_SESSION_ID}",
      "Args: $ARGUMENTS",
    ].join("\n"));
    const [skill] = await discovery(fx);
    const expanded = await expandSkill(skill!, "prod", {
      sessionId: "session-1",
      cwd: fx.project,
      signal: new AbortController().signal,
    });
    assert.equal(expanded.name, "deploy");
    assert.match(expanded.content, /^Base directory for this skill: .*\/deploy\n\nNow ready\n/);
    const directory = join(fx.project, ".amber", "skills", "deploy");
    assert.equal(expanded.content.match(new RegExp(directory, "g"))?.length, 3);
    assert.match(expanded.content, /Session: session-1 \/ session-1/);
    assert.match(expanded.content, /Args: prod/);
  } finally {
    await fx.cleanup();
  }
});

test("runs fenced shell blocks concurrently and fails the expansion on error", async () => {
  const signal = new AbortController().signal;
  const order: string[] = [];
  const runCommand = async (command: string): Promise<string> => {
    order.push(command);
    if (command === "boom") throw new Error("exit 1");
    return command === "slow" ? await new Promise((resolve) => setTimeout(() => resolve("late"), 20)) : "ok";
  };
  const both = await expandShellSubstitutions("a ```!\nfirst\n```\n b !`slow`", "bash", {
    sessionId: "s",
    cwd: "/tmp",
    signal,
    runCommand,
  });
  assert.equal(both, "a ok\n b late");
  assert.deepEqual(order, ["first", "slow"]);

  await assert.rejects(
    () => expandShellSubstitutions("x !`boom` y", "bash", {
      sessionId: "s", cwd: "/tmp", signal, runCommand,
    }),
    /exit 1/,
  );
});

test("routes powershell skills to pwsh and keeps shell output safe for replacement", async () => {
  const signal = new AbortController().signal;
  const shells: string[] = [];
  const runCommand = async (command: string, shell: "bash" | "powershell"): Promise<string> => {
    shells.push(shell);
    assert.equal(command, "cmd");
    return "$& $$ $` $' value";
  };
  const result = await expandShellSubstitutions("value !`cmd`", "powershell", {
    sessionId: "s", cwd: "/tmp", signal, runCommand,
  });
  assert.equal(result, "value $& $$ $` $' value");
  assert.deepEqual(shells, ["powershell"]);
});

test("truncates oversized shell output and ignores markdown that merely looks like a command", async () => {
  const signal = new AbortController().signal;
  const long = "x".repeat(30_000);
  const runCommand = async (): Promise<string> => long;
  const result = await expandShellSubstitutions("!`cmd`", "bash", {
    sessionId: "s", cwd: "/tmp", signal, runCommand,
  });
  assert.equal(result.length, 20_000 + "\n[output truncated]".length);
  assert.match(result, /\[output truncated\]$/);

  const untouched = await expandShellSubstitutions("`code` and `!not-a-command`", "bash", {
    sessionId: "s", cwd: "/tmp", signal, runCommand: async (): Promise<string> => "replaced",
  });
  assert.equal(untouched, "`code` and `!not-a-command`");
});

test("validates invocations and rejects unusable skills", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.home, ".amber", "skills", "plain", "SKILL.md"), "body");
    await write(join(fx.home, ".amber", "skills", "off", "SKILL.md"), "---\ndisable-model-invocation: true\n---\nbody");
    await write(join(fx.home, ".amber", "skills", "forked", "SKILL.md"), "---\ncontext: fork\n---\nbody");
    await write(join(fx.home, ".amber", "skills", "gated", "SKILL.md"), "---\npaths: src/**/*.ts\n---\nbody");
    const skills = await discovery(fx);

    assert.equal(normalizeSkillName(" /plain "), "plain");
    const plain = resolveSkill(skills, "  /plain ");
    assert.ok("skill" in plain);
    assert.equal(plain.skill.name, "plain");
    assert.equal("error" in resolveSkill(skills, "  "), true);
    assert.match((resolveSkill(skills, "missing") as { error: string }).error, /Unknown skill: missing/);
    assert.match(
      (resolveSkill(skills, "off") as { error: string }).error,
      /disable-model-invocation/,
    );
    assert.match((resolveSkill(skills, "forked") as { error: string }).error, /context: fork/);
    assert.match(
      (resolveSkill(skills, "gated") as { error: string }).error,
      /not active for the paths touched/,
    );

    const touched = [join(fx.project, "src", "a.ts")];
    assert.equal("skill" in resolveSkill(skills, "gated", touched, fx.project), true);
    assert.deepEqual(invocableSkills(skills, touched, fx.project).map((skill) => skill.name).sort(), ["gated", "plain"]);
    assert.deepEqual(invocableSkills(skills, [], fx.project).map((skill) => skill.name), ["plain"]);
    assert.equal(isSkillPathActive(skills[0]!, [], fx.project), true);
  } finally {
    await fx.cleanup();
  }
});

test("renders the exact empty reminder and a budgeted listing otherwise", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "one", "SKILL.md"), "---\ndescription: first skill\n---\n");
    await write(join(fx.home, ".amber", "skills", "two", "SKILL.md"), "---\ndescription: 第二スキル\n---\n");
    const skills = await discovery(fx);
    assert.deepEqual(invocableSkills(skills), skills);

    assert.equal(
      renderSkillReminder([]),
      "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n</system-reminder>\n",
    );
    const reminder = renderSkillReminder(skills);
    assert.equal(
      reminder,
      `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n`
      + `- one: first skill\n- two: 第二スキル\n</system-reminder>\n`,
    );

    const wide = [listed("alpha", "d".repeat(60)), listed("beta", "e".repeat(60))];
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "100";
    try {
      assert.equal(
        renderSkillReminder(wide),
        `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n`
        + `- alpha: ${"d".repeat(40)}…\n- beta: ${"e".repeat(40)}…\n</system-reminder>\n`,
      );
    } finally {
      delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
    }

    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "12";
    try {
      assert.equal(
        renderSkillReminder(wide),
        `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- alpha\n- beta\n</system-reminder>\n`,
      );
    } finally {
      delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
    }
  } finally {
    await fx.cleanup();
  }
});

test("caps long descriptions and measures CJK width as two columns", () => {
  assert.equal(stringWidth("ab"), 2);
  assert.equal(stringWidth("あ"), 2);
  assert.equal(stringWidth("aあ"), 3);
  assert.equal(truncateToWidth("abcdef", 4), "abc…");
  assert.equal(truncateToWidth("あいう", 4), "あ…");
  assert.equal(truncateToWidth("abc", 4), "abc");

  const reminder = renderSkillReminder([listed("long", "d".repeat(300))]);
  assert.match(reminder, new RegExp(`- long: d{249}…`));
});

test("advertises the Skill contract after Read", () => {
  assert.equal(SKILL_TOOL.name, "Skill");
  assert.equal(SKILL_TOOL.input_schema.required?.[0], "skill");
  assert.deepEqual(Object.keys(SKILL_TOOL.input_schema.properties), ["skill", "args"]);
  assert.equal(SKILL_TOOL.input_schema.additionalProperties, false);
  assert.match(SKILL_TOOL.description, /BLOCKING REQUIREMENT/);
});

test("path gating never throws for touched paths outside the session directory", () => {
  const gated: SkillDefinition = { ...listed("gated", "gated"), paths: ["src/**"] };
  assert.equal(isSkillPathActive(gated, ["/elsewhere/project/src/a.ts"], "/repo/current"), false);
  assert.equal(isSkillPathActive(gated, ["/repo/current/src/a.ts"], "/repo/current"), true);
  assert.equal(isSkillPathActive(gated, [], "/repo/current"), false);
});

test("keeps one command's output from rewriting another command's placeholder", async () => {
  const signal = new AbortController().signal;
  const runCommand = async (command: string): Promise<string> =>
    command === "first" ? "X !`second` Y" : "SECOND-OUT";
  const result = await expandShellSubstitutions("a !`first` b !`second` c", "bash", {
    sessionId: "s", cwd: "/tmp", signal, runCommand,
  });
  assert.equal(result, "a X !`second` Y b SECOND-OUT c");
});

test("treats a successful silent command as empty output", async () => {
  const signal = new AbortController().signal;
  const result = await expandShellSubstitutions("Status: !`true` end", "bash", {
    sessionId: "s", cwd: "/tmp", signal, runCommand: async (): Promise<string> => "(no output)",
  });
  assert.equal(result, "Status:  end");
});

test("substitutes arguments into authored shell commands before running them", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "run", "SKILL.md"), "Result: !`echo $ARGUMENTS`");
    const [skill] = await discovery(fx);
    const executed: string[] = [];
    const expanded = await expandSkill(skill!, "prod", {
      sessionId: "s",
      cwd: fx.project,
      signal: new AbortController().signal,
      runCommand: async (command: string): Promise<string> => {
        executed.push(command);
        return command.toUpperCase();
      },
    });
    assert.deepEqual(executed, ["echo prod"]);
    assert.equal(expanded.content, "Base directory for this skill: "
      + `${join(fx.project, ".amber", "skills", "run")}\n\nResult: ECHO PROD`);
  } finally {
    await fx.cleanup();
  }
});

test("never executes shell syntax introduced by arguments", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.project, ".amber", "skills", "deploy", "SKILL.md"), "Deploy using: $ARGUMENTS\nCheck !`echo ok`");
    const [skill] = await discovery(fx);
    const executed: string[] = [];
    const expanded = await expandSkill(skill!, "!`touch /tmp/pwned`", {
      sessionId: "s",
      cwd: fx.project,
      signal: new AbortController().signal,
      runCommand: async (command: string): Promise<string> => {
        executed.push(command);
        return `<${command}>`;
      },
    });
    assert.deepEqual(executed, ["echo ok"]);
    assert.equal(expanded.content.includes("touch /tmp/pwned"), true);
    assert.equal(expanded.content.includes("<echo ok>"), true);
  } finally {
    await fx.cleanup();
  }
});

test("keeps flow-style lists intact when another frontmatter value needs quoting", async () => {
  const fx = await fixture();
  try {
    await write(join(fx.home, ".amber", "skills", "mixed", "SKILL.md"), [
      "---",
      "argument-hint: [left] [right]",
      "paths: [src/**, docs]",
      "allowed-tools: [Bash, Read]",
      "---",
      "Body",
    ].join("\n"));
    const [skill] = await discovery(fx);
    assert.equal(skill?.argumentHint, "[left] [right]");
    assert.deepEqual(skill?.paths, ["src", "docs"]);
    assert.deepEqual(skill?.allowedTools, ["Bash", "Read"]);
  } finally {
    await fx.cleanup();
  }
});
