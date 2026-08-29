import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const outputFile = resolve(join(process.cwd(), "dist", "build-version.txt"));

function git(arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function normalize(version) {
  if (/^[0-9a-f]{40}$/i.test(version)) return version.slice(0, 12);
  return version;
}

function resolveVersion() {
  if (process.env.AMBER_VERSION) return normalize(process.env.AMBER_VERSION.trim());
  try {
    return git(["describe", "--tags", "--exact-match", "HEAD"]);
  } catch {
    try {
      return normalize(git(["rev-parse", "HEAD"]));
    } catch {
      return "dev";
    }
  }
}

const version = resolveVersion();
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${version}\n`, "utf8");
console.log(`Build version: ${version}`);
