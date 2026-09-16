/**
 * Utility functions for LaTeX processing
 *
 * remark-math only supports $...$ and $$...$$ delimiters by default.
 * Many LLMs output LaTeX using \(...\) and \[...\] delimiters.
 * This utility converts between formats.
 */

import { normalizeAtxHeadings } from "./markdown-display";

// A single-dollar math span must be tight at both ends. This mirrors the
// delimiter rule used by remark-math and avoids treating ordinary prices such
// as "$5 and $10" as one formula. The body accepts escaped characters so an
// escaped dollar does not terminate the span.
const INLINE_MATH_SPAN_SOURCE =
  String.raw`\$(?![$\s])(?:\\.|[^$\n])*?(?<!\s)\$(?!\$)`;

// Detection keeps one context character in front of the span, so the `$` of an
// escaped `\$5` is not taken for an opener.
const INLINE_MARKDOWN_MATH_RE = new RegExp(
  `(?:^|[^$\\\\])${INLINE_MATH_SPAN_SOURCE}`,
  "m",
);

// Standalone form of the same span: nothing outside the `$...$` pair belongs
// to the match, so a table row can rewrite exactly the formula it contains.
const TIGHT_INLINE_MATH_SPAN_RE = new RegExp(
  `(?<![$\\\\])${INLINE_MATH_SPAN_SOURCE}`,
  "g",
);

// Display environments LLMs frequently emit as bare
// `\begin{...}...\end{...}` blocks with no `$$` wrapper. Shared by the
// renderer-routing check and the delimiter conversion so the two cannot drift.
const MATH_ENVIRONMENT_NAMES =
  "equation|align|aligned|alignat|gather|gathered|multline|eqnarray|flalign|math|displaymath";

// Only environments KaTeX can actually render are worth wrapping: `multline`,
// `eqnarray`, `flalign`, `math` and `displaymath` are not part of its
// environment set, so a `$$` wrapper turns literal text into a KaTeX error.
// `aligned*` and `gathered*` do not exist either, hence no star on the two
// inner environments. `alignat` additionally needs its mandatory column count,
// which `wrapBareMathEnvironments` checks for.
const WRAPPABLE_MATH_ENVIRONMENT_PATTERN =
  "equation\\*?|align\\*?|alignat\\*?|gather\\*?|aligned|gathered";

// Opening token of a bare math environment, e.g. `\begin{equation}`.
// Detection only routes content to the rich KaTeX renderer, so a match inside
// a code fence is harmless.
const BARE_MATH_ENVIRONMENT_RE = new RegExp(
  `\\\\begin\\{(?:${MATH_ENVIRONMENT_NAMES})\\*?\\}`,
);

/**
 * Detect Markdown/LaTeX math that needs the rich KaTeX renderer.
 *
 * Display-math and backslash delimiters are detected from their opening token
 * so streaming content switches to the rich renderer as early as possible.
 * Single-dollar math waits for a valid closing delimiter because a lone `$`
 * is common in currency. Once a match exists, appending streamed text cannot
 * make it disappear, so the Simple -> Rich transition remains one-way.
 */
export function hasMarkdownMath(content: string): boolean {
  if (!content) return false;
  const value = String(content);

  if (/(^|[^\\])\$\$/.test(value)) return true;
  if (/\\\(|\\\[/.test(value)) return true;
  if (BARE_MATH_ENVIRONMENT_RE.test(value)) return true;
  return INLINE_MARKDOWN_MATH_RE.test(value);
}

/**
 * Convert LaTeX delimiters from \(...\) and \[...\] to $...$ and $$...$$
 * This makes the content compatible with remark-math for ReactMarkdown rendering.
 *
 * Only the text outside fenced code blocks (``` / ~~~) is converted: a sample
 * that shows LaTeX source keeps its delimiters. The blank-line collapse at the
 * end still runs over the whole document, fences included.
 *
 * @param content - The content containing LaTeX with \(...\) or \[...\] delimiters
 * @returns Content with $...$ and $$...$$ delimiters
 */
export function convertLatexDelimiters(content: string): string {
  if (!content) return content;

  // Clean up multiple consecutive newlines
  return splitFencedSegments(content)
    .map((segment) =>
      segment.fenced ? segment.text : convertLatexSegment(segment.text),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// A fence is three or more backticks or tildes, optionally indented, with an
// optional info string on the opening line.
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/;

// A GFM table row: the whole line is wrapped in pipes.
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

// A bare math environment that owns its line(s):
//   \begin{equation}
//   E = mc^2
//   \end{equation}
// Only environments from the wrappable list are matched, and the backreference
// (which carries the star, if any) stops `\begin{align}` from closing on a
// nested `\end{aligned}`. Group 2 is `alignat`'s column count when one is
// there: it sits outside the capture because `\end{alignat*}` has no argument.
const BARE_MATH_BLOCK_RE = new RegExp(
  `^[ \\t]*\\\\begin\\{(${WRAPPABLE_MATH_ENVIRONMENT_PATTERN})\\}(\\{[^}]*\\})?[\\s\\S]*?\\\\end\\{\\1\\}[ \\t]*$`,
  "gm",
);

type ContentSegment = {
  text: string;
  fenced: boolean;
};

/**
 * Split content into fenced and non-fenced runs, line by line. A fence that
 * never closes swallows everything up to the end of the document.
 */
function splitFencedSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let buffer: string[] = [];
  let fenceMarker = "";

  const flush = (fenced: boolean): void => {
    if (buffer.length === 0) return;
    segments.push({ text: buffer.join("\n"), fenced });
    buffer = [];
  };

  for (const line of content.split("\n")) {
    const marker = FENCE_LINE_RE.exec(line)?.[1] ?? "";

    if (!fenceMarker) {
      if (!marker) {
        buffer.push(line);
        continue;
      }

      // Opening fence: hold on to everything from here until the closing one.
      flush(false);
      fenceMarker = marker;
      buffer.push(line);
      continue;
    }

    buffer.push(line);

    // A closing fence repeats the opening marker character, at least as many
    // times, with nothing else on the line.
    const rest = line.trim().slice(marker.length).trim();
    if (
      marker !== "" &&
      marker[0] === fenceMarker[0] &&
      marker.length >= fenceMarker.length &&
      rest === ""
    ) {
      flush(true);
      fenceMarker = "";
    }
  }

  flush(fenceMarker !== "");
  return segments;
}

/**
 * Delimiter conversions for one run of text that is *not* inside a fence.
 */
function convertLatexSegment(text: string): string {
  let result = text;

  // JSON-encoded model output doubles every backslash, so `\\(x\\)` has to be
  // treated like `\(x\)`. `\\[` is only a delimiter when it is not the LaTeX
  // row-spacing syntax (`\\[2pt]`). Every rule skips a run of three or more
  // backslashes: there the first pair is a line break and only the rest
  // belongs to the delimiter (`\\\(x\)`, `\\\begin{cases}`).
  result = result.replace(/(?<!\\)\\\\\(/g, "\\(");
  result = result.replace(/(?<!\\)\\\\\)/g, "\\)");
  result = result.replace(/(?<!\\)\\\\\]/g, "\\]");
  result = result.replace(/(?<!\\)\\\\\[(?!\s*\d)/g, "\\[");
  // Environment tags are doubled the same way (`\\begin{equation}`), and only
  // normalising the opening one would leave an orphan backslash in the
  // wrapped block.
  result = result.replace(/(?<!\\)\\\\begin\{/g, "\\begin{");
  result = result.replace(/(?<!\\)\\\\end\{/g, "\\end{");

  // editor.md examples sometimes wrap \( ... \) inside $$ ... $$.
  // In that case the inner delimiters should be stripped rather than rewrapped.
  result = result.replace(
    /\$\$\s*\\\(([\s\S]*?)\\\)\s*\$\$/g,
    (_match, expr) => {
      return `\n$$\n${expr}\n$$\n`;
    },
  );

  // Convert \[...\] to $$...$$ (block math).
  // Use a regex that handles multiline content
  // Note: In JSON strings, \[ becomes \\[ which in JS becomes \[
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_match, expr) => {
    return `\n$$\n${expr}\n$$\n`;
  });

  // Convert \(...\) to $...$ (inline math).
  // Be careful not to match escaped parentheses in other contexts
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, expr) => {
    return ` $${expr}$ `;
  });

  // Also handle cases where LaTeX is directly in the text without proper delimiters
  // e.g., standalone \lim, \frac, etc. that should be wrapped
  // This is a common issue with LLM outputs

  // Bare environments own their line(s), so wrap them in $$ for remark-math.
  // Environments already sitting inside a $$ block are left alone.
  result = wrapBareMathEnvironments(result);

  // Inside a GFM table row an unescaped `|` splits the row even within math,
  // so swap the pipes of inline formulas for the same-glyph `\vert{}`.
  result = protectInlineMathPipesInTables(result);

  return result;
}

function wrapBareMathEnvironments(text: string): string {
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(BARE_MATH_BLOCK_RE)) {
    const [, environment, argument] = match;
    const start = match.index ?? 0;
    const end = start + match[0].length;

    // `alignat` takes a mandatory column count and KaTeX cannot render a bare
    // `\begin{alignat}`: wrapping it would turn text into an error rather than
    // into math.
    if (environment.startsWith("alignat") && !argument) continue;

    // An odd number of `$$` tokens before this line means the environment sits
    // inside an unclosed display block (`$$\n\begin{aligned}...`), which is
    // already math; an even number means it is bare, whatever the previous
    // line happens to end with.
    const displayTokens = (text.slice(0, start).match(/\$\$/g) ?? []).length;
    if (displayTokens % 2 === 1) continue;

    result += `${text.slice(cursor, start)}$$\n${text.slice(start, end)}\n$$`;
    cursor = end;
  }

  return result + text.slice(cursor);
}

function protectInlineMathPipesInTables(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!TABLE_ROW_RE.test(line)) return line;

      // Only a tight `$...$` span is math: in a price row such as
      // `| 课程 | $5 | $10 |` the dollars are currency, and rewriting the text
      // between them would tear the row apart.
      return line.replace(TIGHT_INLINE_MATH_SPAN_RE, (span: string) => {
        // `\vert{}` instead of a bare `\vert`: before a letter a bare command
        // would lex as `\vertx` and KaTeX rejects the whole formula, and a
        // trailing space would loosen the span for the closing `$`.
        return span.replace(/(?<!\\)\|/g, "\\vert{}");
      });
    })
    .join("\n");
}

const LIKELY_LATEX_BLOCK_RE = /\\[A-Za-z]+|\\\\|[_^&]/;

function looksLikeLatexBlock(lines: string[]): boolean {
  const block = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return block.length > 0 && LIKELY_LATEX_BLOCK_RE.test(block);
}

function normalizeEditorMdInlineMath(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "$" && i + 1 < lines.length) {
      let endIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "$") {
          endIdx = j;
          break;
        }
      }

      if (endIdx > i + 1 && looksLikeLatexBlock(lines.slice(i + 1, endIdx))) {
        result.push("$$");
        for (let j = i + 1; j < endIdx; j++) {
          result.push(lines[j]);
        }
        result.push("$$");
        i = endIdx;
        continue;
      }
    }

    if (
      /^\$\$[\s\S]+\$\$$/.test(trimmed) &&
      (trimmed.match(/\$\$/g)?.length ?? 0) === 2
    ) {
      const inner = trimmed.slice(2, -2).trim();
      result.push(`$$\n${inner}\n$$`);
      continue;
    }

    // editor.md commonly uses $...$ for inline math.
    result.push(
      line.replace(/\$\$([^$\n]+?)\$\$/g, (_match, expr: string) => {
        return `$${expr.trim()}$`;
      }),
    );
  }

  return result.join("\n");
}

type HeadingEntry = {
  level: number;
  text: string;
  slug: string;
};

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function collectMarkdownHeadings(content: string): HeadingEntry[] {
  const lines = content.split("\n");
  const headings: HeadingEntry[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    const atxMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (atxMatch) {
      const text = atxMatch[2].replace(/\s+#+\s*$/, "").trim();
      const slug = slugifyHeading(text);
      if (slug) headings.push({ level: atxMatch[1].length, text, slug });
      continue;
    }

    const next = lines[i + 1]?.trim();
    if (!trimmed || !next) continue;

    if (/^=+$/.test(next)) {
      const slug = slugifyHeading(trimmed);
      if (slug) headings.push({ level: 1, text: trimmed, slug });
      i += 1;
      continue;
    }

    if (/^-+$/.test(next)) {
      const slug = slugifyHeading(trimmed);
      if (slug) headings.push({ level: 2, text: trimmed, slug });
      i += 1;
    }
  }

  return headings;
}

function buildTableOfContents(headings: HeadingEntry[]): string {
  if (headings.length === 0) return "";

  return headings
    .map(({ level, text, slug }) => {
      const indent = "  ".repeat(Math.max(level - 1, 0));
      return `${indent}- [${text}](#${slug})`;
    })
    .join("\n");
}

function injectEditorMdTableOfContents(content: string): string {
  const headings = collectMarkdownHeadings(content);
  if (headings.length === 0) {
    return content.replace(/^\[TOCM?\]\s*$/gim, "");
  }

  const toc = buildTableOfContents(headings);
  return content.replace(/^\[TOCM?\]\s*$/gim, toc);
}

export function convertFlowFenceToMermaid(source: string): string | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const nodeDefs: string[] = [];
  const edges: string[] = [];

  const renderNode = (id: string, type: string, label: string): string => {
    const safeLabel = label.replace(/\|/g, "\\|");
    switch (type) {
      case "start":
      case "end":
        return `${id}([${safeLabel}])`;
      case "condition":
        return `${id}{${safeLabel}}`;
      case "inputoutput":
        return `${id}[/${safeLabel}/]`;
      case "subroutine":
        return `${id}[[${safeLabel}]]`;
      case "database":
        return `${id}[(${safeLabel})]`;
      default:
        return `${id}[${safeLabel}]`;
    }
  };

  for (const line of lines) {
    const defMatch =
      /^([A-Za-z][\w-]*)(?:=>|=)(start|end|operation|condition|inputoutput|subroutine|database):\s*(.+)$/.exec(
        line,
      );

    if (defMatch) {
      const [, id, type, label] = defMatch;
      nodeDefs.push(`  ${renderNode(id, type, label)}`);
      continue;
    }

    if (!line.includes("->")) continue;

    const parts = line
      .split("->")
      .map((part) => part.trim())
      .filter(Boolean);
    for (let i = 0; i < parts.length - 1; i += 1) {
      const fromMatch = /^([A-Za-z][\w-]*)(?:\(([^)]+)\))?$/.exec(parts[i]);
      const toMatch = /^([A-Za-z][\w-]*)(?:\(([^)]+)\))?$/.exec(parts[i + 1]);
      if (!fromMatch || !toMatch) continue;

      const [, fromId, fromAnnotation] = fromMatch;
      const [, toId] = toMatch;
      // flowchart.js puts branch labels on the source side (`cond(yes)->x`);
      // pure layout hints (`op(right)->x`) are not labels.
      const branch = fromAnnotation?.split(",")[0]?.trim();
      const label =
        branch && !/^(left|right|top|bottom)$/i.test(branch)
          ? `|${branch}|`
          : "";
      edges.push(`  ${fromId} -->${label} ${toId}`);
    }
  }

  if (nodeDefs.length === 0 || edges.length === 0) return null;
  return ["flowchart TD", ...nodeDefs, ...edges].join("\n");
}

export function convertSequenceFenceToMermaid(source: string): string | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const isSequenceDirective = (line: string): boolean => {
    return (
      /^Note\s+(left|right)\s+of\s+/i.test(line) ||
      /^participant\s+/i.test(line) ||
      /^(title|autonumber|activate|deactivate|loop|rect|opt|alt|par|critical|break|box|create|destroy)\b/i.test(
        line,
      ) ||
      /^([A-Za-z][\w.-]*)(?:-{1,2}>>?|--?>)([A-Za-z][\w.-]*)\s*:\s*.+$/.test(
        line,
      )
    );
  };

  const normalizedLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^Note\s+(left|right)\s+of\s+/i.test(line)) {
      let combined = line;

      while (i + 1 < lines.length && !isSequenceDirective(lines[i + 1])) {
        combined += `\\n${lines[i + 1]}`;
        i += 1;
      }

      normalizedLines.push(combined);
      continue;
    }

    normalizedLines.push(line);
  }

  const converted = normalizedLines.map((line) => {
    if (/^Note\s+(left|right)\s+of\s+/i.test(line)) {
      return `  ${line.replace(/\\n/g, "<br/>")}`;
    }

    const messageMatch =
      /^([A-Za-z][\w.-]*)(-{1,2}>>?|--?>)([A-Za-z][\w.-]*)\s*:\s*(.+)$/.exec(
        line,
      );

    if (messageMatch) {
      const [, from, operator, to, message] = messageMatch;
      const arrow =
        operator === "--" || operator === "-->"
          ? "-->>"
          : operator === "->>" || operator === "-->>"
            ? operator
            : "->>";
      return `  ${from}${arrow}${to}: ${message}`;
    }

    return `  ${line}`;
  });

  return ["sequenceDiagram", ...converted].join("\n");
}

function convertEditorMdFences(content: string): string {
  return content.replace(
    /```(flow|seq|sequence)\s*\n([\s\S]*?)```/g,
    (_match, lang: string, body: string) => {
      const converted =
        lang === "flow"
          ? convertFlowFenceToMermaid(body)
          : convertSequenceFenceToMermaid(body);

      if (!converted) return `\`\`\`${lang}\n${body}\`\`\``;
      return `\`\`\`mermaid\n${converted}\n\`\`\``;
    },
  );
}

/**
 * Process content for ReactMarkdown rendering with proper LaTeX support
 * This is a convenience wrapper that applies all necessary transformations.
 *
 * @param content - The raw content to process
 * @returns Processed content ready for ReactMarkdown with remark-math
 */
export function processLatexContent(content: string): string {
  if (!content) return "";

  // Convert to string if not already
  const str = String(content);

  // Apply delimiter conversion
  return convertLatexDelimiters(str);
}

export function processMarkdownContent(content: string): string {
  if (!content) return "";

  let result = String(content);
  result = normalizeAtxHeadings(result);
  result = normalizeEditorMdInlineMath(result);
  result = convertEditorMdFences(result);
  result = injectEditorMdTableOfContents(result);
  result = convertLatexDelimiters(result);
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
