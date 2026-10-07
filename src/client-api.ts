import { readServerSentEvents } from "./sse.js";

let authActionToken: () => string | undefined = () => undefined;

/** Supplies the auth-action token (from the loaded config) for privileged mutations. */
export function setAuthActionTokenProvider(provider: () => string | undefined): void {
  authActionToken = provider;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

export async function authMutation<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const token = authActionToken();
  if (!token) throw new Error("Authentication settings are not initialized");
  return await api<T>(path, {
    ...init,
    headers: { ...init.headers, "x-amber-auth-action-token": token },
  });
}

export async function settingsMutation<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const token = authActionToken();
  if (!token) throw new Error("Settings are not initialized");
  return await api<T>(path, {
    ...init,
    headers: { ...init.headers, "x-amber-auth-action-token": token },
  });
}

export async function responseError(response: Response): Promise<string> {
  try { return ((await response.json()) as { error?: string }).error ?? `Request failed (${response.status})`; }
  catch { return `Request failed (${response.status})`; }
}

export async function readEventStream(stream: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void): Promise<void> {
  for await (const { event, data } of readServerSentEvents(stream)) {
    onEvent(event, JSON.parse(data));
  }
}

export function notify(message: string): void {
  const toast = required<HTMLElement>("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 4200);
}

export function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export function requiredWithin(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
