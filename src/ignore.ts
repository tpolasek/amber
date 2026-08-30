/**
 * Minimal, dependency-free port of the `ignore` package's gitignore matcher,
 * used for `paths:`-gated skills. Replicates `.add()` and `.ignores()` so the
 * precedence, negation, and directory-matching semantics are unchanged.
 */

const EMPTY = "";
const SPACE = " ";
const ESCAPE = "\\";
const REGEX_TEST_BLANK_LINE = /^\s+$/;
const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
const REGEX_SPLITALL_CRLF = /\r?\n/g;

// Invalid:
// - /foo,
// - ./foo,
// - ../foo,
// - .
// - ..
// Valid:
// - .foo
const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;

const REGEX_TEST_TRAILING_SLASH = /\/$/;

const SLASH = "/";

const KEY_IGNORE = typeof Symbol !== "undefined" ? Symbol.for("node-ignore") : "node-ignore";

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;

const RETURN_FALSE = (): boolean => false;

// Sanitize the range of a regular expression. Invalid ranges (out of order)
// are eliminated because they crash JavaScript regular expressions.
const sanitizeRange = (range: string): string => range.replace(
  REGEX_REGEXP_RANGE,
  (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY,
);

// An optional `!` or `^` at the start of a class negates it, so that it matches
// any character not in the set. The leading `^` was escaped to `\^` by the
// metacharacter escaper, so strip the literal `!` or escaped `^` and emit a
// single regex `^`.
const negateRange = (range: string): string =>
  range.startsWith("!") || range.startsWith("\\^")
    ? `^${range.slice(range[0] === "!" ? 1 : 2)}`
    : range;

const cleanRangeBackSlash = (slashes: string): string => {
  const { length } = slashes;
  return slashes.slice(0, length - (length % 2));
};

// `foo/` should not continue with the `..`
const REPLACERS: Array<[RegExp, (this: string, substring: string, ...args: any[]) => string]> = [
  // Remove BOM
  [/^\uFEFF/, () => EMPTY],

  // Trailing spaces are ignored unless they are quoted with backslash ("\")
  [
    /((?:\\\\)*?)(\\?\s+)$/,
    (_: string, m1: string, m2: string) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY),
  ],

  // Replace (\ ) with ' '
  [
    /(\\+?)\s/g,
    (_: string, m1: string) => {
      const { length } = m1;
      return m1.slice(0, length - (length % 2)) + SPACE;
    },
  ],

  // Escape metacharacters
  [/[\\$.|*+(){^]/g, (match: string) => `\\${match}`],

  // A question mark (?) matches a single character
  [/(?!\\)\?/g, () => "[^/]"],

  // A leading slash matches the beginning of the pathname
  [/^\//, () => "^"],

  // Replace special metacharacter slash after the leading slash
  [/\//g, () => "\\/"],

  // A leading "**" followed by a slash means match in all directories.
  [/^\^*(?:\\\*\\\*\\\/)+/, () => "^(?:.*\\/)?"],

  // Starting
  [
    /^(?=[^^])/,
    function startingReplacer(this: string): string {
      // If the pattern does not contain a slash (or only a trailing one), Git
      // treats it as a shell glob pattern matching at any level; otherwise the
      // pattern is anchored to the directory level of the .gitignore.
      return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
    },
  ],

  // Two globstars
  [
    /\\\/\\\*\\\*(?=\\\/|$)/g,
    (_, index: number, str: string) => index + 6 < str.length
      // '/**/': zero or more directories
      ? "(?:\\/[^\\/]+)*"
      // Trailing '/**': everything inside
      : "\\/.+",
  ],

  // Normal intermediate wildcards
  [
    /(^|[^\\]+)(\\\*)+(?=.+)/g,
    (_: string, p1: string, p2: string) => {
      // An asterisk "*" matches anything except a slash; consecutive asterisks
      // are treated as regular asterisks.
      const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
      return p1 + unescaped;
    },
  ],

  // Unescape, revert step 3 except for back slash
  [/\\\\\\(?=[$.|*+(){^])/g, () => ESCAPE],

  // '\\\\' -> '\\'
  [/\\\\/g, () => ESCAPE],

  // The range notation, e.g. [a-zA-Z]
  [
    /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
    (match: string, leadEscape: string, range: string, endEscape: string, close: string) =>
      leadEscape === ESCAPE
        ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`
        : close === "]"
          ? endEscape.length % 2 === 0
            ? `[${negateRange(sanitizeRange(range))}${endEscape}]`
            : "[]"
          : "[]",
  ],

  // Ending
  [
    /(?:[^*])$/,
    (match: string) => /\/$/.test(match)
      // foo/ will not match 'foo'
      ? `${match}$`
      // foo matches 'foo' and 'foo/'
      : `${match}(?=$|\\/$)`,
  ],
];

const REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
const MODE_IGNORE = "regex";
const MODE_CHECK_IGNORE = "checkRegex";

const TRAILING_WILD_CARD_REPLACERS: Record<string, (this: unknown, _: unknown, p1: string) => string> = {
  [MODE_IGNORE]: (_, p1: string) => {
    const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
    return `${prefix}(?=$|\\/$)`;
  },
  [MODE_CHECK_IGNORE]: (_, p1: string) => {
    // `git check-ignore` matches `abc/` for `abc/*`.
    const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
    return `${prefix}(?=$|\\/$)`;
  },
};

const makeRegexPrefix = (pattern: string): string => REPLACERS.reduce(
  (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern) as (substring: string, ...args: any[]) => string),
  pattern,
);

const isString = (subject: unknown): subject is string => typeof subject === "string";

// A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = (pattern: string): boolean => Boolean(pattern)
  && !REGEX_TEST_BLANK_LINE.test(pattern)
  && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern)
  && pattern.indexOf("#") !== 0;

const splitPattern = (pattern: string): string[] => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);

class IgnoreRule {
  public readonly pattern: string;
  public readonly mark: string;
  public readonly negative: boolean;
  private readonly ignoreCase: boolean;
  private readonly regexPrefix: string;
  private _regex: RegExp | undefined;
  private _checkRegex: RegExp | undefined;

  constructor(pattern: string, mark: string, body: string, ignoreCase: boolean, negative: boolean, prefix: string) {
    this.pattern = pattern;
    this.mark = mark;
    this.negative = negative;
    this.ignoreCase = ignoreCase;
    this.regexPrefix = prefix;
  }

  get regex(): RegExp {
    if (this._regex) return this._regex;
    this._regex = this._make(MODE_IGNORE);
    return this._regex;
  }

  get checkRegex(): RegExp {
    if (this._checkRegex) return this._checkRegex;
    this._checkRegex = this._make(MODE_CHECK_IGNORE);
    return this._checkRegex;
  }

  private _make(mode: string): RegExp {
    const str = this.regexPrefix.replace(
      REGEX_REPLACE_TRAILING_WILDCARD,
      TRAILING_WILD_CARD_REPLACERS[mode] as (substring: string, ...args: any[]) => string,
    );
    return this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
  }
}

const createRule = ({ pattern }: { pattern: string }, ignoreCase: boolean): IgnoreRule => {
  let negative = false;
  let body = pattern;

  // An optional prefix "!" negates the pattern.
  if (body.indexOf("!") === 0) {
    negative = true;
    body = body.substring(1);
  }

  body = body
    // Put a backslash in front of the first "!" for patterns that begin with a
    // literal "!", e.g. `"\!important!.txt"`.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!")
    // Put a backslash in front of the first hash for patterns beginning with a hash.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");

  return new IgnoreRule(pattern, "", body, ignoreCase, negative, makeRegexPrefix(body));
};

class RuleManager {
  private readonly ignoreCase: boolean;
  private rules: IgnoreRule[] = [];
  private added = false;

  constructor(ignoreCase: boolean) {
    this.ignoreCase = ignoreCase;
  }

  private _add(pattern: unknown): void {
    if (pattern && (pattern as Record<string | symbol, unknown>)[KEY_IGNORE]) {
      const source = (pattern as unknown as { _rules: RuleManager })._rules.rules;
      this.rules = this.rules.concat(source);
      this.added = true;
      return;
    }

    const input: { pattern: string } = isString(pattern) ? { pattern } : pattern as { pattern: string };
    if (checkPattern(input.pattern)) {
      this.rules.push(createRule(input, this.ignoreCase));
      this.added = true;
    }
  }

  add(pattern: string | string[] | Ignore): boolean {
    this.added = false;
    const items = isString(pattern) ? splitPattern(pattern) : Array.isArray(pattern) ? pattern : [pattern];
    items.forEach((item) => this._add(item));
    return this.added;
  }

  test(path: string, checkUnignored: boolean, mode: string): { ignored: boolean; unignored: boolean; rule?: IgnoreRule } {
    let ignored = false;
    let unignored = false;
    let matchedRule: IgnoreRule | undefined;

    this.rules.forEach((rule) => {
      const { negative } = rule;
      // Skip rules per the negation state machine: once a path is ignored we
      // only re-evaluate negation rules; once unignored we only re-evaluate
      // positive rules.
      if ((unignored === negative && ignored !== unignored) || (negative && !ignored && !unignored && !checkUnignored)) {
        return;
      }
      const matched = (mode === MODE_CHECK_IGNORE ? rule.checkRegex : rule.regex).test(path);
      if (!matched) return;

      ignored = !negative;
      unignored = negative;
      matchedRule = negative ? undefined : rule;
    });

    const ret: { ignored: boolean; unignored: boolean; rule?: IgnoreRule } = { ignored, unignored };
    if (matchedRule) ret.rule = matchedRule;
    return ret;
  }
}

const throwError = (message: string, Ctor: ErrorConstructor): never => {
  throw new Ctor(message);
};

const isNotRelative = (path: string): boolean => REGEX_TEST_INVALID_PATH.test(path);

const checkPath = (path: string, originalPath: string, doThrow: (msg: string, Ctor: ErrorConstructor) => never): void => {
  if (!isString(path)) {
    return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError);
  }
  if (!path) {
    return doThrow("path must not be empty", TypeError);
  }
  if (isRelativeCheck(path)) {
    return doThrow(`path should be a \`path.relative()\`d string, but got "${originalPath}"`, RangeError);
  }
};

// `isRelativeCheck` and `convertPath` are swapped on Windows to handle drive
// letters and backslashes; on other platforms they are the defaults.
let isRelativeCheck = isNotRelative;
let convertPath = (p: string): string => p;

const setupWindows = (): void => {
  const makePosix = (str: string): string =>
    /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str)
      ? str
      : str.replace(/\\/g, "/");

  convertPath = makePosix;
  const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
  isRelativeCheck = (path: string): boolean => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
};

// Windows
/* istanbul ignore next */
if (typeof process !== "undefined" && process.platform === "win32") {
  setupWindows();
}

class Ignore {
  private readonly strictPathCheck: boolean;
  private readonly rules: RuleManager;
  private ignoreCache: Record<string, { ignored: boolean; unignored: boolean }>;
  private testCache: Record<string, { ignored: boolean; unignored: boolean }>;

  constructor({ ignorecase = true, ignoreCase = ignorecase, allowRelativePaths = false }: {
    ignorecase?: boolean;
    ignoreCase?: boolean;
    allowRelativePaths?: boolean;
  } = {}) {
    this.rules = new RuleManager(ignoreCase);
    this.strictPathCheck = !allowRelativePaths;
    this.ignoreCache = Object.create(null);
    this.testCache = Object.create(null);
  }

  add(pattern: string | string[]): this {
    if (this.rules.add(pattern)) {
      // Some rules were added, so the behavior changed; re-initialize caches.
      this.ignoreCache = Object.create(null);
      this.testCache = Object.create(null);
    }
    return this;
  }

  private _test(
    originalPath: string,
    cache: Record<string, { ignored: boolean; unignored: boolean }>,
    checkUnignored: boolean,
    slices?: string[],
  ): { ignored: boolean; unignored: boolean } {
    const path = originalPath && convertPath(originalPath);
    checkPath(path, originalPath, this.strictPathCheck ? throwError : (() => undefined) as never);
    return this._t(path, cache, checkUnignored, slices);
  }

  private _t(
    path: string,
    cache: Record<string, { ignored: boolean; unignored: boolean }>,
    checkUnignored: boolean,
    slices?: string[],
  ): { ignored: boolean; unignored: boolean } {
    if (path in cache) {
      return cache[path]!;
    }

    if (!slices) {
      slices = path.split(SLASH).filter(Boolean);
    }
    slices = slices.slice(0, -1);

    // If the path has no parent directory, just test it.
    if (!slices.length) {
      const result = this.rules.test(path, checkUnignored, MODE_IGNORE);
      cache[path] = result;
      return result;
    }

    const parent = this._t(slices.join(SLASH) + SLASH, cache, checkUnignored, slices);
    const result = parent.ignored ? parent : this.rules.test(path, checkUnignored, MODE_IGNORE);
    cache[path] = result;
    return result;
  }

  ignores(path: string): boolean {
    return this._test(path, this.ignoreCache, false).ignored;
  }
}

const factory = (options?: {
  ignorecase?: boolean;
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}): Ignore => new Ignore(options);

export default factory;
