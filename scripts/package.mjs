import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";

const hostPlatform = platform();
const defaultTarget = hostPlatform === "darwin" ? "macos" : hostPlatform;
const requestedTarget = process.argv[2] ?? defaultTarget;
if (!new Set(["linux", "macos"]).has(requestedTarget)) {
  console.error("Usage: node scripts/package.mjs [linux|macos]");
  process.exit(2);
}
if (requestedTarget === "linux" && hostPlatform !== "linux") {
  console.error("Build the Linux binary on Linux.");
  process.exit(1);
}
if (requestedTarget === "macos" && hostPlatform !== "darwin") {
  console.error("Build the macOS binary on macOS.");
  process.exit(1);
}
const releaseDirectory = join(process.cwd(), "release");
const pkgExecutable = join(process.cwd(), "node_modules", ".bin", hostPlatform === "win32" ? "pkg.cmd" : "pkg");
const commonPkgArguments = [
  ".",
  "--sea",
  "--compress",
  "Brotli",
];

await run("npm", ["run", "build"]);
await mkdir(releaseDirectory, { recursive: true });

if (requestedTarget === "linux") {
  await run(pkgExecutable, [
    ...commonPkgArguments,
    "--targets",
    "host",
    "--output",
    join(releaseDirectory, "amber-linux"),
  ]);
}

if (requestedTarget === "macos") {
  await run(pkgExecutable, [
    ...commonPkgArguments,
    "--targets",
    "host",
    "--output",
    join(releaseDirectory, "amber-macos"),
  ]);
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}
