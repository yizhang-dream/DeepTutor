import test from "node:test";
import assert from "node:assert/strict";
import {
  convertFlowFenceToMermaid,
  convertLatexDelimiters,
  convertSequenceFenceToMermaid,
  hasMarkdownMath,
  processLatexContent,
  processMarkdownContent,
} from "../lib/latex";

// ---------------------------------------------------------------------------
// hasMarkdownMath — shared Simple/Rich renderer routing
// ---------------------------------------------------------------------------

test("hasMarkdownMath: detects plain inline formulas from chat prose", () => {
  const content = "假设有一个函数 $f(x)$，在 $x=2$ 这个点上，函数值趋近 $5$。";

  assert.equal(hasMarkdownMath(content), true);
  assert.equal(hasMarkdownMath("The limit is $2$."), true);
});

test("hasMarkdownMath: detects display and backslash delimiters while streaming", () => {
  assert.equal(hasMarkdownMath("Working... $$"), true);
  assert.equal(hasMarkdownMath("Solve \\(x=2"), true);
  assert.equal(hasMarkdownMath("Then \\[x^2"), true);
});

test("hasMarkdownMath: does not confuse ordinary currency or escaped dollars", () => {
  assert.equal(hasMarkdownMath("Tickets cost $5 and $10 respectively."), false);
  assert.equal(hasMarkdownMath("Write \\$5 and \\$10 literally."), false);
});

// ---------------------------------------------------------------------------
// convertLatexDelimiters
// ---------------------------------------------------------------------------

test("convertLatexDelimiters: \\\\[...\\\\] → block $$...$$", () => {
  const input = "Before \\[x^2 + 1\\] after";
  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$$\nx^2 + 1\n$$"));
});

test("convertLatexDelimiters: \\\\(...\\\\) → inline $...$", () => {
  const input = "Solve \\(x = 2\\) now";
  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$x = 2$"));
});

test("convertLatexDelimiters: strips \\\\(\\\\) inside $$...$$", () => {
  const input = "$$\\(x^2\\)$$";
  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$$\nx^2\n$$"));
  assert.ok(!result.includes("\\("));
});

test("convertLatexDelimiters: multiline \\\\[...\\\\]", () => {
  const input = "\\[\n\\frac{a}{b}\n\\]";
  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$$"));
  assert.ok(result.includes("\\frac{a}{b}"));
});

test("convertLatexDelimiters: preserves expr containing $& replacement char", () => {
  const input = "\\[x \\$\\& y\\]";
  const result = convertLatexDelimiters(input);
  assert.ok(
    result.includes("x \\$\\& y"),
    "special regex replacement char $& must be preserved",
  );
});

test("convertLatexDelimiters: returns empty-ish input unchanged", () => {
  assert.equal(convertLatexDelimiters(""), "");
  assert.equal(convertLatexDelimiters(null as unknown as string), null);
});

test("convertLatexDelimiters: collapses triple+ newlines", () => {
  const input = "a\n\n\n\nb";
  const result = convertLatexDelimiters(input);
  assert.ok(!result.includes("\n\n\n"));
});

// ---------------------------------------------------------------------------
// convertLatexDelimiters — doubled backslashes, bare environments, fences,
// table rows (model output the renderer used to drop)
// ---------------------------------------------------------------------------

test("escaped delimiters: \\\\(x = 1\\\\) → $x = 1$ with no leftover backslash", () => {
  const input = "\\\\(x = 1\\\\)";
  assert.equal(hasMarkdownMath(input), true);

  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$x = 1$"));
  assert.ok(!result.includes("\\ $"), "no dangling backslash before the span");
  assert.ok(!result.includes("\\\\"), "the doubled backslashes are normalised");
});

test("escaped delimiters: \\\\[x = 1\\\\] → block $$...$$", () => {
  const result = convertLatexDelimiters("\\\\[x = 1\\\\]");
  assert.ok(result.includes("$$\nx = 1\n$$"));
});

test("escaped delimiters: a doubled environment is unwrapped, then wrapped in $$", () => {
  const input = "\\\\begin{equation} E=mc^2 \\\\end{equation}";
  assert.equal(hasMarkdownMath(input), true);

  const result = convertLatexDelimiters(input);
  assert.equal(
    result,
    "$$\n\\begin{equation} E=mc^2 \\end{equation}\n$$",
    "tags are single-backslash inside the block",
  );
  assert.ok(!result.includes("\\\\"), "no orphan backslash in the math block");
});

test("escaped delimiters: a \\\\ line break inside $$ aligned is left alone", () => {
  const input = "$$\\begin{aligned} a \\\\ b \\end{aligned}$$";
  const result = convertLatexDelimiters(input);

  assert.equal(result, input);
  assert.ok(result.includes("\\\\"), "the \\\\ line break survives");
});

test("escaped delimiters: a line break before inline math is not mis-split", () => {
  // Raw text: `a \\\(x\) b` — a two-backslash line break immediately followed
  // by the `\(` opener. Only the opener's own backslash may be consumed.
  const lineBreak = "\\\\"; // the two characters `\` `\`
  const input = `a ${lineBreak}\\(x\\) b`;
  const result = convertLatexDelimiters(input);

  assert.ok(result.includes("a \\\\ $x$"), "the \\\\ line break stays a pair");
  assert.ok(result.includes("$x$"), "the inline formula still converts");
  assert.equal(
    (result.match(/\\/g) ?? []).length,
    2,
    "no stray backslash is left behind",
  );
});

test("escaped delimiters: a line break before a nested environment survives", () => {
  // `\\` (line break) immediately followed by `\begin{...}`: the first two
  // backslashes belong to the break, not to a doubled environment tag.
  const input = "x \\\\\\begin{cases} y \\end{cases}";
  const result = convertLatexDelimiters(input);

  assert.equal(result, input);
  assert.ok(
    result.includes("\\\\\\begin{cases}"),
    "break and opener stay intact",
  );
});

test("bare environment: \\begin{equation} is detected and wrapped in $$", () => {
  const input = "\\begin{equation} E=mc^2 \\end{equation}";
  assert.equal(hasMarkdownMath(input), true);

  const result = convertLatexDelimiters(input);
  assert.ok(result.includes("$$\n\\begin{equation} E=mc^2 \\end{equation}\n$$"));
});

test("bare environment: starred align keeps its \\\\ line breaks", () => {
  const input = "\\begin{align*} a&=b \\\\ c&=d \\end{align*}";
  assert.equal(hasMarkdownMath(input), true);

  const result = convertLatexDelimiters(input);
  assert.ok(
    result.includes("$$\n\\begin{align*} a&=b \\\\ c&=d \\end{align*}\n$$"),
  );
  assert.ok(result.includes("\\\\"), "internal \\\\ line break must survive");
});

test("bare environment: an environment already inside $$ is not wrapped twice", () => {
  const inline = "$$\\begin{aligned} a&=b \\end{aligned}$$";
  assert.equal(convertLatexDelimiters(inline), inline);

  const block = "$$\n\\begin{aligned}\na&=b\n\\end{aligned}\n$$";
  assert.equal(convertLatexDelimiters(block), block);
});

test("bare environment: a $-wrapped one-liner keeps its delimiters", () => {
  const input = "$\\begin{aligned} a&=b \\end{aligned}$";
  assert.equal(convertLatexDelimiters(input), input);
});

test("bare environment: after an inline formula on the previous line it is wrapped", () => {
  const input = "结论是 $x=2$\n\\begin{equation} E \\end{equation}";
  assert.equal(
    convertLatexDelimiters(input),
    "结论是 $x=2$\n$$\n\\begin{equation} E \\end{equation}\n$$",
  );
});

test("bare environment: after a closed $$ block it is wrapped", () => {
  const input = "$$\na\n$$\n\\begin{equation} E \\end{equation}";
  assert.equal(
    convertLatexDelimiters(input),
    "$$\na\n$$\n$$\n\\begin{equation} E \\end{equation}\n$$",
  );
});

test("bare environment: only KaTeX-renderable environments are wrapped", () => {
  for (const bare of [
    "\\begin{equation} a \\end{equation}",
    "\\begin{align} a \\end{align}",
    "\\begin{alignat}{2} a \\end{alignat}",
    "\\begin{gather} a \\end{gather}",
    "\\begin{aligned} a \\end{aligned}",
    "\\begin{gathered} a \\end{gathered}",
  ]) {
    assert.ok(
      convertLatexDelimiters(bare).includes("$$"),
      `${bare} should be wrapped`,
    );
  }

  for (const env of ["multline", "eqnarray", "flalign", "math", "displaymath"]) {
    const bare = `\\begin{${env}} a \\end{${env}}`;
    assert.equal(hasMarkdownMath(bare), true, `${env} still needs the rich renderer`);
    assert.equal(convertLatexDelimiters(bare), bare, `${env} is left unwrapped`);
  }

  // `aligned*`/`gathered*` do not exist in KaTeX, so they are not wrappable.
  const starredInner = "\\begin{aligned*} a \\end{aligned*}";
  assert.equal(convertLatexDelimiters(starredInner), starredInner);
});

test("bare environment: alignat without its column count is left alone", () => {
  for (const env of ["alignat", "alignat*"]) {
    const bare = `\\begin{${env}} a &= b \\end{${env}}`;

    assert.equal(hasMarkdownMath(bare), true, `${env} still needs the rich renderer`);
    assert.equal(convertLatexDelimiters(bare), bare, `${env} is left unwrapped`);
  }
});

test("bare environment: alignat with its column count is wrapped", () => {
  for (const env of ["alignat", "alignat*"]) {
    const input = `\\begin{${env}}{2} a &= b \\end{${env}}`;

    assert.equal(convertLatexDelimiters(input), `$$\n${input}\n$$`);
  }
});

test("fences: LaTeX inside ``` / ~~~ blocks is copied through untouched", () => {
  const fencedEnv = "```latex\n\\begin{equation}x\\end{equation}\n```";
  assert.equal(convertLatexDelimiters(fencedEnv), fencedEnv);

  const fencedInline = "```text\n\\\\(x\\\\)\n```";
  assert.equal(convertLatexDelimiters(fencedInline), fencedInline);

  const fencedTilde = "~~~\n\\\\(y\\\\)\n~~~";
  assert.equal(convertLatexDelimiters(fencedTilde), fencedTilde);

  const unclosed = "```text\n\\\\(x\\\\)";
  assert.equal(convertLatexDelimiters(unclosed), unclosed);
});

test("fences: prose around a fenced block is still converted", () => {
  const input = "```\n\\\\(x\\\\)\n```\n\nSolve \\\\(y = 2\\\\) now";
  const result = convertLatexDelimiters(input);

  assert.ok(result.includes("```\n\\\\(x\\\\)\n```"), "fence body stays verbatim");
  assert.ok(result.includes("$y = 2$"), "prose after the fence is converted");
});

test("tables: unescaped pipes inside row math become \\vert", () => {
  const input = "| 定义 | $|x|=2$ |";
  const result = convertLatexDelimiters(input);

  assert.ok(result.includes("$\\vert{}x\\vert{}=2$"));
  assert.equal(result.match(/\|/g)?.length, 3, "row pipes still separate 4 cells");
  assert.equal(result.split("|").length, 4);
});

test("tables: |x| outside a table row is left alone", () => {
  const input = "$|x|=2$";
  assert.equal(convertLatexDelimiters(input), input);
});

test("tables: currency cells are not mistaken for math", () => {
  const prices = "| 课程 | $5 | $10 |";
  assert.equal(convertLatexDelimiters(prices), prices);

  const escapedPrices = "| 课程 | \\$5 | \\$10 |";
  assert.equal(convertLatexDelimiters(escapedPrices), escapedPrices);
});

test("tables: only the real formula in a price row is rewritten", () => {
  const input = "| 课程 | $5 | $|x|=2$ |";
  const result = convertLatexDelimiters(input);

  assert.equal(result, "| 课程 | $5 | $\\vert{}x\\vert{}=2$ |");
  assert.equal(result.match(/\|/g)?.length, 4, "only the row's own pipes remain");
  assert.equal(result.split("|").length, 5, "3 cells plus the edge pipes");
});

test("row spacing: \\\\[2pt] is not treated as a display-math delimiter", () => {
  const input = "a \\\\[2pt] b";
  const result = convertLatexDelimiters(input);

  assert.equal(result, input);
  assert.ok(!result.includes("$$"));
});

// ---------------------------------------------------------------------------
// processLatexContent (thin wrapper)
// ---------------------------------------------------------------------------

test("processLatexContent: delegates to convertLatexDelimiters", () => {
  assert.equal(processLatexContent(""), "");
  const out = processLatexContent("\\(x\\)");
  assert.ok(out.includes("$x$"));
});

// ---------------------------------------------------------------------------
// processMarkdownContent — heading normalisation
// ---------------------------------------------------------------------------

test("headings: inserts space when missing", () => {
  const result = processMarkdownContent("##Title");
  assert.ok(result.includes("## Title"));
});

test("headings: leaves properly-spaced headings alone", () => {
  const result = processMarkdownContent("## Title");
  assert.ok(result.includes("## Title"));
});

test("headings: does not split 7+ consecutive hashes", () => {
  const result = processMarkdownContent("#######");
  assert.equal(result.trim(), "#######");
});

test("headings: leaves heading-like fenced code verbatim", () => {
  const input = [
    "```c",
    "##define FEATURE",
    "```",
    "",
    "~~~text",
    "###literal",
    "~~~",
  ].join("\n");

  assert.equal(processMarkdownContent(input), input);
});

test("headings: leaves raw HTML code blocks verbatim", () => {
  const input = [
    "<pre>",
    "###literal",
    "</pre>",
    "",
    "<code>",
    "##define FEATURE",
    "</code>",
  ].join("\n");

  assert.equal(processMarkdownContent(input), input);
});

// ---------------------------------------------------------------------------
// processMarkdownContent — inline math normalisation ($$...$$ → $...$)
// ---------------------------------------------------------------------------

test("inline math: $$x$$ on a line with other text → $x$", () => {
  const result = processMarkdownContent("Compute $$x^2$$ now");
  assert.ok(result.includes("$x^2$"));
  assert.ok(!result.includes("$$x^2$$"));
});

test("inline math: standalone one-line $$...$$ → split to block", () => {
  const result = processMarkdownContent("$$\\frac{a}{b}$$");
  const lines = result.trim().split("\n");
  assert.equal(lines[0], "$$");
  assert.ok(lines[1].includes("\\frac{a}{b}"));
  assert.equal(lines[2], "$$");
});

// ---------------------------------------------------------------------------
// processMarkdownContent — loose block math ($...\n...\n$) promotion
// ---------------------------------------------------------------------------

test("loose block math: single-$ lines wrapping LaTeX → promoted to $$", () => {
  const input = "$\n\\frac{a}{b}\n$";
  const result = processMarkdownContent(input);
  const lines = result.trim().split("\n");
  assert.equal(lines[0], "$$");
  assert.ok(lines.some((l) => l.includes("\\frac{a}{b}")));
  assert.equal(lines[lines.length - 1], "$$");
});

test("loose block math: single-$ lines with non-LaTeX content → not promoted", () => {
  const input = "$\nhello world\n$";
  const result = processMarkdownContent(input);
  assert.ok(!result.startsWith("$$"));
});

test("loose block math: recognises \\\\ (line break) as LaTeX", () => {
  const input = "$\na \\\\\nb\n$";
  const result = processMarkdownContent(input);
  const lines = result.trim().split("\n");
  assert.equal(lines[0], "$$");
});

test("loose block math: recognises _ and ^ as LaTeX", () => {
  const input = "$\nx_1 + y^2\n$";
  const result = processMarkdownContent(input);
  const lines = result.trim().split("\n");
  assert.equal(lines[0], "$$");
});

// ---------------------------------------------------------------------------
// processMarkdownContent — end-to-end pipeline
// ---------------------------------------------------------------------------

test("pipeline: combined heading + inline math + delimiter conversion", () => {
  const input = "##Heading\n\nSolve \\(x=1\\) and $$y$$";
  const result = processMarkdownContent(input);
  assert.ok(result.includes("## Heading"), "heading should be normalised");
  assert.ok(result.includes("$x=1$"), "\\\\(...\\\\) should become $...$");
  assert.ok(result.includes("$y$"), "$$y$$ inline should become $y$");
});

test("pipeline: preserves fenced code blocks", () => {
  const input = "```python\nprint('hello')\n```";
  const result = processMarkdownContent(input);
  assert.ok(result.includes("print('hello')"));
});

// ---------------------------------------------------------------------------
// editor.md fence conversion (flow / seq)
// ---------------------------------------------------------------------------

test("flow fence: keeps yes/no branch labels from the source side", () => {
  const input = [
    "st=>start: Start",
    "cond=>condition: Ready?",
    "a=>operation: Go",
    "b=>operation: Wait",
    "e=>end: Done",
    "st->cond",
    "cond(yes)->a->e",
    "cond(no)->b->e",
  ].join("\n");
  const result = convertFlowFenceToMermaid(input);
  assert.ok(result, "conversion should succeed");
  assert.ok(result.includes("cond -->|yes| a"));
  assert.ok(result.includes("cond -->|no| b"));
});

test("flow fence: layout hints are not edge labels", () => {
  const input = [
    "st=>start: Start",
    "op=>operation: Work",
    "e=>end: Done",
    "st(right)->op->e",
  ].join("\n");
  const result = convertFlowFenceToMermaid(input);
  assert.ok(result, "conversion should succeed");
  assert.ok(result.includes("st --> op"));
  assert.ok(!result.includes("|right|"));
});

test("seq fence: converts messages and notes", () => {
  const input = [
    "Student->DeepTutor: Ask for help",
    "Note right of DeepTutor: Collect memory\\nand context",
    "DeepTutor-->Student: Respond",
  ].join("\n");
  const result = convertSequenceFenceToMermaid(input);
  assert.ok(result, "conversion should succeed");
  assert.ok(result.startsWith("sequenceDiagram"));
  assert.ok(result.includes("Student->>DeepTutor: Ask for help"));
  assert.ok(result.includes("Collect memory<br/>and context"));
});
