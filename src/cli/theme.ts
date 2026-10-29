/** Semantic SGR palettes for the CLI chrome. Every slot is a `;`-joined
 * parameter string passed to Terminal.style/runs — one escape pair per run,
 * never per word, so color costs a handful of bytes per line. Codes prefer
 * the short ANSI names when the basic palette has a close match; 256-color
 * is reserved for hues it cannot express (amber accents, fills that sit a
 * step off the terminal's own background). */

export interface Theme {
  /** The `> ` prompt and the `>` marker on echoed user input. */
  prompt: string;
  /** `· info` lines: session notices, queue confirmations. */
  meta: string;
  /** Thinking text: a grey a step lighter than ordinary output, no fill. */
  thinking: string;
  thinkingHeader: string;
  /** Fenced code blocks: filled background with a distinct foreground. */
  codeBlock: string;
  /** Tool completion glyphs. */
  toolOk: string;
  toolErr: string;
  /** Tool call line: name (`Bash`), argument (command/path), trailing meters. */
  toolName: string;
  toolArg: string;
  toolTail: string;
  /** Fatal lines, always high contrast. */
  error: string;
  /** Unified diff lines under --full. */
  diffAdd: string;
  diffDel: string;
  diffCtx: string;
  /** Markdown inline code. */
  code: string;
  /** Ids and markers: session prefixes, the current-model marker. */
  accent: string;
  /** Busy pill for the status line: accent font on the meter strip's fill. */
  statusActive: string;
  /** The `Assistant` tag above a reply: dark magenta on the meter fill. */
  assistantHeader: string;
  /** Usage meter values and separators; meterFill is the subtle footer fill. */
  meterValue: string;
  meterFill: string;
}

export const DARK: Theme = {
  prompt: "1;38;5;208",
  meta: "2",
  thinking: "38;5;242",
  thinkingHeader: "1;38;5;242",
  codeBlock: "38;5;249;48;5;236",
  toolOk: "32",
  toolErr: "1;31",
  toolName: "1;94",
  toolArg: "36",
  toolTail: "2",
  error: "1;91",
  diffAdd: "32",
  diffDel: "91",
  diffCtx: "2",
  code: "36",
  accent: "38;5;214",
  statusActive: "1;38;5;214;48;5;234",
  assistantHeader: "1;35;48;5;234",
  meterValue: "37",
  meterFill: "48;5;234",
};

export const LIGHT: Theme = {
  prompt: "1;38;5;166",
  meta: "2",
  thinking: "38;5;247",
  thinkingHeader: "1;38;5;247",
  codeBlock: "38;5;238;48;5;253",
  toolOk: "32",
  toolErr: "1;31",
  toolName: "1;34",
  toolArg: "36",
  toolTail: "2",
  error: "1;31",
  diffAdd: "32",
  diffDel: "1;31",
  diffCtx: "2",
  code: "34",
  accent: "38;5;130",
  statusActive: "1;38;5;130;48;5;252",
  assistantHeader: "1;35;48;5;252",
  meterValue: "30",
  meterFill: "48;5;252",
};

export function themeFor(name: "dark" | "light"): Theme {
  return name === "light" ? LIGHT : DARK;
}
