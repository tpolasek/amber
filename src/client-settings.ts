import { api, authMutation, notify, settingsMutation } from "./client-api.js";
import {
  activeAuthLogin,
  authBusy,
  authProviders,
  abandonActiveAuthLogin,
  cancelActiveAuthLogin,
  loadAuthProviders,
  logoutOpenAICodex,
  refreshConfig,
  renderAuthProviders,
  startAuthLogin,
  stopAuthPolling,
} from "./client-auth.js";
import { renderModelStatus, renderPlanMode } from "./client-chrome.js";
import { messageFrom } from "./client-formatters.js";
import {
  settingsCheckboxField,
  settingsEmptyState,
  settingsField,
  settingsModelSelectionField,
  settingsNumberField,
  settingsReadOnlyField,
  settingsRemoveButton,
  settingsSelectField,
  settingsTextAreaField,
  settingsTextField,
  settingsThinkingField,
  settingsUnqualifiedModelLabel,
} from "./client-settings-fields.js";
import { elements, state } from "./client-state.js";
import type {
  AmberTheme,
  AvailableModel,
  EditableAgentSettings,
  EditableModelSettings,
  EditableProviderSettings,
  EditableSettings,
  SavedSettings,
  SettingsDocument,
} from "./client-types.js";
import type { ThinkingLevel } from "./thinking-level.js";

// client-settings and client-auth import each other for the Codex login flow
// that lives inside the settings dialog. The cycle only runs through event
// handlers, never at module evaluation time.
export let settingsBusy = false;
export let settingsDraft: EditableSettings | null = null;

export function renderConfig(): void {
  if (!state.config) return;
  document.documentElement.dataset.theme = state.config.theme;
  const needsSettings = settingsDialogIsBlocking();
  elements.providerDot.classList.toggle("demo", needsSettings);
  elements.settingsButton.classList.toggle("attention", needsSettings);
  renderSettingsBusyState();
  renderModelStatus();
  renderPlanMode();
}

export async function openSettingsDialog(): Promise<void> {
  elements.settingsDialog.hidden = false;
  document.body.classList.remove("sidebar-open");
  renderAuthProviders();
  settingsBusy = true;
  renderSettingsBusyState();
  try {
    const [document] = await Promise.all([
      api<SettingsDocument>("/api/settings"),
      loadAuthProviders(),
    ]);
    settingsDraft = document.settings;
    elements.settingsPath.textContent = document.path;
    elements.settingsStatus.textContent = document.error
      ? "Configuration needs attention"
      : "Changes are validated before the active configuration is updated.";
    showSettingsError(document.error);
    renderSettingsForm();
  } catch (error) {
    showSettingsError(messageFrom(error));
  } finally {
    settingsBusy = false;
    renderSettingsBusyState();
    renderAuthProviders();
    if (!elements.settingsDialog.hidden) elements.settingsForm.querySelector<HTMLElement>("button, input, select")?.focus();
  }
}

export async function closeSettingsDialog(): Promise<void> {
  if (settingsBusy || settingsDialogIsBlocking()) {
    elements.settingsStatus.textContent = settingsBlockingMessage();
    renderSettingsBusyState();
    return;
  }
  if (state.config) document.documentElement.dataset.theme = state.config.theme;
  elements.settingsDialog.hidden = true;
  settingsDraft = null;
  stopAuthPolling();
  const loginId = abandonActiveAuthLogin();
  if (loginId !== null) {
    renderAuthProviders();
    await authMutation(`/api/auth/openai-codex/logins/${loginId}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (!elements.landingDialog.hidden) elements.landingNewSession.focus();
  else elements.prompt.focus();
}

export function handleSettingsDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.settingsDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    if (settingsBusy || settingsDialogIsBlocking()) {
      elements.settingsStatus.textContent = settingsBlockingMessage();
    } else {
      void closeSettingsDialog();
    }
  } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void saveSettings();
  }
  return true;
}

export async function saveSettings(showNotification = true): Promise<boolean> {
  if (settingsBusy || !settingsDraft) return false;
  settingsBusy = true;
  showSettingsError();
  elements.settingsStatus.textContent = "Validating providers and discovering models…";
  renderSettingsBusyState();
  try {
    const result = await settingsMutation<SavedSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ settings: settingsDraft }),
    });
    state.config = result.config;
    document.documentElement.dataset.theme = result.config.theme;
    settingsDraft = result.settings;
    elements.settingsPath.textContent = result.path;
    showSettingsError(result.error);
    elements.settingsStatus.textContent = result.config.configured
      ? "Saved · Amber reloaded the active configuration."
      : "Saved · configuration needs attention before Amber can run a session.";
    renderSettingsForm();
    renderConfig();
    await loadAuthProviders();
    if (showNotification) {
      notify(result.config.configured ? "Settings saved and reloaded" : "Settings saved · configuration needs attention");
    }
    return true;
  } catch (error) {
    const message = messageFrom(error);
    showSettingsError(message);
    elements.settingsStatus.textContent = "Not saved · fix the configuration error and try again.";
    return false;
  } finally {
    settingsBusy = false;
    renderSettingsBusyState();
    renderAuthProviders();
  }
}

export async function saveSettingsAndClose(): Promise<void> {
  if (!(await saveSettings())) return;
  if (settingsDialogIsBlocking()) {
    elements.settingsStatus.textContent = settingsBlockingMessage();
    return;
  }
  await closeSettingsDialog();
}

export function renderSettingsForm(): void {
  renderThemeOptions();
  renderSettingsDefaults();
  renderProviderSettings();
  renderAgentSettings();
  renderSettingsBusyState();
}

export function renderThemeOptions(): void {
  elements.settingsThemeOptions.replaceChildren();
  if (!settingsDraft) return;
  const themes: Array<{ id: AmberTheme; label: string }> = [
    { id: "light+", label: "LIGHT+" },
    { id: "light", label: "SOLARIZED LIGHT" },
    { id: "dark", label: "DARK" },
    { id: "hacker", label: "HACKER" },
  ];
  for (const theme of themes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings-theme-button${settingsDraft.theme === theme.id ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(settingsDraft.theme === theme.id));
    const swatch = document.createElement("span");
    swatch.className = `settings-theme-swatch theme-${theme.id.replace("+", "-plus")}`;
    const label = document.createElement("span");
    label.textContent = theme.label;
    button.append(swatch, label);
    button.addEventListener("click", () => {
      if (!settingsDraft) return;
      settingsDraft.theme = theme.id;
      document.documentElement.dataset.theme = theme.id;
      markSettingsDirty();
      renderThemeOptions();
      renderSettingsBusyState();
    });
    elements.settingsThemeOptions.append(button);
  }
}

export function renderSettingsDefaults(): void {
  elements.settingsDefaults.replaceChildren();
  if (!settingsDraft) return;
  const providerNames = Object.keys(settingsDraft.providers);
  const defaultProvider = settingsSelectField("DEFAULT PROVIDER", settingsDraft.default_provider ?? "", [
    { value: "", label: "First configured provider" },
    ...providerNames.map((name) => ({ value: name, label: name })),
  ], (value) => {
    if (!settingsDraft) return;
    setOptionalString(settingsDraft, "default_provider", value);
    markSettingsDirty();
  });
  const agentDefaults = document.createElement("div");
  agentDefaults.className = "settings-default-agent-fields";
  agentDefaults.append(
    settingsSelectField("DEFAULT AGENT PROVIDER", settingsDraft.default_agent_provider ?? "", [
      { value: "", label: "Inherit session provider" },
      ...providerNames.map((name) => ({ value: name, label: name })),
    ], (value) => {
      if (!settingsDraft) return;
      setOptionalString(settingsDraft, "default_agent_provider", value);
      if (!value) delete settingsDraft.default_agent_model;
      markSettingsDirty();
      renderSettingsDefaults();
      renderSettingsBusyState();
    }),
    settingsDefaultAgentModelField(settingsDraft.default_agent_provider, settingsDraft.default_agent_model, (value) => {
      if (!settingsDraft) return;
      setOptionalString(settingsDraft, "default_agent_model", value);
      markSettingsDirty();
    }),
  );
  elements.settingsDefaults.append(defaultProvider, agentDefaults);
}

export function settingsAgentModelField(agent: EditableAgentSettings): HTMLLabelElement {
  const models = state.config?.models ?? [];
  return settingsModelSelectionField({
    label: "MODEL OVERRIDE",
    value: agent.model,
    models,
    emptyLabel: "Inherit configured defaults",
    placeholder: "provider/model (optional)",
    optionValue: (model) => model.key,
    optionLabel: (model) => `${model.provider}/${model.displayName}`,
    onChange: (value) => {
      setOptionalString(agent, "model", value);
      markSettingsDirty();
    },
  });
}

export function settingsProviderDefaultModelField(
  providerName: string,
  value: string | undefined,
  onChange: (value: string) => void,
): HTMLLabelElement {
  const models = (state.config?.models ?? []).filter((model) => model.provider === providerName);
  return settingsModelSelectionField({
    label: "DEFAULT MODEL",
    value,
    models,
    emptyLabel: "Default: First discovered model",
    placeholder: "Default model. Press save to load the model list.",
    optionValue: (model) => model.model,
    optionLabel: settingsUnqualifiedModelLabel,
    onChange,
  });
}

export function settingsDefaultAgentModelField(
  providerName: string | undefined,
  value: string | undefined,
  onChange: (value: string) => void,
): HTMLLabelElement {
  const models = providerName
    ? (state.config?.models ?? []).filter((model) => model.provider === providerName)
    : [];
  const field = settingsModelSelectionField({
    label: "DEFAULT AGENT MODEL",
    value,
    models,
    emptyLabel: "Provider default model",
    placeholder: "Model id (optional)",
    optionValue: (model) => model.model,
    optionLabel: settingsUnqualifiedModelLabel,
    onChange,
  });
  const control = field.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");
  if (control && !providerName) {
    control.disabled = true;
    control.dataset.permanentlyDisabled = "true";
  }
  return field;
}

export function renderProviderSettings(): void {
  elements.settingsProviderList.replaceChildren();
  if (!settingsDraft) return;
  const entries = Object.entries(settingsDraft.providers);
  elements.settingsLoginCodex.hidden = entries.some(([, provider]) => provider.auth === "openai-codex");
  if (entries.length === 0) {
    elements.settingsProviderList.append(settingsEmptyState("No providers configured. Add an API provider or log in with Codex."));
    return;
  }
  for (const [name, provider] of entries) elements.settingsProviderList.append(providerSettingsCard(name, provider));
  renderAuthProviders();
}

export function providerSettingsCard(name: string, provider: EditableProviderSettings): HTMLElement {
  const card = document.createElement("article");
  card.className = "settings-card";
  const heading = document.createElement("div");
  heading.className = "settings-card-heading";
  const identity = document.createElement("div");
  identity.className = "settings-card-identity";
  const nameField = document.createElement("label");
  nameField.className = "settings-provider-name";
  const nameLabel = document.createElement("span");
  nameLabel.textContent = provider.auth === "openai-codex" ? "PROVIDER (CODEX OAUTH)" : "PROVIDER (API)";
  const nameInput = document.createElement("input");
  nameInput.value = name;
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;
  nameInput.setAttribute("aria-label", "Provider name");
  nameInput.addEventListener("change", () => renameProvider(name, nameInput.value));
  nameField.append(nameLabel, nameInput);
  identity.append(nameField);
  heading.append(identity, settingsRemoveButton("Remove provider", () => void removeProvider(name)));

  const fields = document.createElement("div");
  fields.className = "settings-field-grid";
  if (provider.auth === "openai-codex") {
    fields.append(settingsReadOnlyField("PROVIDER API", "OpenAI Responses"));
  } else {
    fields.append(settingsSelectField("PROVIDER API", provider.api, [
      { value: "anthropic", label: "Anthropic Messages" },
      { value: "openai", label: "OpenAI Responses" },
    ], (value) => {
      provider.api = value as EditableProviderSettings["api"];
      markSettingsDirty();
    }));
    fields.append(settingsTextField("API KEY", provider.auth_key ?? "", "Required", (value) => {
      setOptionalString(provider, "auth_key", value);
      markSettingsDirty();
    }, { type: "password" }));
  }
  fields.append(
    settingsTextField("API URL", provider.auth_url ?? "", provider.auth === "openai-codex"
      ? "https://chatgpt.com/backend-api (default)"
      : "Required API base URL", (value) => {
      setOptionalString(provider, "auth_url", value);
      markSettingsDirty();
    }),
    settingsProviderDefaultModelField(name, provider.default_model, (value) => {
      setOptionalString(provider, "default_model", value);
      markSettingsDirty();
    }),
    settingsThinkingField("THINKING LEVEL", provider.thinking_level, (value) => {
      setOptionalThinking(provider, value);
      markSettingsDirty();
    }),
    settingsNumberField("COMPACT TOKENS", provider.compact_tokens, "200000", (value) => {
      setOptionalNumber(provider, "compact_tokens", value);
      markSettingsDirty();
    }),
    settingsNumberField("MAX OUTPUT TOKENS", provider.max_output_tokens, "32000", (value) => {
      setOptionalNumber(provider, "max_output_tokens", value);
      markSettingsDirty();
    }),
  );

  const models = document.createElement("details");
  models.className = "settings-models";
  if (Object.keys(provider.models).length > 0) models.open = true;
  const summary = document.createElement("summary");
  summary.textContent = `MODEL OVERRIDES (${Object.keys(provider.models).length})`;
  const list = document.createElement("div");
  list.className = "settings-model-list";
  for (const [modelName, model] of Object.entries(provider.models)) {
    list.append(modelSettingsRow(name, provider, modelName, model));
  }
  if (Object.keys(provider.models).length === 0) list.append(settingsEmptyState("No model-specific overrides."));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "settings-action-button";
  add.textContent = "ADD MODEL OVERRIDE";
  add.addEventListener("click", () => addModelOverride(name));
  models.append(summary, list, add);
  card.append(heading, fields, models);
  if (provider.auth === "openai-codex") {
    const authBody = document.createElement("div");
    authBody.className = "settings-provider-auth-body";
    authBody.dataset.providerName = name;
    card.append(authBody);
  }
  return card;
}

export function modelSettingsRow(
  providerName: string,
  provider: EditableProviderSettings,
  modelName: string,
  model: EditableModelSettings,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-model-row";
  const name = settingsTextField(
    "MODEL ID",
    modelName,
    "Model id",
    (value) => renameModel(providerName, modelName, value),
    { onChangeOnly: true },
  );
  row.append(
    name,
    settingsThinkingField("THINKING LEVEL", model.thinking_level, (value) => {
      setOptionalThinking(model, value);
      markSettingsDirty();
    }),
    settingsNumberField("COMPACT TOKENS", model.compact_tokens, "Provider default", (value) => {
      setOptionalNumber(model, "compact_tokens", value);
      markSettingsDirty();
    }),
    settingsNumberField("MAX OUTPUT TOKENS", model.max_output_tokens, "Provider default", (value) => {
      setOptionalNumber(model, "max_output_tokens", value);
      markSettingsDirty();
    }),
    settingsRemoveButton("Remove model override", () => {
      delete provider.models[modelName];
      markSettingsDirty();
      renderProviderSettings();
      renderSettingsBusyState();
    }),
  );
  return row;
}

export function renderAgentSettings(): void {
  elements.settingsAgentList.replaceChildren();
  if (!settingsDraft) return;
  if (settingsDraft.agents.length === 0) {
    elements.settingsAgentList.append(settingsEmptyState("No agents configured. Amber's Agent tool will be unavailable."));
    return;
  }
  settingsDraft.agents.forEach((agent, index) => elements.settingsAgentList.append(agentSettingsCard(agent, index)));
}

export function agentSettingsCard(agent: EditableAgentSettings, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "settings-card";
  const heading = document.createElement("div");
  heading.className = "settings-card-heading";
  const title = document.createElement("strong");
  title.textContent = agent.type || `Agent ${index + 1}`;
  heading.append(title, settingsRemoveButton("Remove agent", () => {
    settingsDraft?.agents.splice(index, 1);
    markSettingsDirty();
    renderAgentSettings();
    renderSettingsBusyState();
  }));
  const fields = document.createElement("div");
  fields.className = "settings-field-grid";
  fields.append(
    settingsTextField("TYPE", agent.type, "Unique agent type", (value) => {
      agent.type = value;
      title.textContent = value || `Agent ${index + 1}`;
      markSettingsDirty();
    }),
    settingsAgentModelField(agent),
    settingsThinkingField("THINKING LEVEL", agent.thinking_level, (value) => {
      setOptionalThinking(agent, value);
      markSettingsDirty();
    }, "Model default"),
  );
  const prompts = document.createElement("div");
  prompts.className = "settings-agent-prompts";
  prompts.append(
    settingsTextAreaField("WHEN TO USE", agent.whenToUse, "Describe when Amber should select this agent", (value) => {
      agent.whenToUse = value;
      markSettingsDirty();
    }),
    settingsTextAreaField("SYSTEM PROMPT", agent.systemPrompt, "Instructions for the agent", (value) => {
      agent.systemPrompt = value;
      markSettingsDirty();
    }),
  );
  const toggles = document.createElement("div");
  toggles.className = "settings-toggle-row";
  toggles.append(
    settingsCheckboxField("READ ONLY", agent.readOnly, (checked) => {
      agent.readOnly = checked;
      markSettingsDirty();
    }),
    settingsCheckboxField("AUTO-COMPACT", agent.compact === true, (checked) => {
      agent.compact = checked;
      markSettingsDirty();
    }),
  );
  card.append(heading, fields, prompts, toggles);
  return card;
}

export function addApiProvider(): void {
  if (!settingsDraft) return;
  const name = uniqueSettingsName("provider", Object.keys(settingsDraft.providers));
  settingsDraft.providers[name] = {
    api: "anthropic",
    compact_tokens: 200_000,
    models: {},
  };
  settingsDraft.default_provider ??= name;
  markSettingsDirty();
  renderSettingsForm();
  focusProviderName(name);
}

export async function setupAndLoginWithCodex(method: "browser" | "device_code" = "browser"): Promise<void> {
  if (!settingsDraft || settingsBusy || authBusy) return;
  if (Object.values(settingsDraft.providers).some((provider) => provider.auth === "openai-codex")) {
    renderProviderSettings();
    return;
  }
  for (const [name, provider] of Object.entries(settingsDraft.providers)) {
    if (name === "default" && provider.api === "anthropic" && provider.thinking_level === "max"
      && (provider.compact_tokens === 100_000 || provider.compact_tokens === 200_000)
      && provider.auth !== "openai-codex"
      && !provider.auth_key && !provider.auth_url && !provider.default_model
      && Object.keys(provider.models).length === 0) {
      removeProviderFromDraft(name);
    }
  }
  const codexName = uniqueSettingsName("openai-codex", Object.keys(settingsDraft.providers));
  settingsDraft.providers[codexName] = {
    api: "openai",
    auth: "openai-codex",
    thinking_level: "high",
    compact_tokens: 250_000,
    models: {},
  };
  settingsDraft.default_provider = codexName;
  markSettingsDirty();
  renderSettingsForm();
  const popup = method === "browser" ? window.open("about:blank", "_blank") : null;
  if (!(await saveSettings(false))) {
    popup?.close();
    return;
  }
  if (authProviders.some((provider) => provider.id === "openai-codex" && provider.configured)) {
    popup?.close();
    notify(`Codex provider '${codexName}' added · using the existing ChatGPT connection`);
    return;
  }
  await startAuthLogin(method, popup);
}

export async function saveAndLoginWithCodex(
  providerName: string,
  method: "browser" | "device_code",
): Promise<void> {
  if (!settingsDraft || settingsBusy || authBusy) return;
  if (settingsDraft.providers[providerName]?.auth !== "openai-codex") {
    showSettingsError(`Codex provider '${providerName}' is no longer available.`);
    return;
  }
  const popup = method === "browser" ? window.open("about:blank", "_blank") : null;
  if (!(await saveSettings(false))) {
    popup?.close();
    return;
  }
  if (authProviders.some((provider) => provider.id === "openai-codex" && provider.configured)) {
    popup?.close();
    notify("OpenAI Codex is already connected");
    return;
  }
  await startAuthLogin(method, popup);
}

export function addAgent(): void {
  if (!settingsDraft) return;
  const name = uniqueSettingsName("agent", settingsDraft.agents.map((agent) => agent.type));
  settingsDraft.agents.push({
    type: name,
    whenToUse: "Use this agent for focused tasks.",
    systemPrompt: "Complete the requested task and return concise findings.",
    readOnly: false,
    compact: false,
  });
  markSettingsDirty();
  renderSettingsForm();
  elements.settingsAgentList.lastElementChild?.scrollIntoView({ block: "nearest" });
}

export async function removeProvider(name: string): Promise<void> {
  if (!settingsDraft) return;
  const provider = settingsDraft.providers[name];
  if (provider?.auth === "openai-codex") {
    if (activeAuthLogin && !(await cancelActiveAuthLogin())) return;
    if (!(await logoutOpenAICodex(false))) return;
  }
  removeProviderFromDraft(name);
  markSettingsDirty();
  renderSettingsForm();
}

export function removeProviderFromDraft(name: string): void {
  if (!settingsDraft) return;
  delete settingsDraft.providers[name];
  if (settingsDraft.default_provider === name) delete settingsDraft.default_provider;
  if (settingsDraft.default_agent_provider === name) {
    delete settingsDraft.default_agent_provider;
    delete settingsDraft.default_agent_model;
  }
  for (const agent of settingsDraft.agents) {
    if (agent.model?.startsWith(`${name}/`)) delete agent.model;
  }
}

export function renameProvider(previousName: string, requestedName: string): void {
  if (!settingsDraft) return;
  const name = requestedName.trim();
  if (!name || name.includes("/")) {
    showSettingsError("Provider names must be non-empty and cannot contain '/'.");
    return renderProviderSettings();
  }
  if (name !== previousName && settingsDraft.providers[name]) {
    showSettingsError(`Provider '${name}' already exists.`);
    return renderProviderSettings();
  }
  if (name === previousName) return;
  const provider = settingsDraft.providers[previousName];
  if (!provider) return;
  const renamed: Record<string, EditableProviderSettings> = {};
  for (const [candidate, value] of Object.entries(settingsDraft.providers)) {
    renamed[candidate === previousName ? name : candidate] = value;
  }
  settingsDraft.providers = renamed;
  if (settingsDraft.default_provider === previousName) settingsDraft.default_provider = name;
  if (settingsDraft.default_agent_provider === previousName) settingsDraft.default_agent_provider = name;
  for (const agent of settingsDraft.agents) {
    if (agent.model?.startsWith(`${previousName}/`)) agent.model = `${name}/${agent.model.slice(previousName.length + 1)}`;
  }
  markSettingsDirty();
  renderSettingsForm();
  focusProviderName(name);
}

export function addModelOverride(providerName: string): void {
  const provider = settingsDraft?.providers[providerName];
  if (!provider) return;
  const name = uniqueSettingsName("model", Object.keys(provider.models));
  provider.models[name] = {};
  markSettingsDirty();
  renderProviderSettings();
  renderSettingsBusyState();
}

export function renameModel(providerName: string, previousName: string, requestedName: string): void {
  const provider = settingsDraft?.providers[providerName];
  if (!provider) return;
  const name = requestedName.trim();
  if (!name || provider.api === "anthropic" && name.includes("/")) {
    showSettingsError(provider.api === "anthropic"
      ? "Anthropic model ids must be non-empty and cannot contain '/'."
      : "Model ids must be non-empty.");
    return renderProviderSettings();
  }
  if (name !== previousName && provider.models[name]) {
    showSettingsError(`Model override '${name}' already exists for ${providerName}.`);
    return renderProviderSettings();
  }
  if (name === previousName) return;
  const model = provider.models[previousName];
  if (!model) return;
  delete provider.models[previousName];
  provider.models[name] = model;
  if (provider.default_model === previousName) provider.default_model = name;
  if (settingsDraft?.default_agent_provider === providerName
    && settingsDraft.default_agent_model === previousName) {
    settingsDraft.default_agent_model = name;
  }
  for (const agent of settingsDraft?.agents ?? []) {
    if (agent.model === `${providerName}/${previousName}`) agent.model = `${providerName}/${name}`;
  }
  markSettingsDirty();
  renderProviderSettings();
  renderSettingsBusyState();
}

export function markSettingsDirty(): void {
  showSettingsError();
  elements.settingsStatus.textContent = "Unsaved changes";
}

export function setOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: string): void {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed as T[K];
  else delete target[key];
}

export function setOptionalThinking(target: EditableModelSettings, value: string): void {
  if (value) target.thinking_level = value as ThinkingLevel;
  else delete target.thinking_level;
}

export function setOptionalNumber(
  target: EditableModelSettings,
  key: "compact_tokens" | "max_output_tokens",
  value: string,
): void {
  if (value) target[key] = Number(value);
  else delete target[key];
}

export function uniqueSettingsName(base: string, existing: string[]): string {
  const names = new Set(existing);
  if (!names.has(base)) return base;
  let suffix = 2;
  while (names.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function focusProviderName(name: string): void {
  const input = [...elements.settingsProviderList.querySelectorAll<HTMLInputElement>(".settings-card-identity input")]
    .find((candidate) => candidate.value === name);
  input?.focus();
  input?.select();
}

export function showSettingsError(message?: string): void {
  elements.settingsError.hidden = !message;
  elements.settingsError.textContent = message ?? "";
  elements.settingsStatus.classList.toggle("error", Boolean(message));
}

export function renderSettingsBusyState(): void {
  const blocking = settingsDialogIsBlocking();
  for (const control of elements.settingsForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    "input, select, textarea, button",
  )) control.disabled = settingsBusy || control.dataset.permanentlyDisabled === "true";
  elements.settingsCancel.hidden = blocking;
  elements.settingsCancel.disabled = settingsBusy;
  elements.settingsSave.disabled = settingsBusy;
  elements.settingsSave.textContent = settingsBusy ? "VALIDATING…" : "SAVE";
  elements.settingsSaveClose.disabled = settingsBusy;
  elements.settingsSaveClose.textContent = settingsBusy ? "VALIDATING…" : "SAVE · CLOSE";
  elements.settingsClose.hidden = blocking;
  elements.settingsClose.disabled = settingsBusy;
}

export function settingsDialogIsBlocking(): boolean {
  return !state.config?.configured || state.config.authenticationRequired;
}

export function settingsBlockingMessage(): string {
  if (settingsBusy) return "Wait for the settings operation to finish.";
  return state.config?.authenticationRequired
    ? "Connect the default Codex provider to continue."
    : "Save a valid configuration to continue.";
}
