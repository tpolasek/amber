(() => {
  "use strict";

  const INSTALL_COMMAND = "curl -fsSL amberagent.dev/install.sh | sh";
  const STEP_DELAY = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 80 : 720;
  const state = {
    running: false,
    waitingForQuestion: false,
    completed: false,
    selectedAnswer: "",
    timers: [],
    lastFocused: null,
  };

  const elements = {
    transcript: document.querySelector("#demo-transcript"),
    placeholder: document.querySelector("#demo-placeholder"),
    runButton: document.querySelector("#run-demo"),
    runLabel: document.querySelector("#run-label"),
    openQuestion: document.querySelector("#open-question"),
    demoStep: document.querySelector("#demo-step"),
    demoCaption: document.querySelector("#demo-caption"),
    progress: document.querySelector("#demo-progress-bar"),
    planBanner: document.querySelector("#plan-banner"),
    modePlan: document.querySelector("#mode-plan"),
    modeNormal: document.querySelector("#mode-normal"),
    tasks: [...document.querySelectorAll(".demo-task")],
    overlay: document.querySelector("#question-overlay"),
    dialog: document.querySelector(".question-dialog"),
    closeQuestion: document.querySelector("#question-close"),
    submitQuestion: document.querySelector("#question-submit"),
    questionOptions: [...document.querySelectorAll("button.question-option")],
    otherOption: document.querySelector("[data-other]"),
    otherInput: document.querySelector("#other-answer"),
    preview: document.querySelector("#preview-body"),
    previewCaption: document.querySelector("#preview-caption"),
    copyLabel: document.querySelector("#copy-label"),
    copyStatus: document.querySelector("#copy-status"),
  };

  const initialTranscript = elements.transcript.innerHTML;

  document.querySelectorAll("[data-run-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#demo").scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(runDemo, STEP_DELAY === 80 ? 0 : 350);
    });
  });

  elements.runButton.addEventListener("click", runDemo);
  elements.openQuestion.addEventListener("click", () => openQuestionDialog(elements.openQuestion));
  elements.closeQuestion.addEventListener("click", declineQuestion);
  elements.submitQuestion.addEventListener("click", submitQuestion);
  elements.overlay.addEventListener("mousedown", (event) => {
    if (event.target === elements.overlay) declineQuestion();
  });

  elements.questionOptions.forEach((option, index) => {
    option.addEventListener("click", () => selectOption(option));
    option.addEventListener("focus", () => previewOption(option.dataset.answer || ""));
    option.addEventListener("keydown", (event) => handleOptionKeydown(event, index));
  });

  elements.otherOption.addEventListener("click", (event) => {
    if (event.target !== elements.otherInput) elements.otherInput.focus();
    selectOther();
  });
  elements.otherInput.addEventListener("focus", selectOther);
  elements.otherInput.addEventListener("input", () => {
    state.selectedAnswer = elements.otherInput.value.trim();
    elements.submitQuestion.disabled = !state.selectedAnswer;
    previewOption("Other");
  });
  elements.otherInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.selectedAnswer) {
      event.preventDefault();
      submitQuestion();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (elements.overlay.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      declineQuestion();
      return;
    }
    if (event.key === "Tab") trapDialogFocus(event);
  });

  document.querySelector("#copy-install").addEventListener("click", (event) => copyInstall(event.currentTarget));
  document.querySelectorAll("[data-copy-install]").forEach((button) => {
    button.addEventListener("click", () => copyInstall(button));
  });

  async function copyInstall(button) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      copied = true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = INSTALL_COMMAND;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      textarea.remove();
    }
    const label = button.querySelector("#copy-label") || button;
    const original = label.textContent;
    label.textContent = copied ? "COPIED" : "SELECT COMMAND";
    elements.copyStatus.textContent = copied ? "Install command copied to clipboard." : "Could not copy the install command.";
    window.setTimeout(() => { label.textContent = original; }, 1700);
  }

  function runDemo() {
    resetDemo();
    state.running = true;
    elements.runLabel.textContent = "RUNNING";
    updateDemoStatus("PLANNING", "Inspecting the current session UI", 12);
    removePlaceholder();

    schedule(() => {
      appendMessage("assistant", "I’ll inspect the session UI and ask a focused placement question before changing anything.");
      updateDemoStatus("DELEGATING", "A sub-agent is tracing the existing patterns", 25);
    }, STEP_DELAY);

    schedule(() => {
      appendToolCard({
        name: "Agent",
        subject: "Audit session UI patterns",
        status: "RUNNING…",
        running: true,
        meta: "general-purpose · read-only",
      });
    }, STEP_DELAY * 2);

    schedule(() => {
      const card = elements.transcript.querySelector("[data-demo-tool='agent']");
      if (card) {
        const status = card.querySelector(".tool-status");
        status.textContent = "AGENT COMPLETE · 8.4s";
        status.classList.remove("running");
        const link = document.createElement("a");
        link.className = "agent-link";
        link.href = "#demo";
        link.textContent = "↗ OPEN SUB-SESSION · warm-maple-thread";
        link.addEventListener("click", (event) => event.preventDefault());
        card.insertBefore(link, card.querySelector(".tool-meta"));
      }
      completeTask(0);
      activateTask(1);
      updateDemoStatus("DECISION NEEDED", "Amber needs one detail to complete the plan", 42);
    }, STEP_DELAY * 3.2);

    schedule(() => {
      appendToolCard({
        name: "AskUserQuestion",
        subject: "Where should the session status panel live?",
        status: "WAITING FOR ANSWER",
        running: true,
      });
      state.waitingForQuestion = true;
      openQuestionDialog(elements.runButton);
    }, STEP_DELAY * 4.1);
  }

  function continueDemo(answer) {
    state.waitingForQuestion = false;
    const questionCard = elements.transcript.querySelector("[data-demo-tool='question']");
    if (questionCard) {
      const status = questionCard.querySelector(".tool-status");
      status.textContent = "ANSWERED";
      status.classList.remove("running");
      const meta = document.createElement("div");
      meta.className = "tool-meta";
      meta.textContent = `Selection · ${answer}`;
      questionCard.append(meta);
    }
    completeTask(1);
    activateTask(2);
    updateDemoStatus("PLAN APPROVED", "Moving into implementation", 58);

    schedule(() => {
      appendMarkdownPlan();
      appendSystemNote("PLAN APPROVED · IMPLEMENTATION CONTINUING IN NORMAL MODE");
      elements.modePlan.classList.remove("active");
      elements.modeNormal.classList.add("active");
      elements.planBanner.hidden = true;
      updateDemoStatus("IMPLEMENTING", "Editing the session status component", 72);
    }, STEP_DELAY * .75);

    schedule(() => {
      appendEditDiff();
      updateDemoStatus("VERIFYING", "Reviewing the rendered result", 88);
    }, STEP_DELAY * 1.75);

    schedule(() => {
      completeTask(2);
      appendCompletion();
      state.running = false;
      state.completed = true;
      elements.runLabel.textContent = "REPLAY";
      updateDemoStatus("COMPLETE", "Agent call, plan, edit, and Markdown rendered", 100);
    }, STEP_DELAY * 2.75);
  }

  function resetDemo() {
    state.timers.forEach(window.clearTimeout);
    state.timers = [];
    if (!elements.overlay.hidden) closeQuestionDialog();
    state.running = false;
    state.waitingForQuestion = false;
    state.completed = false;
    state.selectedAnswer = "";
    elements.transcript.innerHTML = initialTranscript;
    elements.placeholder = document.querySelector("#demo-placeholder");
    elements.planBanner.hidden = false;
    elements.modePlan.classList.add("active");
    elements.modeNormal.classList.remove("active");
    elements.tasks.forEach((task, index) => {
      task.classList.toggle("active", index === 0);
      task.classList.remove("done");
      task.querySelector("small").textContent = index === 0 ? "IN PROGRESS" : "PENDING";
    });
    elements.runLabel.textContent = "RUN DEMO";
    updateDemoStatus("READY", "Planning → question → edit → result", 0);
    resetQuestionSelection();
  }

  function schedule(callback, delay) {
    const timer = window.setTimeout(() => {
      state.timers = state.timers.filter((candidate) => candidate !== timer);
      callback();
    }, delay);
    state.timers.push(timer);
  }

  function removePlaceholder() {
    elements.placeholder?.remove();
    elements.placeholder = null;
  }

  function appendMessage(role, content) {
    const article = document.createElement("article");
    article.className = `message ${role === "user" ? "user-message" : "assistant-message"} fade-in`;
    const rail = document.createElement("div");
    rail.className = "message-rail";
    rail.textContent = role === "user" ? "❯" : "◆";
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = content;
    article.append(rail, body);
    elements.transcript.append(article);
    scrollTranscript();
    return body;
  }

  function appendToolCard({ name, subject, status, running = false, meta = "" }) {
    const body = appendMessage("assistant", "");
    const card = document.createElement("section");
    card.className = "tool-card";
    card.dataset.demoTool = name === "Agent" ? "agent" : "question";
    const header = document.createElement("div");
    header.className = "tool-header";
    const title = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `${name}:`;
    const code = document.createElement("code");
    code.textContent = subject;
    title.append(strong, code);
    const statusLabel = document.createElement("span");
    statusLabel.className = `tool-status${running ? " running" : ""}`;
    statusLabel.textContent = status;
    header.append(title, statusLabel);
    card.append(header);
    if (meta) {
      const metadata = document.createElement("div");
      metadata.className = "tool-meta";
      metadata.textContent = meta;
      card.append(metadata);
    }
    body.append(card);
    scrollTranscript();
  }

  function appendMarkdownPlan() {
    const body = appendMessage("assistant", "");
    const heading = document.createElement("h3");
    heading.textContent = "Implementation plan";
    const intro = document.createElement("p");
    intro.innerHTML = "Use the existing <code>sidebar-footer</code> region and preserve Amber’s compact terminal hierarchy.";
    const list = document.createElement("ul");
    ["Add session and context status markup", "Reuse the green connected-state treatment", "Keep the panel responsive below 760px"].forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    });
    body.append(heading, intro, list);
  }

  function appendSystemNote(text) {
    const note = document.createElement("div");
    note.className = "system-note fade-in";
    note.textContent = text;
    elements.transcript.append(note);
    scrollTranscript();
  }

  function appendEditDiff() {
    const body = appendMessage("assistant", "");
    const card = document.createElement("section");
    card.className = "tool-card";
    card.innerHTML = `
      <div class="tool-header">
        <span><strong>Edit:</strong><code>src/client.ts</code></span>
        <span class="tool-status">COMPLETE</span>
      </div>
      <div class="diff-summary">Diff · +5 −1 · 10 lines</div>
      <pre class="tool-diff" aria-label="Example Edit diff"><span class="diff-header">--- a/src/client.ts</span><span class="diff-header">+++ b/src/client.ts</span><span class="diff-hunk">@@ -2068,7 +2068,11 @@ function renderSessionStatus</span><span class="diff-context">   const meter = document.createElement("div");</span><span class="diff-deletion">-  meter.textContent = contextLabel;</span><span class="diff-addition">+  meter.className = "session-status";</span><span class="diff-addition">+  meter.append(</span><span class="diff-addition">+    statusDot("CONNECTED"),</span><span class="diff-addition">+    contextMeter(contextLabel),</span><span class="diff-addition">+  );</span><span class="diff-context">   footer.append(meter);</span></pre>
    `;
    body.append(card);
    scrollTranscript();
  }

  function appendCompletion() {
    const body = appendMessage("assistant", "");
    const heading = document.createElement("h3");
    heading.textContent = "Implemented";
    const paragraph = document.createElement("p");
    paragraph.innerHTML = "Added the compact session panel to the <strong>sidebar footer</strong> and kept the existing <code>CTX</code> behavior intact.";
    const list = document.createElement("ul");
    ["Connected state stays visible", "Context usage remains scannable", "Narrow layouts retain the same hierarchy"].forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    });
    body.append(heading, paragraph, list);
  }

  function updateDemoStatus(step, caption, percentage) {
    elements.demoStep.textContent = step;
    elements.demoCaption.textContent = caption;
    elements.progress.style.width = `${percentage}%`;
  }

  function completeTask(index) {
    const task = elements.tasks[index];
    if (!task) return;
    task.classList.remove("active");
    task.classList.add("done");
    task.querySelector("small").textContent = "COMPLETED";
  }

  function activateTask(index) {
    const task = elements.tasks[index];
    if (!task) return;
    task.classList.add("active");
    task.querySelector("small").textContent = "IN PROGRESS";
  }

  function scrollTranscript() {
    window.requestAnimationFrame(() => {
      elements.transcript.scrollTo({ top: elements.transcript.scrollHeight, behavior: STEP_DELAY === 80 ? "auto" : "smooth" });
    });
  }

  function openQuestionDialog(trigger) {
    state.lastFocused = trigger || document.activeElement;
    resetQuestionSelection();
    elements.overlay.hidden = false;
    document.body.classList.add("modal-open");
    window.requestAnimationFrame(() => elements.questionOptions[0].focus());
  }

  function closeQuestionDialog() {
    elements.overlay.hidden = true;
    document.body.classList.remove("modal-open");
    state.lastFocused?.focus?.();
    state.lastFocused = null;
  }

  function declineQuestion() {
    closeQuestionDialog();
    if (state.waitingForQuestion) {
      state.timers.forEach(window.clearTimeout);
      state.timers = [];
      state.running = false;
      elements.runLabel.textContent = "REPLAY";
      updateDemoStatus("PAUSED", "Question dismissed · replay or reopen it", 42);
    }
  }

  function submitQuestion() {
    if (!state.selectedAnswer) return;
    const answer = state.selectedAnswer;
    closeQuestionDialog();
    if (state.waitingForQuestion) continueDemo(answer);
  }

  function selectOption(option) {
    state.selectedAnswer = option.dataset.answer || "";
    elements.otherInput.value = "";
    elements.questionOptions.forEach((candidate) => setSelected(candidate, candidate === option));
    setSelected(elements.otherOption, false);
    elements.submitQuestion.disabled = false;
    previewOption(state.selectedAnswer);
  }

  function selectOther() {
    state.selectedAnswer = elements.otherInput.value.trim();
    elements.questionOptions.forEach((candidate) => setSelected(candidate, false));
    setSelected(elements.otherOption, true);
    elements.submitQuestion.disabled = !state.selectedAnswer;
    previewOption("Other");
  }

  function setSelected(option, selected) {
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
    option.querySelector(".option-marker").textContent = selected ? "●" : "○";
  }

  function resetQuestionSelection() {
    state.selectedAnswer = "";
    elements.questionOptions.forEach((option) => setSelected(option, false));
    setSelected(elements.otherOption, false);
    elements.otherInput.value = "";
    elements.submitQuestion.disabled = true;
    previewOption("");
  }

  function previewOption(answer) {
    elements.preview.classList.remove("topbar", "both", "custom");
    if (answer === "Top bar") elements.preview.classList.add("topbar");
    if (answer === "Both surfaces") elements.preview.classList.add("both");
    if (answer === "Other") elements.preview.classList.add("custom");
    const captions = {
      "Sidebar footer": "A compact status row anchored beneath the session task list.",
      "Top bar": "Status moves beside the active session identity.",
      "Both surfaces": "A primary top-bar state with context repeated in the sidebar.",
      "Other": "Amber will use the custom placement described in your answer.",
    };
    elements.previewCaption.textContent = captions[answer] || "Focus an option to preview its placement.";
  }

  function handleOptionKeydown(event, index) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const options = [...elements.questionOptions, elements.otherInput];
      const direction = event.key === "ArrowDown" ? 1 : -1;
      options[(index + direction + options.length) % options.length].focus();
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      selectOption(elements.questionOptions[index]);
    }
  }

  function trapDialogFocus(event) {
    const focusable = [...elements.dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
})();
