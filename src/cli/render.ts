// src/cli/render.ts
import MarkdownIt from "markdown-it";

export interface RenderOptions { width: number; color: boolean; }

export const BOLD = "1";
export const DIM = "2";
export const ITALIC = "3";
export const CYAN = "36";
export const RED = "31";

type Run = { text: string; codes?: string };
type Line = Run[];
type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (isZeroWidth(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isZeroWidth(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0xfe00 && code <= 0xfe0f);
}

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

function joinCodes(left: string, right: string): string {
  return [left, right].filter((part) => part !== "").join(";");
}

/** Greedy word wrap over styled runs; long words hard-split at the width. */
function wrapRuns(runs: Run[], width: number): Line[] {
  if (width < 1) return [runs];
  const lines: Line[] = [[]];
  let used = 0;
  const newLine = () => {
    const closing = lines[lines.length - 1]!;
    while (closing.length > 0 && /^\s+$/.test(closing[closing.length - 1]!.text)) closing.pop();
    const last = closing[closing.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    lines.push([]);
    used = 0;
  };
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/).filter((part) => part !== "")) {
      if (/^\s+$/.test(piece)) {
        const line = lines[lines.length - 1]!;
        if (line.length === 0 || used + 1 > width) continue;
        const last = line[line.length - 1]!;
        if (last.codes === run.codes) last.text += " ";
        else line.push({ text: " ", ...(run.codes ? { codes: run.codes } : {}) });
        used += 1;
      } else {
        let word = piece;
        while (word !== "" && used > 0 && displayWidth(word) > width - used) newLine();
        while (word !== "" && displayWidth(word) > width) {
          let take = 0;
          let takeWidth = 0;
          for (const character of word) {
            const characterWidth = displayWidth(character);
            if (takeWidth + characterWidth > width && take > 0) break;
            take += character.length;
            takeWidth += characterWidth;
          }
          lines[lines.length - 1]!.push({ text: word.slice(0, take), ...(run.codes ? { codes: run.codes } : {}) });
          word = word.slice(take);
          newLine();
        }
        if (word !== "") {
          lines[lines.length - 1]!.push({ text: word, ...(run.codes ? { codes: run.codes } : {}) });
          used += displayWidth(word);
        }
      }
    }
  }
  return lines;
}

/** Inline tokens to styled lines (hardbreaks split lines, softbreaks join). */
function renderInline(children: Token[] | null | undefined): Line[] {
  const lines: Line[] = [[]];
  const styles: string[] = [];
  const link = { href: "", text: "" };
  const current = () => styles.join(";");
  const push = (text: string, codes: string) => {
    if (!text) return;
    lines[lines.length - 1]!.push({ text, ...(codes ? { codes } : {}) });
    if (link.href !== "") link.text += text;
  };
  for (const token of children ?? []) {
    switch (token.type) {
      case "text": push(token.content, current()); break;
      case "code_inline": push(token.content, joinCodes(current(), CYAN)); break;
      case "softbreak": lines.push([]); break;
      case "hardbreak": lines.push([]); break;
      case "strong_open": styles.push(BOLD); break;
      case "strong_close": styles.pop(); break;
      case "em_open": styles.push(ITALIC); break;
      case "em_close": styles.pop(); break;
      case "s_open": case "s_close": break;
      case "link_open":
        link.href = String(token.attrGet("href") ?? "");
        link.text = "";
        break;
      case "link_close": {
        const href = link.href;
        link.href = "";
        if (href !== "" && href !== link.text) push(` (${href})`, DIM);
        break;
      }
      case "image": {
        const alt = (token.children ?? []).map((child) => child.content).join("");
        push(`[img: ${alt}]`, DIM);
        break;
      }
      default: break; // html_inline and anything exotic render as nothing
    }
  }
  return lines;
}

class BlockRenderer {
  private readonly lines: Line[] = [];
  private blankBefore = false;
  private readonly prefixes: Array<{ first: Run[]; rest: Run[] }> = [];
  private readonly listStack: Array<{ ordered: boolean; index: number }> = [];

  constructor(private readonly options: RenderOptions) {}

  private blank(): void {
    if (this.prefixes.length === 0) this.blankBefore = true;
  }

  private restPrefix(): Run[] {
    return this.prefixes.flatMap((prefix) => prefix.rest);
  }

  private widthFor(): number {
    return Math.max(1, this.options.width - displayWidth(this.restPrefix().map((run) => run.text).join("")));
  }

  private emit(wrapped: Line[]): void {
    if (this.blankBefore && this.lines.length > 0) this.lines.push([]);
    this.blankBefore = false;
    const first = [...this.prefixes.slice(0, -1).flatMap((p) => p.rest), ...(this.prefixes.at(-1)?.first ?? [])];
    const rest = this.restPrefix();
    if (wrapped.length === 0) wrapped = [[]];
    wrapped.forEach((line, index) => {
      this.lines.push([...(index === 0 ? first : rest), ...line]);
    });
  }

  private emitCode(body: string): void {
    if (this.blankBefore && this.lines.length > 0) this.lines.push([]);
    this.blankBefore = false;
    const prefix = [...this.restPrefix(), { text: "  ", codes: DIM }];
    for (const codeLine of body.replace(/\n$/, "").split("\n")) {
      this.lines.push([...prefix, { text: codeLine }]);
    }
  }

  private renderTable(tokens: Token[], start: number): number {
    const rows: Array<{ header: boolean; cells: Line[]; align: string[] }> = [];
    let header = false;
    let close = start;
    for (let i = start + 1; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.type === "table_close") { close = i; break; }
      if (token.type === "thead_open") header = true;
      else if (token.type === "thead_close") header = false;
      else if (token.type === "tr_open") rows.push({ header, cells: [], align: [] });
      else if (token.type === "th_open" || token.type === "td_open") {
        const row = rows[rows.length - 1]!;
        row.cells.push(renderInline(tokens[i + 1]?.children).flat());
        const style = String(token.attrGet?.("style") ?? "");
        row.align.push(style.includes("right") ? "right" : style.includes("center") ? "center" : "left");
      }
    }
    const columnCount = Math.max(1, ...rows.map((row) => row.cells.length));
    const plain = (line: Line) => line.map((run) => run.text).join("");
    const widths: number[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      widths[column] = 1;
      for (const row of rows) {
        widths[column] = Math.max(widths[column]!, displayWidth(plain(row.cells[column] ?? [])));
      }
    }
    const budget = this.widthFor() - (columnCount * 3 + 1);
    while (widths.reduce((sum, width) => sum + width, 0) > budget && Math.max(...widths) > 1) {
      const widest = widths.indexOf(Math.max(...widths));
      widths[widest]! -= 1;
    }
    const pipe: Run = { text: "|" };
    const pad = (line: Line, width: number, align: string): Line => {
      const gap = width - displayWidth(plain(line));
      const spaces = (count: number): Run[] => (count > 0 ? [{ text: " ".repeat(count) }] : []);
      const content = align === "right" ? [...spaces(gap), ...line]
        : align === "center" ? [...spaces(Math.floor(gap / 2)), ...line, ...spaces(gap - Math.floor(gap / 2))]
        : [...line, ...spaces(gap)];
      return [{ text: " " }, ...content, { text: " " }];
    };
    const table: Line[] = [];
    for (const row of rows) {
      const cellLines = row.cells.map((cell, column) =>
        wrapRuns(cell, widths[column]!).map((line) => pad(line, widths[column]!, row.align[column] ?? "left")));
      const height = Math.max(1, ...cellLines.map((lines) => lines.length));
      for (let visual = 0; visual < height; visual += 1) {
        const line: Line = [pipe];
        for (let column = 0; column < columnCount; column += 1) {
          const cell = cellLines[column]?.[visual] ?? pad([], widths[column]!, row.align[column] ?? "left");
          line.push(...cell, pipe);
        }
        table.push(row.header ? line.map((run) => ({ ...run, codes: BOLD })) : line);
      }
      if (row.header) {
        const separator: Line = [{ text: "|", codes: DIM }];
        for (let column = 0; column < columnCount; column += 1) {
          separator.push({ text: "-".repeat(widths[column]! + 2), codes: DIM }, { text: "|", codes: DIM });
        }
        table.push(separator);
      }
    }
    this.blank();
    this.emit(table);
    return close;
  }

  render(tokens: Token[]): void {
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      switch (token.type) {
        case "heading_open": {
          this.blank();
          const runs = renderInline(tokens[i + 1]?.children).flat().map((run) => ({ ...run, codes: BOLD }));
          this.emit([runs]);
          i += 2;
          break;
        }
        case "paragraph_open": {
          this.blank();
          const wrapped = renderInline(tokens[i + 1]?.children).flatMap((line) => wrapRuns(line, this.widthFor()));
          this.emit(wrapped);
          i += 2;
          break;
        }
        case "fence":
        case "code_block":
          this.blank();
          this.emitCode(token.content);
          break;
        case "hr":
          this.blank();
          this.emit([[{ text: "--------", codes: DIM }]]);
          break;
        case "bullet_list_open":
          this.listStack.push({ ordered: false, index: 0 });
          break;
        case "ordered_list_open":
          this.listStack.push({ ordered: true, index: Number(tokens[i]!.attrGet("start") ?? 1) - 1 });
          break;
        case "bullet_list_close":
        case "ordered_list_close":
          this.listStack.pop();
          break;
        case "list_item_open": {
          const list = this.listStack[this.listStack.length - 1]!;
          const marker = list.ordered ? `${list.index += 1}.` : "-";
          this.prefixes.push({
            first: [{ text: `${marker} ` }],
            rest: [{ text: " ".repeat(marker.length + 1) }],
          });
          break;
        }
        case "list_item_close":
          this.prefixes.pop();
          break;
        case "blockquote_open":
          this.prefixes.push({ first: [{ text: "> ", codes: DIM }], rest: [{ text: "> ", codes: DIM }] });
          break;
        case "blockquote_close":
          this.prefixes.pop();
          break;
        case "table_open":
          i = this.renderTable(tokens, i);
          break;
        default: break; // lists, quotes, tables arrive in Task 3
      }
    }
  }

  finish(): string {
    while (this.lines.length > 0 && this.lines[this.lines.length - 1]!.length === 0) this.lines.pop();
    let start = 0;
    while (start < this.lines.length && this.lines[start]!.length === 0) start += 1;
    return this.lines.slice(start).map((line) => this.toText(line)).join("\n");
  }

  private toText(line: Line): string {
    if (!this.options.color) return line.map((run) => run.text).join("");
    let out = "";
    let active = "";
    for (const run of line) {
      const codes = run.codes ?? "";
      if (codes !== active) {
        if (active !== "") out += "\x1b[0m";
        if (codes !== "") out += `\x1b[${codes}m`;
        active = codes;
      }
      out += run.text;
    }
    if (active !== "") out += "\x1b[0m";
    return out;
  }
}

export function renderMarkdown(markdown: string, options: RenderOptions): string {
  const renderer = new BlockRenderer(options);
  renderer.render(md.parse(markdown, {}));
  return renderer.finish();
}
