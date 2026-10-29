import type { Message, Session, ToolCall } from "../types.js";
import { Terminal } from "./term.js";
import { renderMarkdown, clipWidth, displayWidth, joinRuns, type Run } from "./render.js";
import { createBlockSplitter, type BlockSplitter } from "./blocks.js";
import { toolLine, toolStatusRuns } from "./tools.js";
import { diffLines, isDiffCall } from "./diff.js";
import { meterRuns } from "./usage.js";

export type PlanDecision = { approved: true } | { approved: false } | { newSession: true };

export interface DisplayOptions {
  /** Print thinking text as it streams instead of only counting it in the status line. */
  streamThinking?: boolean;
  /** Print the unified diff each Edit/Write already returns, colored red/green. */
  full?: boolean;
}

export interface DisplayHooks {
  ask(prompt: string): Promise<string>;
  answerQuestions(sessionId: string, toolUseId: string, answers: Record<string, string> | { cancelled: true }): Promise<void>;
  planDecision(sessionId: string, toolUseId: string, decision: PlanDecision): Promise<void>;
  onActiveChange(active: boolean): void;
}

interface GateQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

const SKIPPED_KINDS = new Set(["tool-result", "skill", "skill-catalog", "agent-notification"]);

/** Trailing fill for shaded lines: the text plus a margin, capped at the width. */
const FILL_MARGIN = 3;

function fillWidth(contentWidth: number, columns: number): number {
  return Math.min(columns, contentWidth + FILL_MARGIN);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

export class SessionDisplay {
  active = false;
  gatePending = false;
  private printedBlocks = new Map<string, number>();
  private printedUserIds = new Set<string>();
  private printedToolIds = new Set<string>();
  private printedOrder: string[] = [];
  private splitter: BlockSplitter | null = null;
  private streamingMessageId: string | null = null;
  private streamingChars = 0;
  private thinkingChars = 0;
  private thinkingBuffer = "";
  private thinkingHeaderPrinted = false;
  private lastCompletedTool: ToolCall | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly sessionId: string,
    private readonly hooks: DisplayHooks,
    private readonly options: DisplayOptions = {},
  ) {}

  attach(messages: Message[], limit: number): void {
    const rendered = messages.filter((message) => !SKIPPED_KINDS.has(message.kind ?? ""));
    for (const message of limit > 0 ? rendered.slice(-limit) : []) this.printFromHistory(message);
  }

  latestToolOutput(): string | null {
    return this.lastCompletedTool?.output ?? null;
  }

  oldestPrintedId(): string | undefined {
    return this.printedOrder[0];
  }

  async applyEvent(event: string, data: unknown): Promise<void> {
    const payload = data as Record<string, any>;
    switch (event) {
      case "snapshot":
        this.setActive(payload.session?.active === true);
        for (const message of payload.session?.messages ?? []) {
          if (SKIPPED_KINDS.has(message.kind ?? "")) continue;
          this.printFromHistory(message);
        }
        break;
      case "start":
        // A standalone /compact broadcasts done without a message; streams
        // other than a run's own may legitimately omit these payloads.
        if (payload.assistantMessage) this.beginStream(payload.assistantMessage.id);
        // The terminal already echoed this input; only mark it seen so a
        // later snapshot does not reprint it.
        if (payload.userMessage) {
          this.printedUserIds.add(payload.userMessage.id);
          this.markPrinted(payload.userMessage.id);
        }
        break;
      case "continuation":
        if (payload.assistantMessage) this.beginStream(payload.assistantMessage.id);
        break;
      case "delta": {
        this.finishThinking();
        const text = String(payload.text ?? "");
        this.ensureSplitter();
        for (const block of this.splitter!.push(text)) this.printStreamBlock(block);
        this.streamingChars += text.length;
        this.paintStatus();
        break;
      }
      case "thinking_delta": {
        const text = String(payload.thinking ?? "");
        this.thinkingChars += text.length;
        if (this.options.streamThinking) this.printThinking(text);
        this.paintStatus();
        break;
      }
      case "tool_update":
        this.applyToolUpdate(payload.toolCall as ToolCall);
        break;
      case "tool_output":
        break; // live tool output is never printed
      case "user_message":
        this.finishThinking();
        this.printUser(payload.message as Message);
        break;
      case "assistant_complete":
      case "done": {
        this.finishThinking();
        const message = payload.message as Message | undefined;
        if (message) this.finishStream(message);
        if (event === "done") {
          // Standalone /compact closes observers with a message-less done; the
          // display must still leave the inactive state or the prompt hangs.
          if (message) this.printUsage(message, payload.session as Session | undefined);
          this.setActive(false);
        }
        break;
      }
      case "error":
        this.finishThinking();
        this.splitter = null;
        this.term.line(this.term.style(`✗ error: ${truncate(String(payload.error ?? ""), 160)}`, this.term.theme.error));
        this.term.flush();
        this.setActive(false);
        break;
      case "session_named":
        this.term.line(this.term.style(`· named: ${truncate(String(payload.title ?? ""), 60)}`, this.term.theme.meta));
        break;
      case "plan_mode_state":
        this.term.line(this.term.style(`· plan mode ${payload.planMode?.active ? "on" : "off"}`, this.term.theme.meta));
        break;
      case "plan_mode_request":
        await this.handlePlanModeRequest(payload);
        break;
      case "ask_user_question":
        await this.handleQuestions(payload);
        break;
      case "compaction_start":
        this.setActive(true);
        this.term.status(this.term.runs([this.busyPill("compacting…")]));
        break;
      case "compaction_progress":
        this.term.status(this.term.runs([
          this.busyPill("compacting…"),
          { text: ` ${payload.generatedCharacters ?? 0} chars`, codes: this.term.theme.accent },
        ]));
        break;
      case "compaction_complete":
        this.term.line(this.term.style("· compacted", this.term.theme.meta));
        this.setActive(false);
        break;
      case "compaction_error":
        this.term.line(this.term.style(`✗ compaction failed: ${truncate(String(payload.error ?? ""), 120)}`, this.term.theme.error));
        this.setActive(false);
        break;
      default:
        break;
    }
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.term.status(null);
    this.hooks.onActiveChange(active);
  }

  private beginStream(messageId: string): void {
    this.streamingMessageId = messageId;
    this.splitter = null;
    this.streamingChars = 0;
    this.thinkingChars = 0;
    this.thinkingBuffer = "";
    this.thinkingHeaderPrinted = false;
    if (!this.printedBlocks.has(messageId)) this.printedBlocks.set(messageId, 0);
    this.setActive(true);
  }

  private ensureSplitter(): void {
    if (this.splitter === null) {
      this.splitter = createBlockSplitter();
      this.streamingChars = 0;
    }
  }

  private printStreamBlock(block: string): void {
    const rendered = renderMarkdown(block, {
      width: this.term.columns,
      color: this.term.color,
      theme: this.term.theme,
    });
    this.term.line("");
    if (rendered !== "") this.term.line(rendered);
    const id = this.streamingMessageId ?? "stream";
    this.printedBlocks.set(id, (this.printedBlocks.get(id) ?? 0) + 1);
  }

  private finishStream(message: Message): void {
    if (this.splitter !== null && message.id === this.streamingMessageId) {
      const remainder = this.splitter.finish();
      if (remainder !== "") this.printStreamBlock(remainder);
    }
    this.splitter = null;
    if (!this.printedBlocks.has(message.id)) this.printedBlocks.set(message.id, blocksOf(message.content));
    if (!this.printedOrder.includes(message.id)) this.printedOrder.push(message.id);
  }

  /** Prints complete thinking lines as they arrive; the partial tail waits for more. */
  private printThinking(text: string): void {
    this.thinkingBuffer += text;
    const lines = this.thinkingBuffer.split("\n");
    this.thinkingBuffer = lines.pop() ?? "";
    for (const line of lines) this.printThinkingLine(line);
  }

  private printThinkingLine(line: string): void {
    if (!this.thinkingHeaderPrinted) {
      this.term.line("");
      this.term.line(this.shade("· thinking", this.term.theme.thinkingHeader));
      this.thinkingHeaderPrinted = true;
    }
    this.term.line(this.shade(line));
  }

  /** One styled line whose background fill hugs the text plus a small
   * margin, reaching the full width only when the text does; a single
   * escape pair per line keeps the overhead tiny. */
  private shade(text: string, codes: string = this.term.theme.thinking): string {
    if (!this.term.color) return text;
    const clipped = clipWidth(text, this.term.columns - 1);
    const cells = displayWidth(clipped);
    return this.term.style(clipped + " ".repeat(fillWidth(cells, this.term.columns) - cells), codes);
  }

  private finishThinking(): void {
    if (!this.thinkingHeaderPrinted) return;
    const remainder = this.thinkingBuffer;
    this.thinkingBuffer = "";
    this.thinkingHeaderPrinted = false;
    if (remainder !== "") this.term.line(this.shade(remainder));
  }

  private printUsage(message: Message, session?: Session): void {
    if (!session) return;
    const theme = this.term.theme;
    const runs = meterRuns(session, theme, message, theme.meterFill);
    this.term.line("");
    if (this.term.color) {
      const pad = fillWidth(displayWidth(joinRuns(runs, false)), this.term.columns)
        - displayWidth(joinRuns(runs, false));
      if (pad > 0) runs.push({ text: " ".repeat(pad), codes: `${theme.meterValue};${theme.meterFill}` });
    }
    this.term.line(this.term.runs(runs));
  }

  private applyToolUpdate(call: ToolCall): void {
    if (call.status === "running" || call.status === "queued") {
      if (call.status === "running") this.paintStatus(call);
      return;
    }
    if (this.printedToolIds.has(call.id)) return;
    this.finishThinking();
    this.printedToolIds.add(call.id);
    this.lastCompletedTool = call;
    this.term.line(this.term.runs(toolLine(call, this.term.theme)));
    if (this.options.full && isDiffCall(call)) {
      for (const line of diffLines(call.output, this.term.columns, this.term.theme)) {
        this.term.line(line.codes === "" ? line.text : this.term.style(line.text, line.codes));
      }
    }
  }

  private paintStatus(runningTool?: ToolCall): void {
    if (!this.active) return;
    const theme = this.term.theme;
    const segments: Run[][] = [];
    // With --thinking the text itself streams; the char counter is redundant.
    if (!this.options.streamThinking && this.thinkingChars > 0) {
      segments.push([this.busyPill("thinking"), { text: `${this.countGap()}${this.thinkingChars}`, codes: theme.accent }]);
    }
    if (this.streamingChars > 0) {
      segments.push([this.busyPill("streaming"), { text: `${this.countGap()}${this.streamingChars}`, codes: theme.accent }]);
    }
    if (runningTool) segments.push([...toolStatusRuns(runningTool, theme), { text: " …", codes: theme.meta }]);
    const runs: Run[] = segments.length === 0
      ? [this.busyPill("working…")]
      : segments.reduce<Run[]>((joined, segment) =>
        joined.length === 0 ? segment : [...joined, { text: " · ", codes: theme.meta }, ...segment], []);
    this.term.status(this.term.runs(runs));
  }

  /** Filled busy-state pill; padded to a block only when color is on. */
  private busyPill(label: string): Run {
    return { text: this.term.color ? ` ${label} ` : label, codes: this.term.theme.statusActive };
  }

  /** The counter sits inside the pill's trailing pad, so gap only without color. */
  private countGap(): string {
    return this.term.color ? "" : " ";
  }

  private printUser(message: Message): void {
    if (this.printedUserIds.has(message.id)) return;
    this.printedUserIds.add(message.id);
    this.markPrinted(message.id);
    this.term.line("");
    this.term.line(this.term.runs([
      { text: "> ", codes: this.term.theme.prompt },
      { text: truncate(message.content, this.term.columns - 4), codes: this.term.theme.meta },
    ]));
  }

  /** History/snapshot path: prints blocks of `message` beyond what was printed. */
  private printFromHistory(message: Message): void {
    if (message.role === "user") {
      this.printUser(message);
      return;
    }
    if (message.kind !== undefined && message.kind !== "chat") {
      if (!this.printedBlocks.has(message.id)) {
        this.markPrinted(message.id);
        this.printedBlocks.set(message.id, blocksOf(message.content));
        this.term.line("");
        this.term.line(this.term.style(`· ${truncate(firstLine(message.content), this.term.columns - 4)}`, this.term.theme.meta));
      }
      return;
    }
    const seen = this.printedBlocks.get(message.id) ?? 0;
    const blocks = closedBlocksOf(message.content);
    for (let index = seen; index < blocks.length; index += 1) {
      this.term.line("");
      const rendered = renderMarkdown(blocks[index]!, {
        width: this.term.columns,
        color: this.term.color,
        theme: this.term.theme,
      });
      if (rendered !== "") this.term.line(rendered);
    }
    if (!this.printedOrder.includes(message.id)) this.markPrinted(message.id);
    this.printedBlocks.set(message.id, blocks.length);
  }

  private markPrinted(id: string): void {
    if (!this.printedOrder.includes(id)) this.printedOrder.push(id);
  }

  private async handleQuestions(payload: Record<string, any>): Promise<void> {
    this.term.flush();
    this.gatePending = true;
    try {
      const answers: Record<string, string> = {};
      for (const question of (payload.questions ?? []) as GateQuestion[]) {
        this.term.line("");
        this.term.line(question.header
          ? this.term.runs([
            { text: question.header, codes: this.term.theme.prompt },
            { text: `: ${question.question}` },
          ])
          : question.question);
        question.options.forEach((option, index) => {
          const description = option.description
            ? [{ text: ` — ${truncate(option.description, 60)}`, codes: this.term.theme.meta }]
            : [];
          this.term.line(this.term.runs([
            { text: "  " },
            { text: `${index + 1}) `, codes: this.term.theme.accent },
            { text: option.label },
            ...description,
          ]));
        });
        if (question.multiSelect) this.term.line(this.term.style("  (comma-separated numbers)", this.term.theme.meta));
        const input = await this.hooks.ask("answer: ");
        answers[question.question] = this.parseAnswer(input, question);
      }
      const declined = Object.values(answers).every((answer) => answer === "");
      await this.hooks.answerQuestions(
        this.sessionId,
        String(payload.toolUseId),
        declined ? { cancelled: true } : answers,
      );
    } finally {
      this.gatePending = false;
      this.term.flush();
    }
  }

  private parseAnswer(input: string, question: GateQuestion): string {
    const trimmed = input.trim();
    if (trimmed === "") return "";
    const labels = trimmed
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((pick) => (/^\d+$/.test(pick) ? question.options[Number(pick) - 1]?.label : undefined))
      .filter((label): label is string => label !== undefined);
    return labels.length === 0 ? trimmed : labels.join(", ");
  }

  private async handlePlanModeRequest(payload: Record<string, any>): Promise<void> {
    this.term.flush();
    this.gatePending = true;
    try {
      let decision: PlanDecision;
      if (payload.kind === "enter") {
        const answer = (await this.hooks.ask("enter plan mode? [y/N] ")).trim().toLowerCase();
        decision = answer === "y" || answer === "yes" ? { approved: true } : { approved: false };
      } else {
        this.term.line("");
        const plan = renderMarkdown(String(payload.plan ?? ""), {
          width: this.term.columns,
          color: this.term.color,
          theme: this.term.theme,
        });
        if (plan !== "") this.term.line(plan);
        const answer = (await this.hooks.ask("approve plan? [y]es / [n]o / [s]eparate session ")).trim().toLowerCase();
        decision = answer.startsWith("s") ? { newSession: true } : answer.startsWith("y") ? { approved: true } : { approved: false };
      }
      await this.hooks.planDecision(this.sessionId, String(payload.toolUseId), decision);
    } finally {
      this.gatePending = false;
      this.term.flush();
    }
  }
}

/** Closed blocks plus the remainder — the deterministic split live streaming uses. */
function closedBlocksOf(content: string): string[] {
  const splitter = createBlockSplitter();
  const blocks = splitter.push(content);
  const remainder = splitter.finish();
  return remainder === "" ? blocks : [...blocks, remainder];
}

function blocksOf(content: string): number {
  return closedBlocksOf(content).length;
}
