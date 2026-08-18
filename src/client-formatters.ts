export function compactHeaderPath(path: string, homeDirectory: string): string {
  const displayed = path === homeDirectory
    ? "~"
    : path.startsWith(`${homeDirectory}/`)
      ? `~/${path.slice(homeDirectory.length + 1)}`
      : path;
  if (displayed.length <= 48) return displayed;

  const prefix = displayed.startsWith("~/") ? "~/" : displayed.startsWith("/") ? "/" : "";
  const parts = displayed.slice(prefix.length).split("/").filter(Boolean);
  return parts.length > 2 ? `${prefix}…/${parts.slice(-2).join("/")}` : displayed;
}

export function formatTokenCountInThousands(tokens: number): string {
  if (tokens === 0) return "0";
  const thousands = tokens / 1_000;
  const display = thousands < 100 ? Math.floor(thousands * 10) / 10 : Math.round(thousands);
  return display.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

export function taskRuntime(task: { durationMs?: number; startedAt: string }, now = Date.now()): number {
  return task.durationMs ?? Math.max(0, now - Date.parse(task.startedAt));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 60
    ? "second"
    : Math.abs(seconds) < 3600
      ? "minute"
      : Math.abs(seconds) < 86400
        ? "hour"
        : "day";
  const divisor = unit === "second" ? 1 : unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

export function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

export function commitCommandPrompt(command: string): string | null {
  const argument = command.trim().split(/\s+/).slice(1).join(" ").trim().toLowerCase();
  if (argument && argument !== "push") return null;
  return [
    "Commit the current changes in this git repository.",
    "Review the working tree (git status, git diff, git diff --cached) and the recent commit style (git log), then stage and commit the changes.",
    "Create a concise, to-the-point commit title, favor bullet points in the body section, and make sure the body covers the high-level details of the change.",
    argument === "push" ? "After creating the commit, push it to the remote." : "Do not push the commit.",
  ].join(" ");
}

export type GitCommandRequest =
  | { kind: "git-view"; view: "diff" | "show" | "status" }
  | { kind: "commit"; push: boolean };

export interface GitCommandSuggestion {
  value: string;
  description: string;
}

export const GIT_COMMAND_SUGGESTIONS: GitCommandSuggestion[] = [
  { value: "/git diff", description: "Show unstaged working-tree changes" },
  { value: "/git show", description: "Show the latest commit" },
  { value: "/git status", description: "Show working-tree status" },
  { value: "/git commit", description: "Commit current changes" },
  { value: "/git commit push", description: "Commit current changes and push" },
];

export function gitCommandSuggestions(input: string): GitCommandSuggestion[] | null {
  const value = input.trimStart();
  if (!/^\/git(?:\s|$)/i.test(value)) return null;
  const typed = value.replace(/\s+/g, " ").replace(/\s+$/, "").toLowerCase();
  return GIT_COMMAND_SUGGESTIONS.filter((suggestion) => suggestion.value.startsWith(typed));
}

export function parseGitCommand(command: string): GitCommandRequest | null {
  const parts = command.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== "/git") return null;
  const subcommand = parts[1]?.toLowerCase();
  if (subcommand === "diff" || subcommand === "show" || subcommand === "status") {
    return parts.length === 2 ? { kind: "git-view", view: subcommand } : null;
  }
  if (subcommand === "commit") {
    const argument = parts.slice(2).join(" ").trim().toLowerCase();
    if (argument && argument !== "push") return null;
    return { kind: "commit", push: argument === "push" };
  }
  return null;
}
