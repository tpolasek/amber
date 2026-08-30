/**
 * Minimal, dependency-free port of the `shell-quote` argument parser, used for
 * skill `$ARGUMENTS` splitting. Replicates the tokenization of Bash quoting
 * rules backed by shell-quote's `parse()` so the behavior is unchanged.
 */

export type ControlOperator = "||" | "&&" | ";;" | "|&" | "<(" | ">>" | ">&" | "&" | ";" | "(" | ")" | "|" | "<" | ">";

export type ParseEntry =
  | string
  | { op: ControlOperator }
  | { op: "glob"; pattern: string }
  | { comment: string };

export interface ParseOptions {
  /** Custom escape character, default value is `\`. */
  escape?: string | undefined;
  /** When `true`, splits on unquoted whitespace; when a string, treats it as the field separator. */
  splitUnquoted?: boolean | string | undefined;
}

const CONTROL = `(?:${[
  "\\|\\|",
  "\\&\\&",
  ";;",
  "\\|\\&",
  "\\<\\(",
  "\\<\\<\\<",
  ">>",
  ">\\&",
  "<\\&",
  "[&;()|<>]",
].join("|")})`;
const controlRE = new RegExp(`^${CONTROL}$`);
const META = "|&;()<> \t";
const SINGLE_QUOTE = "'([^']*?)'";
const DOUBLE_QUOTE = '"((\\\\"|[^"])*?)"';
const hash = /^#$/;

const SQ = "'";
const DQ = '"';
const DS = "$";

let TOKEN = "";
const mult = 0x100000000; // Math.pow(16, 8);
for (let i = 0; i < 4; i++) {
  TOKEN += (mult * Math.random()).toString(16);
}
const startsWithToken = new RegExp(`^${TOKEN}`);

function matchAll(s: string, r: RegExp): RegExpMatchArray[] {
  const origIndex = r.lastIndex;
  const matches: RegExpMatchArray[] = [];
  let matchObj: RegExpMatchArray | null;
  while ((matchObj = r.exec(s))) {
    matches.push(matchObj);
    if (r.lastIndex === matchObj.index) {
      r.lastIndex += 1;
    }
  }
  r.lastIndex = origIndex;
  return matches;
}

function getVar(env: Env, pre: string, key: string): string {
  const r = typeof env === "function" ? env(key) : env[key];
  let value: string;
  if (typeof r === "undefined" && key !== "") {
    value = "";
  } else if (typeof r === "undefined") {
    value = "$";
  } else if (typeof r === "object") {
    return pre + TOKEN + JSON.stringify(r) + TOKEN;
  } else {
    value = String(r);
  }
  return pre + value;
}

type Env = Record<string, unknown> | ((key: string) => unknown);

function parseInternal(string: string, env: Env, opts: ParseOptions): ParseEntry[] {
  const BS = opts.escape || "\\";
  const ifs =
    opts.splitUnquoted === true ? " \t\n" : (typeof opts.splitUnquoted === "string" ? opts.splitUnquoted : "");
  const BAREWORD = `(\\${BS}['"${META}]|[^\\s'"${META}])+`;

  const chunker = new RegExp(
    `(${CONTROL})|(${BAREWORD}|${DOUBLE_QUOTE}|${SINGLE_QUOTE})+`,
    "g",
  );

  const matches = matchAll(string, chunker);

  if (matches.length === 0) {
    return [];
  }
  if (!env) {
    env = {};
  }

  let commented = false;

  return matches.map((match): undefined | ParseEntry | ParseEntry[] => {
    const s = match[0];
    if (!s || commented) {
      return undefined;
    }
    if (controlRE.test(s)) {
      return { op: s as ControlOperator };
    }

    // Hand-written scanner/parser for Bash quoting rules:
    //
    // 1. inside single quotes, all characters are printed literally.
    // 2. inside double quotes, all characters are printed literally
    //    except variables prefixed by '$' and backslashes followed by
    //    either a double quote or another backslash.
    // 3. outside of any quotes, backslashes are treated as escape
    //    characters and not printed (unless they are themselves escaped)
    // 4. quote context can switch mid-token if there is no whitespace
    //     between the two quote contexts (e.g. all'one'"token" parses as
    //     "allonetoken")
    let quote: string | false = false;
    let esc = false;
    let out = "";
    const words: string[] = [];
    let sawQuote = false;
    let pendingNw: number | null = null;
    let isGlob = false;
    let i: number;

    function parseEnvVar(): string {
      i += 1;
      let varend: number | RegExpMatchArray | null;
      let varname: string;
      let char = s.charAt(i);

      if (char === "{") {
        i += 1;
        if (s.charAt(i) === "}") {
          throw new Error(`Bad substitution: ${s.slice(i - 2, i + 1)}`);
        }
        // match braces by depth so a nested `${` keeps its inner `}` from ending the outer substitution
        let depth = 1;
        varend = i;
        while (depth > 0 && varend < s.length) {
          if (s.charAt(varend) === "{" && s.charAt(varend - 1) === "$") {
            depth += 1;
          } else if (s.charAt(varend) === "}") {
            depth -= 1;
          }
          varend += 1;
        }
        if (depth !== 0) {
          throw new Error(`Bad substitution: ${s.slice(i)}`);
        }
        varend -= 1;
        varname = s.slice(i, varend);
        i = varend;
      } else if ((/[*@#?$!_-]/).test(char)) {
        varname = char;
        i += 1;
      } else {
        const slicedFromI = s.slice(i);
        varend = slicedFromI.match(/[^\w\d_]/);
        if (!varend) {
          varname = slicedFromI;
          i = s.length;
        } else {
          varname = slicedFromI.slice(0, varend.index!);
          i += varend.index! - 1;
        }
      }
      return getVar(env, "", varname);
    }

    function flushRun(): void {
      if (pendingNw === null) return;
      if (pendingNw === 0) {
        if (out !== "") {
          words.push(out);
          out = "";
        }
      } else {
        words.push(out);
        out = "";
        for (let fe = 1; fe < pendingNw; fe += 1) {
          words.push("");
        }
      }
      pendingNw = null;
    }

    for (i = 0; i < s.length; i += 1) {
      let c = s.charAt(i);
      if (ifs && c !== DS) {
        flushRun();
      }
      isGlob = isGlob || (!quote && (c === "*" || c === "?"));
      if (esc) {
        out += c;
        esc = false;
      } else if (quote) {
        if (c === quote) {
          quote = false;
        } else if (quote === SQ) {
          out += c;
        } else { // Double quote
          if (c === BS) {
            i += 1;
            c = s.charAt(i);
            if (c === DQ || c === BS || c === DS) {
              out += c;
            } else {
              out += BS + c;
            }
          } else if (c === DS) {
            out += parseEnvVar();
          } else {
            out += c;
          }
        }
      } else if (c === DQ || c === SQ) {
        quote = c;
        sawQuote = true;
      } else if (controlRE.test(c)) {
        return { op: s as ControlOperator };
      } else if (hash.test(c)) {
        commented = true;
        const commentObj: ParseEntry = { comment: string.slice(match.index! + i + 1) };
        if (out.length) {
          return [out, commentObj];
        }
        return [commentObj];
      } else if (c === BS) {
        esc = true;
      } else if (c === DS) {
        const value = parseEnvVar();
        if (!ifs) {
          out += value;
        } else {
          for (let vi = 0; vi < value.length; vi += 1) {
            const vc = value.charAt(vi);
            if (ifs.indexOf(vc) < 0) {
              flushRun();
              out += vc;
            } else if (pendingNw === null) {
              pendingNw = vc === " " || vc === "\t" || vc === "\n" ? 0 : 1;
            } else if (vc !== " " && vc !== "\t" && vc !== "\n") {
              pendingNw += 1;
            }
          }
        }
      } else {
        out += c;
      }
    }

    if (isGlob) {
      return { op: "glob", pattern: out };
    }

    if (ifs) {
      if (pendingNw !== null && pendingNw > 0) {
        words.push(out);
        out = "";
        for (let te = 1; te < pendingNw; te += 1) {
          words.push("");
        }
      }
      if (out !== "" || (sawQuote && words.length === 0)) {
        words.push(out);
      }
      return words;
    }

    return out;
  }).reduce((prev: ParseEntry[], arg) => {
    if (typeof arg === "undefined") {
      return prev;
    }
    ([] as ParseEntry[]).concat(arg).forEach((entry) => {
      prev.push(entry);
    });
    return prev;
  }, [] as ParseEntry[]);
}

/**
 * Parse a shell command string into an array of argument entries, interpolating
 * `$VARNAME` / `${VARNAME}` substitutions via `env` (an object or a lookup
 * function, mirroring shell-quote's contract).
 */
export function parse(s: string, env?: Env, opts?: ParseOptions): ParseEntry[];
export function parse<T extends object | string>(
  s: string,
  env: (key: string) => T | undefined,
  opts?: ParseOptions,
): Array<ParseEntry | T>;
export function parse(s: string, env?: Env, opts?: ParseOptions): Array<ParseEntry | unknown> {
  const mapped = parseInternal(s, env ?? {}, opts ?? {});
  if (typeof env !== "function") {
    return mapped;
  }
  return mapped.reduce((acc: Array<ParseEntry | unknown>, entry) => {
    if (typeof entry === "object") {
      acc.push(entry);
      return acc;
    }
    const xs = entry.split(new RegExp(`(${TOKEN}.*?${TOKEN})`, "g"));
    if (xs.length === 1) {
      acc.push(xs[0]!);
      return acc;
    }
    xs.filter(Boolean).forEach((x) => {
      acc.push(startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]!) : x);
    });
    return acc;
  }, [] as Array<ParseEntry | unknown>);
}
