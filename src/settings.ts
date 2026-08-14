import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AmberSettings {
  auth_key?: string;
  auth_url?: string;
  default_model?: string;
}

export const SETTINGS_TEMPLATE = {
  auth_key: "<INSERT_AUTH_KEY_HERE>",
  auth_url: "<INSERT_AUTH_URL_HERE>",
  default_model: "<INSERT_DEFAULT_MODEL_HERE>",
} as const;

export async function loadSettings(homeDirectory = homedir()): Promise<AmberSettings> {
  const settingsDirectory = join(homeDirectory, ".amber");
  const settingsPath = join(settingsDirectory, "settings.json");
  await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });

  try {
    await writeFile(settingsPath, `${JSON.stringify(SETTINGS_TEMPLATE, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${settingsPath}: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object`);
  }

  const settings = parsed as Record<string, unknown>;
  for (const key of ["auth_key", "auth_url", "default_model"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "string") {
      throw new Error(`${settingsPath}: ${key} must be a string`);
    }
  }
  return {
    ...(typeof settings.auth_key === "string" ? { auth_key: settings.auth_key } : {}),
    ...(typeof settings.auth_url === "string" ? { auth_url: settings.auth_url } : {}),
    ...(typeof settings.default_model === "string" ? { default_model: settings.default_model } : {}),
  };
}

export function configuredSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("<INSERT_") && trimmed.endsWith("_HERE>")) return undefined;
  return trimmed;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
