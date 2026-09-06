import { api, notify, requiredWithin } from "./client-api.js";
import { messageFrom, relativeTime } from "./client-formatters.js";
import { elements, state } from "./client-state.js";
import type { Summary } from "./client-types.js";

let summaries: Summary[] = [];
let sessionDialogSelection = 0;
let sessionDialogQuery = "";
let sessionDialogReturnsToLanding = false;

// Loading sessions and returning to the landing view stay in client.ts; the
// host handlers are registered there at startup.
interface SessionDialogHost {
  loadSession(id: string): Promise<void>;
  openLandingDialog(): void;
}

let host: SessionDialogHost | null = null;

export function setSessionDialogHost(dialogHost: SessionDialogHost): void {
  host = dialogHost;
}

export function handleSessionSearchInput(): void {
  sessionDialogQuery = elements.sessionSearch.value;
  sessionDialogSelection = 0;
  renderSessionList();
}

export async function loadSessionList(): Promise<void> {
  const response = await api<{ sessions: Summary[] }>("/api/sessions");
  summaries = response.sessions;
  sessionDialogSelection = Math.min(sessionDialogSelection, Math.max(0, filteredSessionSummaries().length - 1));
  renderSessionList();
}

export function openSessionDialog(returnsToLanding = false): void {
  sessionDialogReturnsToLanding = returnsToLanding;
  sessionDialogQuery = "";
  elements.sessionSearch.value = "";
  const currentIndex = filteredSessionSummaries().findIndex((summary) => summary.id === state.session?.id);
  sessionDialogSelection = currentIndex >= 0 ? currentIndex : 0;
  renderSessionList();
  elements.sessionDialog.hidden = false;
  document.body.classList.remove("sidebar-open");
  elements.sessionList.focus();
  elements.sessionList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

export function closeSessionDialog(): void {
  elements.sessionDialog.hidden = true;
  if (sessionDialogReturnsToLanding) {
    sessionDialogReturnsToLanding = false;
    elements.landingDialog.hidden = false;
    return elements.landingSelectSession.focus();
  }
  elements.prompt.focus();
}

export async function selectArchivedSession(summary: Summary): Promise<void> {
  if (summary.id === state.session?.id) return closeSessionDialog();
  if (state.session !== null) {
    // From a session context the archive selection opens in its own tab so the
    // current session (and any in-flight run) keeps this tab untouched.
    const tab = window.open(`/s/${summary.id}`, "_blank");
    if (!tab) return notify("Allow pop-ups to open sessions in a tab");
    sessionDialogReturnsToLanding = false;
    closeSessionDialog();
    return;
  }
  history.pushState({}, "", `/s/${summary.id}`);
  try {
    await host?.loadSession(summary.id);
    sessionDialogReturnsToLanding = false;
    elements.landingDialog.hidden = true;
    closeSessionDialog();
  } catch (error) {
    notify(messageFrom(error));
  }
}

export function handleSessionDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.sessionDialog.hidden) return false;
  const filtered = filteredSessionSummaries();
  if (event.key === "Escape") {
    event.preventDefault();
    closeSessionDialog();
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    sessionDialogSelection = Math.max(0, Math.min(filtered.length - 1, sessionDialogSelection + direction));
    renderSessionList();
    elements.sessionList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter"
    && document.activeElement !== elements.sessionDialogClose
    && !document.activeElement?.classList.contains("session-delete")) {
    const summary = filtered[sessionDialogSelection];
    if (summary) {
      event.preventDefault();
      void selectArchivedSession(summary);
    }
  } else if (document.activeElement !== elements.sessionSearch
    && !event.ctrlKey && !event.metaKey && !event.altKey
    && /^[\p{L}\p{N}]$/u.test(event.key)) {
    event.preventDefault();
    elements.sessionSearch.focus();
    elements.sessionSearch.value += event.key;
    sessionDialogQuery = elements.sessionSearch.value;
    sessionDialogSelection = 0;
    renderSessionList();
  } else if (document.activeElement !== elements.sessionSearch && event.key === "Backspace" && sessionDialogQuery) {
    event.preventDefault();
    elements.sessionSearch.focus();
    elements.sessionSearch.value = sessionDialogQuery.slice(0, -1);
    sessionDialogQuery = elements.sessionSearch.value;
    sessionDialogSelection = 0;
    renderSessionList();
  }
  return true;
}

export function renderSessionList(): void {
  elements.sessionList.replaceChildren();
  const filtered = filteredSessionSummaries();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-archive-empty";
    empty.textContent = sessionDialogQuery.trim() ? "No matching sessions" : "No archived sessions";
    elements.sessionList.append(empty);
    return;
  }
  filtered.forEach((summary, index) => {
    const item = document.createElement("div");
    item.className = "session-item";
    item.classList.toggle("active", summary.id === state.session?.id);
    item.classList.toggle("selected", index === sessionDialogSelection);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-item-open";
    openButton.setAttribute("aria-label", `Open session ${summary.title}`);
    openButton.innerHTML = `<span class="session-item-title"></span><span class="session-item-meta"><span></span><span></span></span>`;
    requiredWithin(openButton, ".session-item-title").textContent = summary.title;
    const meta = openButton.querySelectorAll(".session-item-meta span");
    if (meta[0]) meta[0].textContent = `${summary.messageCount} msg`;
    if (meta[1]) meta[1].textContent = relativeTime(summary.updatedAt);
    openButton.addEventListener("mouseenter", () => {
      if (sessionDialogSelection === index) return;
      sessionDialogSelection = index;
      renderSessionList();
    });
    item.addEventListener("focusin", () => {
      if (sessionDialogSelection === index) return;
      elements.sessionList.querySelector(".session-item.selected")?.classList.remove("selected");
      sessionDialogSelection = index;
      item.classList.add("selected");
    });
    openButton.addEventListener("click", () => void selectArchivedSession(summary));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.textContent = "DEL";
    deleteButton.setAttribute("aria-label", `Delete session ${summary.title}`);
    deleteButton.addEventListener("click", () => void deleteSession(summary));
    item.append(openButton, deleteButton);
    elements.sessionList.append(item);
  });
}

export function filteredSessionSummaries(): Summary[] {
  const query = sessionDialogQuery.trim().toLocaleLowerCase();
  if (!query) return summaries;
  return summaries.filter((summary) => [summary.title, summary.id, summary.preview, String(summary.messageCount)]
    .some((value) => value.toLocaleLowerCase().includes(query)));
}

export async function deleteSession(summary: Summary): Promise<void> {
  if (state.streaming) return notify("Wait for the current response to finish");
  if (!window.confirm(`Delete session “${summary.title}”? This cannot be undone.`)) return;
  const deletingCurrentSession = summary.id === state.session?.id;
  try {
    await api<{ deletedSessionId: string }>(`/api/sessions/${summary.id}`, { method: "DELETE" });
    await loadSessionList();
    if (deletingCurrentSession) {
      const nextSession = summaries[0];
      if (nextSession) {
        history.replaceState({}, "", `/s/${nextSession.id}`);
        await host?.loadSession(nextSession.id);
      } else {
        state.session = null;
        history.replaceState({}, "", "/");
        closeSessionDialog();
        host?.openLandingDialog();
      }
    }
    notify(`Session deleted · ${summary.title}`);
  } catch (error) {
    notify(messageFrom(error));
  }
}
