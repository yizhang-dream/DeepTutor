/**
 * Bare math in prose: formulas a model writes with no delimiter at all —
 * `P_t`, `∫₀^∞ u²e^(−u)du`, `lim_{Vᵢ→0}`. remark-math only renders delimited
 * math, so a run of LaTeX-ish tokens around a "seed" gets wrapped in `$...$`.
 *
 * A run is line based (it never crosses a line break) and never touches an
 * existing `$...$`/`$$` region, inline code, a URL, a markdown link or an HTML
 * tag. Lines that open a list item or a block quote are left alone entirely, so
 * the block structure cannot be pulled into a span.
 *
 * Every emitted span has to be renderable: the run retreats to a boundary
 * KaTeX accepts (balanced brackets, no dangling `_`/`^`/`\`, no loose
 * combining mark) and is dropped when no such boundary exists.
 *
 * This module intentionally does not import `./latex` — `latex.ts` imports it,
 * and the tight `$...$` rule it needs is mirrored in `tightSpanEnd` below.
 */

// ---------------------------------------------------------------------------
// Seeds: a token strong enough that what surrounds it is meant as math.
// ---------------------------------------------------------------------------

// ①a Unicode math characters that are math on their own: Greek letters,
// formula-only operators, and the super/subscript characters. The script
// characters live in three blocks: Latin-1 (¹²³), super/subscripts
// (U+2070-U+209F) and the modifier letters (U+1D2C-U+1D6A, which carry ᵢ ᵣ ᵤ).
const MATH_SYMBOL_SOURCE =
  "[∫∮Σ∑Π∏∇Δ∂∞√∈∥⊥∘ΓΔΘΛΞΦΨΩπρλμαβγθφμνωεσκτ¹²³\u2070-\u209f\u1d2c-\u1d6a]";
const MATH_SYMBOL_RE = new RegExp(MATH_SYMBOL_SOURCE);

// ①b Symbols that are ordinary punctuation in prose as well: `→` in
// "descriptive stats → probability", `·` in a name, `°` in a temperature.
// They seed only when they sit next to a letter, a digit, a scripted token or
// a backslash command — never on their own. The middle dot is not a seed at
// all, it only ever joins a run that a real seed started.
const MATH_OPERATOR_SOURCE = "[→←↔⇒⇔×−±∓≪≫≤≥≠≈∝≡°⋯…]";
const MATH_OPERATOR_RE = new RegExp(MATH_OPERATOR_SOURCE);

// A character that turns the letter in front of it into a scripted symbol.
const SCRIPT_MARKER_SOURCE = "[_^¹²³\u2070-\u209f\u1d2c-\u1d6a]";

// ② An explicit script group, `^{...}` / `_{...}`.
const SCRIPT_GROUP_SOURCE = "[\\^_]\\{";

// ③ A Latin letter with a script. The underscore keeps the single-letter base
// (`P_t`), so identifiers such as `pK_combined` and `ring_field` stay prose; the
// caret allows a multi-letter base (`mc^2`, `e^{...}`), where a letter token
// followed by `^` is overwhelmingly a formula.
const SINGLE_LETTER_SCRIPT_SOURCE = "(?<![A-Za-z0-9_])[A-Za-z]_[^\\s_^]";
const CARET_SCRIPT_SOURCE = "[A-Za-z][A-Za-z0-9]*\\^[^\\s_^]";

// ④ Whitelisted TeX commands.
const TEX_COMMAND_SOURCE =
  "\\\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|cdot|times|pm|mp|partial|nabla|infty|approx|leq|geq|neq|left|right|vec|overline|ldots|cdots|Rightarrow|to|propto|mathrm|boxed|alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|phi|varphi|Phi|chi|psi|Psi|omega|Omega)(?![A-Za-z])";
const TEX_COMMAND_RE = new RegExp(TEX_COMMAND_SOURCE);
const TEX_COMMAND_AT_START_RE = new RegExp(`^${TEX_COMMAND_SOURCE}`);

const UNCONDITIONAL_SEED_SOURCE = [
  MATH_SYMBOL_SOURCE,
  SCRIPT_GROUP_SOURCE,
  SINGLE_LETTER_SCRIPT_SOURCE,
  CARET_SCRIPT_SOURCE,
  TEX_COMMAND_SOURCE,
].join("|");
const BARE_MATH_SEED_SOURCE = `${UNCONDITIONAL_SEED_SOURCE}|${MATH_OPERATOR_SOURCE}`;
const BARE_MATH_SEED_RE = new RegExp(BARE_MATH_SEED_SOURCE);
// Only ever used with `matchAll`, which does not keep state on this instance.
const BARE_MATH_SEED_SCAN_RE = new RegExp(BARE_MATH_SEED_SOURCE, "g");

// ---------------------------------------------------------------------------
// Run shape
// ---------------------------------------------------------------------------

// Characters a run swallows directly; Unicode math characters (above) count as
// well, so a run carries its own operators (`P_{t+1} − P_t`), bracketed groups
// (`[H⁺][OH⁻]`) and ellipses (`Σ(xᵢ − c)² ⋯`).
const RUN_CHAR_RE = /[A-Za-z0-9_^(){}+\-=<>:,./·×∓±|\[\]⋯…°]/;

// A space may be bridged when the next token is an operator, a script group, a
// whitelisted command, a Unicode math character, a token carrying a script
// (`P_t`, `M²`, `Ce^(−u)` — a plain word like `the` does not qualify), a
// `**bold**` unit holding a single symbol, or — after an operator, where a
// number is plainly the operand — a numeric token (`P_t = 1`, `×10⁻¹⁴`).
const BRIDGE_OPERATOR_RE = /^[+\-=<>−≈≤≥·×/]/;
const SCRIPTED_TOKEN_RE = new RegExp(`[A-Za-z]${SCRIPT_MARKER_SOURCE}`);
const SCRIPT_TOKEN_RE = /^[\^_]\{/;
const BOLD_AT_START_RE = /^\*\*/;
const NUMBER_AT_START_RE = /^\d/;
// A standalone letter (`c` in `Σ(xᵢ − c)²`, the `E` in `E = mc^2`): math in
// operand position, prose anywhere else.
const SINGLE_LETTER_AT_START_RE = /^[A-Za-z](?![A-Za-z0-9_^\u2070-\u209f])/;
const SINGLE_LETTER_RE = /^[A-Za-z]$/;
// A clause boundary ends the expression: never bridge across `,` `;` `:`.
const CLAUSE_MARK_RE = /^[,;:]/;

// A GFM table row: `|` keeps its structural meaning there (mirrors latex.ts).
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

// A list item or block quote opener: the marker (`- `, `+ `, `> `, `1. `) is
// block syntax and is masked, so a run can never swallow it; the content after
// it is wrapped as usual. `BLOCK_LIKE_RE` catches the shapes whose end cannot be
// measured exactly — those lines are left alone instead (fail safe).
const BLOCK_MARKER_RE = /^[ \t]*(?:[-+>]\s|\d+\.\s)/;
const BLOCK_LIKE_RE = /^[ \t]*(?:[-+>]|\d+\.(?=\s|$))/;

// Whitespace and brackets may not sit on a run's edge, and neither may a
// script or escape character that has lost its body.
const RUN_EDGE_RE = /[\s\[\]]/;
const DANGLING_RE = /[_^\\]/;

const COMBINING_MARK_RE = /[\u0300-\u036f\u1ab0-\u1aff\u20d0-\u20ff\ufe20-\ufe2f]/;

const URL_RE = /https?:\/\/\S+/g;
const LINK_TARGET_RE = /\]\([^)\s]*\)/g;
const HTML_TAG_RE = /<[A-Za-z/][^<>\n]{0,60}>/g;

// ---------------------------------------------------------------------------
// Detection (mirrors the seed list above; fence awareness is not needed because
// a false positive only routes content to the rich renderer)
// ---------------------------------------------------------------------------

export function hasBareMathSeed(content: string): boolean {
  if (!content) return false;
  return BARE_MATH_SEED_RE.test(String(content));
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap bare math runs (formulas written without delimiters) in `$...$`.
 */
export function wrapBareMathRuns(content: string): string {
  if (!content) return content;

  let inDisplay = false;
  const lines = String(content)
    .split("\n")
    .map((line) => {
      const { text, inDisplay: nextInDisplay } = wrapRunsInLine(line, inDisplay);
      inDisplay = nextInDisplay;
      return text;
    });

  return lines.join("\n");
}

/**
 * Is a display block still open at the end of `text`? A `$$` opens one only at
 * the start of a line (a stray mid-line `$$` must not put the rest of the
 * message into math), while any `$$` closes an open one.
 */
export function hasOpenDisplayMath(text: string): boolean {
  let open = false;

  for (const match of text.matchAll(/\$\$/g)) {
    const index = match.index ?? 0;
    if (!open) {
      if (opensDisplay(text, index)) open = true;
      continue;
    }
    open = false;
  }

  return open;
}

type ProtectedLine = {
  mask: Uint8Array;
  inDisplay: boolean;
};

/**
 * Only a `$$` that opens its line starts display math: a stray one in the
 * middle of a sentence must not turn every later line into math.
 */
function opensDisplay(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, index));
}

/**
 * Mark the parts of a line no run may enter: inline code, URLs, markdown link
 * targets, HTML tags, and `$...$` / `$$` regions. Display parity carries across
 * lines, so everything after an unclosed `$$` stays protected until the closing
 * token shows up.
 */
function protectRegions(line: string, inDisplay: boolean): ProtectedLine {
  const mask = new Uint8Array(line.length);
  const mark = (from: number, to: number): void => {
    for (let i = Math.max(0, from); i < Math.min(line.length, to); i += 1) {
      mask[i] = 1;
    }
  };

  // Inline code spans; an unclosed backtick protects the rest of the line.
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "`" || mask[i] === 1) continue;
    const close = line.indexOf("`", i + 1);
    if (close === -1) {
      mark(i, line.length);
      break;
    }
    mark(i, close + 1);
    i = close;
  }

  for (const match of line.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    mark(start, start + match[0].length);
  }

  // Markdown link targets (`](https://…)`): `[` and `]` are run characters, so
  // without this a formula next to a link could pull its brackets apart. The
  // link text in front of them may still hold math.
  for (const match of line.matchAll(LINK_TARGET_RE)) {
    const start = match.index ?? 0;
    mark(start, start + match[0].length);
  }

  // Inline HTML (`<b>`, `</span>`): the tag must stay outside any span.
  for (const match of line.matchAll(HTML_TAG_RE)) {
    const start = match.index ?? 0;
    mark(start, start + match[0].length);
  }

  let cursor = 0;
  let displayOpen = inDisplay;
  if (displayOpen) {
    const close = line.indexOf("$$");
    if (close === -1) {
      mark(0, line.length);
      return { mask, inDisplay: true };
    }
    mark(0, close + 2);
    cursor = close + 2;
    displayOpen = false;
  }

  while (cursor < line.length) {
    const dollar = line.indexOf("$", cursor);
    if (dollar === -1) break;

    if (mask[dollar] === 1) {
      cursor = dollar + 1;
      continue;
    }

    if (line[dollar + 1] === "$") {
      if (!displayOpen && !opensDisplay(line, dollar)) {
        // A mid-line `$$...$$` is a self-contained span: mask the whole pair so
        // its body cannot be wrapped into the display block, and never let it
        // open display state for the rest of the message. Only an unpaired one
        // is masked as two characters.
        const close = line.indexOf("$$", dollar + 2);
        mark(dollar, close === -1 ? dollar + 2 : close + 2);
        cursor = close === -1 ? dollar + 2 : close + 2;
        continue;
      }

      if (displayOpen) {
        mark(dollar, dollar + 2);
        cursor = dollar + 2;
        displayOpen = false;
        continue;
      }

      const close = line.indexOf("$$", dollar + 2);
      if (close === -1) {
        mark(dollar, line.length);
        return { mask, inDisplay: true };
      }
      mark(dollar, close + 2);
      cursor = close + 2;
      continue;
    }

    const end = tightSpanEnd(line, dollar);
    mark(dollar, end === -1 ? dollar + 1 : end + 1);
    cursor = (end === -1 ? dollar : end) + 1;
  }

  return { mask, inDisplay: false };
}

/**
 * End index of a tight `$...$` span opened at `open`, or -1. Mirrors the
 * `INLINE_MATH_SPAN_SOURCE` rule in `./latex` (which cannot be imported here
 * without a cycle): the body holds no `$`, the closing `$` is tight, and an
 * escaped character does not terminate the span.
 */
function tightSpanEnd(line: string, open: number): number {
  const preceding = line[open - 1];
  if (preceding === "$" || preceding === "\\") return -1;

  const first = line[open + 1];
  if (first === undefined || first === "$" || /\s/.test(first)) return -1;

  for (let i = open + 1; i < line.length; i += 1) {
    if (line[i] === "\\") {
      i += 1;
      continue;
    }
    if (line[i] !== "$") continue;
    if (/\s/.test(line[i - 1])) return -1;
    if (line[i + 1] === "$") return -1;
    return i;
  }

  return -1;
}

function wrapRunsInLine(
  line: string,
  inDisplay: boolean,
): { text: string; inDisplay: boolean } {
  const protectedLine = protectRegions(line, inDisplay);
  const mask = protectedLine.mask;

  // A list item or block quote keeps its marker: mask it (indentation included)
  // so no run can reach into it, then wrap the content after it as usual. When
  // the marker cannot be measured exactly, leave the whole line alone.
  const marker = BLOCK_MARKER_RE.exec(line);
  if (marker) {
    for (let i = 0; i < marker[0].length; i += 1) mask[i] = 1;
  } else if (BLOCK_LIKE_RE.test(line)) {
    return { text: line, inDisplay: protectedLine.inDisplay };
  }

  const blocked = (index: number): boolean =>
    index < 0 || index >= line.length || mask[index] === 1;

  // On a table row a pipe is structure, not math.
  if (TABLE_ROW_RE.test(line)) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "|") mask[i] = 1;
    }
  }

  let text = "";
  let cursor = 0;

  for (const seed of line.matchAll(BARE_MATH_SEED_SCAN_RE)) {
    const seedStart = seed.index ?? 0;
    const seedEnd = seedStart + seed[0].length;
    if (blocked(seedStart) || blocked(seedEnd - 1) || seedStart < cursor) {
      continue;
    }

    // A bare symbol that is punctuation in prose (`→`, `·`, `°`) only counts as
    // math when it sits against something numeric or symbolic.
    if (MATH_OPERATOR_RE.test(seed[0]) && !hasMathNeighbour(line, mask, seedStart, seedEnd)) {
      continue;
    }

    const candidate = expandRun(line, blocked, cursor, seedStart, seedEnd);
    const run = closeRun(line, candidate);
    if (!run) continue;

    const inner = prepareRunText(line.slice(run.start, run.end));
    if (inner.trim() === "") continue;

    // A span that would sit flush against another `$` reads as `$$`: keep the
    // display parity intact by keeping them apart. "Flush" means either the
    // text emitted so far ends on a `$` (counting the untouched source in
    // between), or the source right behind this run does.
    const gap = line.slice(cursor, run.start);
    const lead =
      (text + gap).endsWith("$") || (run.start > 0 && line[run.start - 1] === "$")
        ? " "
        : "";
    const trail = run.end < line.length && line[run.end] === "$" ? " " : "";
    text += `${gap}${lead}$${inner}$${trail}`;
    cursor = run.end;
  }

  return { text: text + line.slice(cursor), inDisplay: protectedLine.inDisplay };
}

/** Is one of the characters around the symbol a letter, digit, script or command? */
function hasMathNeighbour(
  line: string,
  mask: Uint8Array,
  start: number,
  end: number,
): boolean {
  const before = start > 0 && mask[start - 1] !== 1 ? line[start - 1] : "";
  const after = end < line.length && mask[end] !== 1 ? line[end] : "";
  const scriptBefore = start > 1 ? line.slice(start - 2, start) : "";
  const scriptAfter = line.slice(end, end + 2);

  return (
    /[A-Za-z0-9)\]}]/.test(before) ||
    /[A-Za-z0-9(\\]/.test(after) ||
    SCRIPTED_TOKEN_RE.test(scriptBefore) ||
    LETTER_MARKER_RE.test(scriptAfter)
  );
}

const LETTER_MARKER_RE = new RegExp(`^[A-Za-z]${SCRIPT_MARKER_SOURCE}`);

type RunRange = {
  start: number;
  end: number;
};

function expandRun(
  line: string,
  blocked: (index: number) => boolean,
  limit: number,
  seedStart: number,
  seedEnd: number,
): RunRange {
  let start = seedStart;
  let end = seedEnd;

  for (;;) {
    const grown = growRight(line, blocked, end);
    if (grown === end) break;
    end = grown;
  }

  for (;;) {
    const grown = growLeft(line, blocked, limit, start);
    if (grown === start) break;
    start = grown;
  }

  return { start, end };
}

/**
 * Retreat a grown run to a boundary KaTeX accepts. Returns null when the whole
 * run has to be dropped (nothing renderable is left).
 */
function closeRun(line: string, run: RunRange): RunRange | null {
  let start = run.start;
  let end = run.end;

  const trimEdges = (): void => {
    while (start < end && RUN_EDGE_RE.test(line[start])) start += 1;
    while (end > start && RUN_EDGE_RE.test(line[end - 1])) end -= 1;
    while (end > start && DANGLING_RE.test(line[end - 1])) end -= 1;
    while (start < end && DANGLING_RE.test(line[start])) {
      // A leading backslash may be the command the run is built on.
      if (
        line[start] === "\\" &&
        TEX_COMMAND_AT_START_RE.test(line.slice(start, end))
      ) {
        break;
      }
      start += 1;
    }
  };

  trimEdges();
  if (start >= end) return null;

  // Braces and parentheses have to balance: an unclosed `(` means the run is
  // not a formula any more, so nothing is wrapped. An orphan bracket (the `[`
  // of a footnote marker) only costs the bracket: retreat to the last balanced
  // position and keep the symbol that was actually math.
  const unbalanced = unbalancedGroup(line.slice(start, end));
  if (unbalanced !== null) {
    if (unbalanced !== "[" && unbalanced !== "]") return null;
    const balanced = lastBalancedPrefixLength(line.slice(start, end));
    if (balanced === 0) return null;
    end = start + balanced;
    trimEdges();
    if (start >= end) return null;
  }

  // A combining mark needs a base character in front of it.
  if (hasLooseCombiningMark(line.slice(start, end))) return null;

  return { start, end };
}

/** The group character that leaves `text` unbalanced, or null when it is fine. */
function unbalancedGroup(text: string): string | null {
  const stack: string[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]" || char === "}") {
      const open = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== open) return char;
    }
  }

  return stack.length > 0 ? stack[0] : null;
}

/** Length of the longest prefix whose brackets and braces are balanced. */
function lastBalancedPrefixLength(text: string): number {
  const stack: string[] = [];
  let balanced = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
    } else if (char === ")" || char === "]" || char === "}") {
      const open = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== open) return balanced;
    }

    if (stack.length === 0) balanced = i + 1;
  }

  return stack.length === 0 ? text.length : balanced;
}

function hasLooseCombiningMark(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!COMBINING_MARK_RE.test(text[i])) continue;
    const previous = text[i - 1];
    if (previous === undefined || previous === " " || COMBINING_MARK_RE.test(previous)) {
      return true;
    }
  }
  return false;
}

function growRight(
  line: string,
  blocked: (index: number) => boolean,
  from: number,
): number {
  let end = from;

  for (;;) {
    if (!blocked(end) && isRunChar(line[end])) {
      end += 1;
      continue;
    }

    if (line[end] === "\\" && !blocked(end)) {
      const command = TEX_COMMAND_AT_START_RE.exec(line.slice(end));
      if (command) {
        end += command[0].length;
        continue;
      }
    }

    const boldEnd = boldUnitEnd(line, blocked, end);
    if (boldEnd !== -1) {
      end = boldEnd;
      continue;
    }

    const bridged = bridgeRight(line, blocked, end);
    if (bridged !== -1) {
      end = bridged;
      continue;
    }

    return end;
  }
}

function growLeft(
  line: string,
  blocked: (index: number) => boolean,
  limit: number,
  from: number,
): number {
  let start = from;

  for (;;) {
    if (start > limit && !blocked(start - 1) && isRunChar(line[start - 1])) {
      start -= 1;
      continue;
    }

    const boldStart = boldUnitStart(line, blocked, start, limit);
    if (boldStart !== -1 && boldStart >= limit) {
      start = boldStart;
      continue;
    }

    const bridged = bridgeLeft(line, blocked, limit, start);
    if (bridged !== -1) {
      start = bridged;
      continue;
    }

    return start;
  }
}

function isRunChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    RUN_CHAR_RE.test(char) ||
    MATH_SYMBOL_RE.test(char) ||
    MATH_OPERATOR_RE.test(char) ||
    // A combining mark belongs to the letter in front of it (`x̄`), so a run
    // carries it; a mark without a base is rejected in `closeRun`.
    COMBINING_MARK_RE.test(char)
  );
}

function isOperatorChar(char: string | undefined): boolean {
  return char !== undefined && BRIDGE_OPERATOR_RE.test(char);
}

/** Position after a `**...**` unit starting at `from`, or -1. */
function boldUnitEnd(
  line: string,
  blocked: (index: number) => boolean,
  from: number,
): number {
  if (!line.startsWith("**", from)) return -1;

  for (let i = from + 2; i < line.length; i += 1) {
    if (line.startsWith("**", i)) {
      if (i === from + 2) return -1;
      return isMathUnit(line.slice(from + 2, i)) ? i + 2 : -1;
    }
    if (blocked(i) || !isUnitFiller(line[i])) return -1;
  }

  return -1;
}

/** Position of the `**` opening a unit that closes at `from`, or -1. */
function boldUnitStart(
  line: string,
  blocked: (index: number) => boolean,
  from: number,
  limit: number,
): number {
  if (line[from - 2] !== "*" || line[from - 1] !== "*") return -1;

  for (let i = from - 2; i > limit; i -= 1) {
    if (line[i - 1] === "*" && line[i - 2] === "*") {
      if (i >= from - 2) return -1;
      return isMathUnit(line.slice(i, from - 2)) ? i - 2 : -1;
    }
    if (blocked(i - 1) || !isUnitFiller(line[i - 1])) return -1;
  }

  return -1;
}

/** What a `**...**` unit may contain to be part of a run. */
function isUnitFiller(char: string | undefined): boolean {
  return char === " " || isRunChar(char);
}

/**
 * A unit only joins a run when it holds symbols rather than prose: `**E**` and
 * `**σ²**` are emphasized math, `**mean**` is a word someone bolded.
 */
function isMathUnit(body: string): boolean {
  if (body.trim() === "") return false;
  return !/[A-Za-z]{2,}/.test(body);
}

/** Position after a bridgeable gap to the right, or -1. */
function bridgeRight(
  line: string,
  blocked: (index: number) => boolean,
  from: number,
): number {
  let i = from;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (i === from) return -1;

  const rest = line.slice(i);
  if (rest === "") return -1;
  if (bridgeableRight(line, blocked, i, line[from - 1])) return i;
  return -1;
}

function bridgeableRight(
  line: string,
  blocked: (index: number) => boolean,
  index: number,
  previousRunChar: string | undefined,
): boolean {
  if (blocked(index)) return false;
  const rest = line.slice(index);
  if (CLAUSE_MARK_RE.test(rest)) return false;

  return (
    BRIDGE_OPERATOR_RE.test(rest) ||
    SCRIPT_TOKEN_RE.test(rest) ||
    MATH_SYMBOL_RE.test(rest[0]) ||
    MATH_OPERATOR_RE.test(rest[0]) ||
    TEX_COMMAND_AT_START_RE.test(rest) ||
    SCRIPTED_TOKEN_RE.test(tokenAfter(line, blocked, index)) ||
    boldUnitEnd(line, blocked, index) !== -1 ||
    (NUMBER_AT_START_RE.test(rest) && isOperatorChar(previousRunChar)) ||
    (SINGLE_LETTER_AT_START_RE.test(rest) && isOperatorChar(previousRunChar))
  );
}

/** Position of a bridgeable gap to the left, or -1. */
function bridgeLeft(
  line: string,
  blocked: (index: number) => boolean,
  limit: number,
  from: number,
): number {
  let i = from;
  while (i > limit && (line[i - 1] === " " || line[i - 1] === "\t")) i -= 1;
  if (i === from || i <= limit) return -1;

  const token = tokenBefore(line, blocked, i, limit);
  if (token === "") return -1;
  if (bridgeableLeft(token, line[from])) return i;
  return -1;
}

/** The run characters directly left of `pos`, bounded by `limit`. */
function tokenBefore(
  line: string,
  blocked: (index: number) => boolean,
  pos: number,
  limit: number,
): string {
  let i = pos;
  while (i > limit && !blocked(i - 1) && isRunChar(line[i - 1])) i -= 1;
  return line.slice(i, pos);
}

/** The run characters directly right of `pos`. */
function tokenAfter(
  line: string,
  blocked: (index: number) => boolean,
  pos: number,
): string {
  let i = pos;
  while (i < line.length && !blocked(i) && isRunChar(line[i])) i += 1;
  return line.slice(pos, i);
}

function bridgeableLeft(token: string, nextRunChar: string | undefined): boolean {
  if (/[,;:]$/.test(token)) return false;

  return (
    BOLD_AT_START_RE.test(token) ||
    BRIDGE_OPERATOR_RE.test(token) ||
    MATH_SYMBOL_RE.test(token[0]) ||
    MATH_OPERATOR_RE.test(token[0]) ||
    SCRIPTED_TOKEN_RE.test(token) ||
    TEX_COMMAND_RE.test(token) ||
    (NUMBER_AT_START_RE.test(token) && isOperatorChar(nextRunChar)) ||
    (SINGLE_LETTER_RE.test(token) && isOperatorChar(nextRunChar))
  );
}

/**
 * Make a run safe for KaTeX: strip `**` emphasis and brace a parenthesised
 * script body (`e^(−u)` would otherwise take just the `(` as its exponent).
 */
function prepareRunText(inner: string): string {
  return inner
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/([\^_])\(([^()]*)\)/g, "$1{$2}");
}
