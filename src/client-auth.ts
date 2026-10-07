import { api, authMutation, notify } from "./client-api.js";
import { messageFrom } from "./client-formatters.js";
import { elements } from "./client-state.js";
import type { ActiveAuthLogin, AuthLoginStart, AuthLoginStatus, AuthProviderStatus } from "./client-types.js";

/**
 * Settings-dialog hooks, registered by client-settings at startup. They keep
 * this module free of settings imports: auth owns the login flow, the settings
 * module owns how the dialog reacts to auth changes.
 */
export interface AuthUiHooks {
  isSettingsBusy(): boolean;
  saveAndLoginWithCodex(providerName: string, method: "browser" | "device_code"): Promise<void>;
  onLoginComplete(): Promise<void>;
  onLoggedOut(): Promise<void>;
  onAuthError(message: string): void;
}

let authUi: AuthUiHooks | undefined;

export function setAuthUiHooks(hooks: AuthUiHooks): void {
  authUi = hooks;
}

export let authProviders: AuthProviderStatus[] = [];
export let activeAuthLogin: ActiveAuthLogin | null = null;
export let authBusy = false;
let authPollTimer: number | undefined;

export async function loadAuthProviders(): Promise<void> {
  const response = await api<{ providers: AuthProviderStatus[] }>("/api/auth");
  authProviders = response.providers;
  renderAuthProviders();
}

export function renderAuthProviders(): void {
  const targets = [...elements.settingsProviderList.querySelectorAll<HTMLElement>(".settings-provider-auth-body")];
  for (const target of targets) target.replaceChildren();
  if (targets.length === 0) return;
  const provider = authProviders.find((candidate) => candidate.id === "openai-codex");
  if (!provider) {
    for (const target of targets) {
      const loading = document.createElement("div");
      loading.className = "settings-empty";
      loading.textContent = "Loading authentication status…";
      target.append(loading);
    }
    return;
  }

  for (const target of targets) target.append(authProviderCard(provider, target.dataset.providerName ?? ""));
}

export function authProviderCard(provider: AuthProviderStatus, providerName: string): HTMLElement {
  const card = document.createElement("section");
  card.className = "auth-provider-card";
  const heading = document.createElement("div");
  heading.className = "auth-provider-heading";
  const identity = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "ChatGPT connection";
  const subtitle = document.createElement("p");
  subtitle.textContent = provider.authName;
  identity.append(title, subtitle);
  const status = document.createElement("span");
  status.className = `auth-status${provider.configured ? "" : " disconnected"}`;
  status.textContent = provider.configured ? "Connected" : "Not connected";
  heading.append(identity, status);
  card.append(heading);

  if (!provider.providerConfigured) {
    const note = document.createElement("p");
    note.className = "auth-note";
    note.textContent = "Starting either login flow will save this Codex provider before authentication.";
    card.append(note);
  }

  if (activeAuthLogin) {
    renderActiveAuthFlow(card, activeAuthLogin);
  } else {
    const actions = document.createElement("div");
    actions.className = "auth-actions";
    if (provider.configured) {
      actions.append(authButton("DISCONNECT", "danger", () => void logoutOpenAICodex()));
    } else {
      const browserLogin = authButton("BROWSER LOGIN", "", () => void (provider.providerConfigured
        ? startAuthLogin("browser")
        : authUi?.saveAndLoginWithCodex(providerName, "browser")));
      const deviceLogin = authButton("DEVICE CODE", "secondary", () => void (provider.providerConfigured
        ? startAuthLogin("device_code")
        : authUi?.saveAndLoginWithCodex(providerName, "device_code")));
      browserLogin.disabled = authBusy || (authUi?.isSettingsBusy() ?? false);
      deviceLogin.disabled = authBusy || (authUi?.isSettingsBusy() ?? false);
      actions.append(browserLogin, deviceLogin);
    }
    card.append(actions);
  }
  return card;
}

export function renderActiveAuthFlow(card: HTMLElement, login: ActiveAuthLogin): void {
  const flow = document.createElement("div");
  flow.className = "auth-flow";
  if (login.status.status === "failed" || login.status.status === "cancelled") {
    const error = document.createElement("p");
    error.className = "auth-error";
    error.textContent = login.status.status === "failed" ? login.status.error : "Login cancelled";
    const back = authButton("TRY AGAIN", "secondary", () => {
      activeAuthLogin = null;
      renderAuthProviders();
    });
    flow.append(error, back);
    card.append(flow);
    return;
  }

  const label = document.createElement("strong");
  label.textContent = login.start.method === "browser"
    ? "Waiting for browser authorization…"
    : "Waiting for device authorization…";
  flow.append(label);
  if (login.start.method === "browser") {
    const link = externalLink(login.start.authorizationUrl, "Open the OpenAI authorization page");
    const note = document.createElement("p");
    note.textContent = login.start.callbackAvailable
      ? "The local callback will finish automatically. For remote access, paste the final redirect URL or authorization code below."
      : "The local callback port is unavailable. Paste the final redirect URL or authorization code below.";
    const form = document.createElement("form");
    form.className = "auth-manual-form";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = login.start.redirectUri;
    input.autocomplete = "off";
    input.spellcheck = false;
    const submit = authButton("SUBMIT CODE", "", () => undefined);
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitManualAuth(input.value);
    });
    flow.append(link, note, form);
  } else {
    const code = document.createElement("code");
    code.textContent = login.start.userCode;
    const link = externalLink(login.start.verificationUri, "Open the OpenAI device authorization page");
    flow.append(code, link);
  }
  const actions = document.createElement("div");
  actions.className = "auth-actions";
  actions.append(authButton("CANCEL", "secondary", () => void cancelActiveAuthLogin()));
  flow.append(actions);
  card.append(flow);
}

export function authButton(label: string, variant: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `auth-button${variant ? ` ${variant}` : ""}`;
  button.textContent = label;
  button.disabled = authBusy || (authUi?.isSettingsBusy() ?? false);
  button.addEventListener("click", action);
  return button;
}

export function externalLink(url: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

/** Detaches a still-pending login when the settings dialog closes; returns its id. */
export function abandonActiveAuthLogin(): string | null {
  const login = activeAuthLogin;
  if (login?.status.status !== "pending") return null;
  activeAuthLogin = null;
  return login.start.id;
}

export async function startAuthLogin(method: "browser" | "device_code", existingPopup: Window | null = null): Promise<void> {
  if (authBusy) return;
  const popup = method === "browser" ? existingPopup ?? window.open("about:blank", "_blank") : null;
  authBusy = true;
  renderAuthProviders();
  try {
    const start = await authMutation<AuthLoginStart>("/api/auth/openai-codex/login", {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    activeAuthLogin = { start, status: { status: "pending" } };
    if (start.method === "browser" && popup) popup.location.href = start.authorizationUrl;
    renderAuthProviders();
    scheduleAuthPoll();
  } catch (error) {
    popup?.close();
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthProviders();
  }
}

export function scheduleAuthPoll(): void {
  stopAuthPolling();
  authPollTimer = window.setTimeout(() => void pollAuthLogin(), 2_000);
}

export function stopAuthPolling(): void {
  if (authPollTimer !== undefined) window.clearTimeout(authPollTimer);
  authPollTimer = undefined;
}

export async function pollAuthLogin(): Promise<void> {
  const login = activeAuthLogin;
  if (!login || login.status.status !== "pending") return;
  try {
    const status = await api<AuthLoginStatus>(`/api/auth/openai-codex/logins/${login.start.id}`);
    if (activeAuthLogin?.start.id !== login.start.id) return;
    activeAuthLogin.status = status;
    if (status.status === "pending") {
      scheduleAuthPoll();
    } else if (status.status === "complete") {
      await completeAuthLogin();
    } else {
      renderAuthProviders();
    }
  } catch (error) {
    if (activeAuthLogin?.start.id === login.start.id) {
      activeAuthLogin.status = { status: "failed", error: messageFrom(error) };
      renderAuthProviders();
    }
  }
}

export async function submitManualAuth(input: string): Promise<void> {
  const login = activeAuthLogin;
  if (!login || login.start.method !== "browser" || authBusy) return;
  authBusy = true;
  renderAuthProviders();
  try {
    const status = await authMutation<AuthLoginStatus>(
      `/api/auth/openai-codex/logins/${login.start.id}/manual`,
      { method: "POST", body: JSON.stringify({ input }) },
    );
    if (status.status === "complete") await completeAuthLogin();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthProviders();
  }
}

export async function completeAuthLogin(): Promise<void> {
  activeAuthLogin = null;
  stopAuthPolling();
  await loadAuthProviders();
  await authUi?.onLoginComplete();
}

export async function cancelActiveAuthLogin(): Promise<boolean> {
  const login = activeAuthLogin;
  if (!login) return true;
  if (authBusy) return false;
  authBusy = true;
  stopAuthPolling();
  try {
    await authMutation(`/api/auth/openai-codex/logins/${login.start.id}`, { method: "DELETE" });
    activeAuthLogin = null;
    return true;
  } catch (error) {
    notify(messageFrom(error));
    return false;
  } finally {
    authBusy = false;
    renderAuthProviders();
  }
}

export async function logoutOpenAICodex(showNotification = true): Promise<boolean> {
  if (authBusy) return false;
  authBusy = true;
  renderAuthProviders();
  try {
    await authMutation("/api/auth/openai-codex", { method: "DELETE" });
    await loadAuthProviders();
    await authUi?.onLoggedOut();
    if (showNotification) notify("OpenAI Codex disconnected");
    return true;
  } catch (error) {
    const message = messageFrom(error);
    authUi?.onAuthError(message);
    notify(message);
    return false;
  } finally {
    authBusy = false;
    renderAuthProviders();
  }
}
