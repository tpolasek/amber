# Plugins

A plugin is a bundle of skills and commands published by a **marketplace** and installed into
Amber's own cache. Marketplaces are named git repositories or local directories; Amber reads the
same manifest format Claude Code uses, so a marketplace written for Claude Code works unchanged.

Marketplaces, installs, and updates are driven from the `/plugin` slash command. Enabling and
disabling an installed plugin can also be done in the web settings modal.

## Before you install anything: what runs

**Installing and enabling a plugin is running third-party code with your privileges.**

A skill body may contain shell substitutions, written as `` !`command` `` inline or as a
` ```! ` fenced block. When a skill is invoked, Amber runs every such command in your shell, as
your user, before the skill text ever reaches the model, and splices the output into the prompt.
A plugin skill is an ordinary skill, so a plugin you install and leave enabled can run anything
you can run: read your files, reach the network, change your repository.

Amber's protections are deliberate but narrow:

- Only shell patterns **authored in the skill body** are executed. Arguments you pass to a skill
  are substituted as text and can never introduce a command of their own.
- `/plugin install` and `/plugin update` fetch nothing until you confirm. They first print the
  resolved source, ref, version, and commit sha, and wait for you to re-run the command with
  `--yes`.
- Nothing auto-updates, and nothing is enabled beyond the plugin you installed.

Install only from sources you trust, and read a plugin's skills the way you would read a shell
script someone asked you to run.

## Quick start

```
/plugin marketplace add anthropics/claude-plugins-official
/plugin list
/plugin install superpowers          # prints the plan; installs nothing
/plugin install superpowers --yes    # fetches and installs
```

The plugin is enabled as soon as it is installed. Skills are rediscovered on every message, so
its skills are available immediately, namespaced under the plugin name: `superpowers:brainstorming`.

Later:

```
/plugin installed                    # what is installed, and what is switched off
/plugin disable superpowers          # keeps it installed, stops it contributing skills
/plugin enable superpowers
/plugin marketplace update           # refetch marketplaces, so drift is measured against today
/plugin update                       # report drift for every installed plugin
/plugin update superpowers --yes     # apply one update
/plugin uninstall superpowers        # removes the record and the cached bundle
```

## Command reference

| Command | What it does |
|---|---|
| `/plugin` | Added marketplaces plus the command list |
| `/plugin marketplace add <owner/repo \| url \| directory> [as <name>]` | Fetches a marketplace and records it |
| `/plugin marketplace list` | Added marketplaces with their source and commit |
| `/plugin marketplace update [name]` | Refetches one marketplace, or every one |
| `/plugin marketplace remove <name>` | Drops the marketplace; installed plugins are untouched |
| `/plugin list [marketplace]` | Published plugins, and whether each is installed |
| `/plugin installed` | Installed plugins with version, commit, scope, and enable state |
| `/plugin install <plugin>[@marketplace] [--project] [--yes]` | Shows the install plan; `--yes` performs it |
| `/plugin update [<plugin>[@marketplace]] [--project] [--yes]` | Bare: drift report. Named: update plan; `--yes` applies it |
| `/plugin uninstall <plugin>[@marketplace] [--project]` | Removes the record, and the bundle once unreferenced |
| `/plugin enable <plugin>[@marketplace] [--project]` | Writes `true` into `enabled_plugins` |
| `/plugin disable <plugin>[@marketplace] [--project]` | Writes `false` into `enabled_plugins` |

Notes that are easy to trip over:

- **A marketplace spec** is `owner/repo` (GitHub, optionally `owner/repo@ref`), any git URL, or a
  local directory path. The marketplace's name comes from its own manifest unless you pass
  `as <name>`. Adding a second marketplace under a name already in use is refused rather than
  overwriting the first.
- **A bare plugin name** must be unambiguous. If two added marketplaces publish `foo`, name it
  `foo@<marketplace>`; the same rule applies to uninstall, update, enable, and disable against the
  installed plugins.
- **Bare `/plugin update` takes no flags, not even `--yes`.** There is no "update everything"
  apply: each apply runs third-party code, so it is always named explicitly.
- **`--project`** installs or toggles for one project rather than for your user; see
  [Scopes](#scopes).

## Enable state

Enable state lives in a TOML table keyed by `<plugin>@<marketplace>`:

```toml
[enabled_plugins]
"superpowers@claude-plugins-official" = false
```

A key that is absent means **enabled**, so a freshly installed plugin needs no settings write at
all; disabling writes `false`. `/plugin enable` and `/plugin disable` edit this table for you, in
place: comments, key order, and the rest of the file survive the edit. If you have written
`enabled_plugins` as an inline table (`enabled_plugins = { ... }`), rewrite it as an
`[enabled_plugins]` section before toggling; Amber refuses to edit the inline form rather than
reformat your file.

Disabling a plugin leaves it installed. Its bundle stays in the cache and its registry record
stays in place; it simply stops contributing skills and commands.

### From the settings modal

The web settings modal has a **PLUGINS** section listing every plugin installed at user scope,
each with an enable checkbox. The list comes from the installed-plugins registry, so a plugin that
has never been toggled is listed and reads as enabled, with no key written for it.

A checkbox writes the same `[enabled_plugins]` table `/plugin enable` and `/plugin disable` write,
in place and one key at a time, and it takes effect on the next message of an open session. It is
written when you click it, not when you press SAVE.

The modal edits your own `~/.amber/settings.toml`, so it shows user-scope installs only. A plugin
installed for one project is named in a note under the list and is toggled with
`/plugin enable <plugin> --project` from inside that project.

## Scopes

A plugin can be installed and toggled for your user (the default) or for one project (`--project`).

| | User scope | Project scope |
|---|---|---|
| Registry record | `scope: "user"` | `scope: "project"`, with the project root recorded |
| Enable state file | `~/.amber/settings.toml` | `<project>/.amber/settings.toml` |
| Applies to | every session | sessions whose working directory is the project root or below it |

A project record shadows a user record for the same plugin when the session sits inside the
project. The two enable tables merge key by key, the project one winning.

Three rules worth knowing:

- **A project settings file may only set `enabled_plugins`.** Any other key is a hard error on
  every message in that directory, not a silently ignored line. It is deliberately not a second
  full settings document: it can never override a provider or an API key.
- **Project settings resolve to the nearest ancestor, and that file wins whole.** Amber walks up
  from the session's working directory to the first `.amber/settings.toml` it finds and uses only
  that one. Files at a repository root and in a package directory do not layer; from inside the
  package, only the package file is read.
- **`--project` writes at the session's own working directory**, not at the nearest existing
  project file. Running `/plugin disable x --project` from `repo/packages/app` creates
  `repo/packages/app/.amber/settings.toml`, which then shadows `repo/.amber/settings.toml` for
  that subtree.

## Authoring a plugin

### 1. The bundle

A plugin bundle is a directory tree. Only two directories are read, and each is independently
optional:

```
<bundle>/
  .amber-plugin/plugin.json      # or .claude-plugin/plugin.json
  skills/<skill-name>/SKILL.md   # plus any sibling files the skill references
  commands/<name>.md             # flat or nested; nesting namespaces with ':'
```

Everything else (`agents/`, `hooks/`, `scripts/`, `references/`, a README) is cached verbatim and
ignored. A plugin that ships only `agents/` installs cleanly and contributes nothing to Amber;
that is the correct outcome, not an error.

The bundle manifest is optional:

```json
{
  "name": "superpowers",
  "description": "Skills for planning, debugging and reviewing",
  "version": "6.3.0",
  "author": { "name": "obra" },
  "homepage": "https://github.com/obra/superpowers",
  "license": "MIT"
}
```

`name` must match the name the marketplace publishes, or the install is refused. `version` decides
the cache directory. With no manifest at all, the marketplace entry's `version` is used, and
failing that the first 12 characters of the commit sha.

A plugin skill is an ordinary Amber skill: a `SKILL.md` with the frontmatter Amber already parses
(`name`, `description`, `allowed-tools`, `argument-hint`, `arguments`, `paths`, `model`, `effort`,
`disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `shell`). There are no
plugin-specific frontmatter keys.

```markdown
---
name: brainstorming
description: Use before creative work to explore intent and requirements.
---

Instructions the model receives when the skill is invoked.
```

A command is a plain `.md` file under `commands/`; nested directories namespace it, so
`commands/git/sync.md` in plugin `foo` is invoked as `foo:git:sync`.

### 2. The marketplace manifest

A marketplace is any git repository or directory whose root carries
`.amber-plugin/marketplace.json`, or `.claude-plugin/marketplace.json` if the Amber file is
absent.

```json
{
  "name": "acme",
  "description": "Acme's internal plugins",
  "owner": { "name": "Acme" },
  "plugins": [
    {
      "name": "toolkit",
      "description": "Acme's release and review skills",
      "version": "1.4.0",
      "source": { "type": "url", "url": "https://github.com/acme/toolkit.git", "ref": "v1.4.0" }
    },
    {
      "name": "local-helpers",
      "description": "Shipped inside this marketplace repository",
      "source": "./plugins/local-helpers"
    }
  ]
}
```

`name` (both the marketplace's and each plugin's) must match `[a-z0-9][a-z0-9-]*`. Each plugin
needs `name`, `description`, and `source`; `version`, `author`, `homepage`, `category`, `license`,
and `keywords` are optional. Duplicate plugin names in one manifest are refused.

A `source` may be written four ways, and all four are accepted on read:

| Form | Meaning |
|---|---|
| `{"type": "url", "url": "...", "ref": "...", "sha": "...", "path": "..."}` | A git repository. `ref` is a branch or tag, `sha` pins a commit, `path` selects a subdirectory of the checkout |
| `{"type": "git-subdir", "url": "...", "path": "...", "ref": "...", "sha": "..."}` | A subdirectory of a repository, with `path` required |
| `{"type": "directory", "path": "..."}` | A directory inside the marketplace checkout. A path that escapes the checkout is refused |
| `"./plugins/thing"` | Shorthand for the `directory` form |

For compatibility with Claude Code marketplaces, the discriminator may be spelled `source` instead
of `type`, and `{"source": "github", "repo": "owner/name"}` is read as the `url` form. Amber's own
manifests should write `type`.

Pinning is worth thinking about. `sha` makes an install reproducible and makes the drift check
offline; a bare `ref` means Amber asks the remote for the current commit (`git ls-remote`) once
per plugin on every `/plugin update`.

### 3. Publishing and testing it

A local directory is a valid marketplace, so you can develop against one without pushing anything:

```
/plugin marketplace add ~/src/acme-marketplace as acme
/plugin install toolkit@acme --yes
```

A directory marketplace is re-read rather than compared by commit, so
`/plugin marketplace update acme` never reports it as changed even when the manifest did change.
A plugin whose source is a `directory` drifts only when the marketplace entry's `version` moves.

## Namespacing and precedence

Every skill and command a plugin contributes is prefixed with the plugin's **name** (not its
registry key): `superpowers:brainstorming`, never
`superpowers@claude-plugins-official:brainstorming`. Enable state and all `/plugin` output stay
keyed `<plugin>@<marketplace>`.

Plugin directories are searched **after** every local skill directory (`.amber/skills`,
`.amber/commands`, and the Claude-compatible `.claude` equivalents at project, `/add-dir`, and
home level), and the first skill with a given name wins. So a plugin can never displace one of
your own skills, and two plugins cannot collide with each other because their prefixes differ. Two
marketplaces publishing the same plugin name would collide, which is why install refuses that case
and asks for an alias.

Nothing is copied into `.amber/skills` and nothing is symlinked: discovery reads the cache
directly.

## On disk

```
~/.amber/plugins/
  marketplaces.json                          # added marketplaces, their source and last-fetched commit
  marketplaces/<marketplace>/                # the marketplace checkout
  cache/<marketplace>/<plugin>/<version>/    # the installed bundle
  installed_plugins.json                     # one record per plugin per scope
```

The registry record keeps the marketplace, version, commit sha, source, and cache path, which is
what lets `/plugin update` detect drift without a `.git` directory anywhere in the cache. The
layout deliberately mirrors Claude Code's, so importing an existing install stays straightforward.

Two consequences:

- **The checkouts carry no `.git`.** They are trees, not clones. The commit is what the registry
  recorded at fetch time.
- **Old versions are not reclaimed.** Updating to a new version discards the directory it
  replaces, but a plugin pinned to a moving branch with no published version accumulates
  sha-named directories. Amber ships no cache sweeper yet; `~/.amber/plugins/cache` can be pruned
  by hand.

If a bundle directory goes missing while its record remains, the session logs one warning and
carries on without that plugin rather than failing. Reinstall it, or uninstall it to clear the
record.
