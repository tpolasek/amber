/** Semantic SGR palettes for the CLI chrome. Every slot is a `;`-joined
 * parameter string passed to Terminal.style/runs — one escape pair per run,
 * never per word, so color costs a handful of bytes per line. */

export interface Theme {
  /** The `> ` prompt and the `>` marker on echoed user input. */
  prompt: string;
  /** `· info` lines: session notices, usage footer, queue confirmations. */
  meta: string;
  /** Thinking block body: shaded background with a distinct foreground. */
  thinking: string;
  thinkingHeader: string;
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
  /** Busy pill for the status line: filled background plus a font switch. */
  statusActive: string;
  /** Usage meter values and separators; meterFill is the subtle footer fill. */
  meterValue: string;
  meterFill: string;
}

export const DARK: Theme = {
  prompt: "1;38;5;208",
  meta: "2",
  thinking: "38;5;249;48;5;236",
  thinkingHeader: "1;38;5;250;48;5;236",
  toolOk: "38;5;114",
  toolErr: "1;38;5;210",
  toolName: "1;38;5;75",
  toolArg: "38;5;80",
  toolTail: "2",
  error: "1;38;5;196",
  diffAdd: "38;5;114",
  diffDel: "38;5;203",
  diffCtx: "2",
  code: "38;5;80",
  accent: "38;5;214",
  statusActive: "1;30;42",
  meterValue: "38;5;250",
  meterFill: "48;5;234",
};

export const LIGHT: Theme = {
  prompt: "1;38;5;166",
  meta: "2",
  thinking: "38;5;238;48;5;253",
  thinkingHeader: "1;38;5;236;48;5;253",
  toolOk: "38;5;28",
  toolErr: "1;38;5;160",
  toolName: "1;38;5;27",
  toolArg: "38;5;30",
  toolTail: "2",
  error: "1;38;5;160",
  diffAdd: "38;5;28",
  diffDel: "1;38;5;160",
  diffCtx: "2",
  code: "38;5;24",
  accent: "38;5;130",
  statusActive: "1;30;48;5;41",
  meterValue: "38;5;238",
  meterFill: "48;5;252",
};

export function themeFor(name: "dark" | "light"): Theme {
  return name === "light" ? LIGHT : DARK;
}
