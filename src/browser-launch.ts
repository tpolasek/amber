import { spawn } from "node:child_process";

interface BrowserCommand {
  command: string;
  args: string[];
}

export function browserUrl(host: string, port: number): string {
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost = localHost.includes(":")
    ? `[${localHost.replace(/^\[|\]$/g, "")}]`
    : localHost;
  return `http://${urlHost}:${port}`;
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand | null {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  return null;
}

export function openBrowser(url: string): void {
  if (browserLaunchSuppressed()) return;
  const launch = browserCommand(url);
  if (!launch) return;
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => undefined);
  child.unref();
}

/** Automated runs (end-to-end tests) suppress the browser window with AMBER_NO_BROWSER. */
export function browserLaunchSuppressed(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.AMBER_NO_BROWSER ?? "");
}
