import test from "node:test";
import assert from "node:assert/strict";
import katex from "katex";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { hasBareMathSeed, wrapBareMathRuns } from "../lib/bare-math";

// Real corpus forms, taken from local chat_history.db (264 bare-math samples):
// the dominant shape is a single-letter subscript (`P_t`) mixed with Unicode
// math characters (`∫₀^∞ u²e^(−u)du`).

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

test("bare math: single-letter subscripts are wrapped", () => {
  assert.equal(wrapBareMathRuns("P_t"), "$P_t$");
  assert.equal(wrapBareMathRuns("E_y"), "$E_y$");
  assert.equal(wrapBareMathRuns("K_w"), "$K_w$");
  assert.equal(wrapBareMathRuns("q_enc"), "$q_enc$");
});

test("bare math: a run carries the whole expression around its seed", () => {
  assert.equal(wrapBareMathRuns("∫₀^∞ u²e^(−u)du"), "$∫₀^∞ u²e^{−u}du$");
  assert.equal(
    wrapBareMathRuns("Σ_{k=t}^{m}(P_{k+1}−P_k)"),
    "$Σ_{k=t}^{m}(P_{k+1}−P_k)$",
  );
  assert.equal(wrapBareMathRuns("lim_{Vᵢ→0}"), "$lim_{Vᵢ→0}$");
  assert.equal(
    wrapBareMathRuns("Δw_t ∝ P_{t+1} − P_t"),
    "$Δw_t ∝ P_{t+1} − P_t$",
  );
});

test("bare math: prose around the formula stays prose", () => {
  assert.equal(wrapBareMathRuns("所以 P_t = 1 成立"), "所以 $P_t = 1$ 成立");
  assert.equal(
    wrapBareMathRuns("由 lim_{Vᵢ→0} 可知，Σ_{k=t}^{m}(P_{k+1}−P_k) 收敛。"),
    "由 $lim_{Vᵢ→0}$ 可知，$Σ_{k=t}^{m}(P_{k+1}−P_k)$ 收敛。",
  );
  assert.equal(wrapBareMathRuns("\\frac{1}{2} 与 P_t"), "$\\frac{1}{2}$ 与 $P_t$");
});

test("bare math: parenthesised exponents are braced, bold markers stripped", () => {
  assert.equal(wrapBareMathRuns("ρ(r) = Ce^(−2r/a₀)"), "$ρ(r) = Ce^{−2r/a₀}$");
  assert.equal(wrapBareMathRuns("∫_Ref^P **E**·d**l**"), "$∫_Ref^P E·dl$");
});

test("bare math: a run never crosses a line break", () => {
  assert.equal(wrapBareMathRuns("P_t\nE_y"), "$P_t$\n$E_y$");
});

test("bare math: a caret allows a multi-letter base", () => {
  assert.equal(hasBareMathSeed("E = mc^2"), true);
  assert.equal(wrapBareMathRuns("E = mc^2"), "$E = mc^2$");
});

test("bare math: bracketed groups stay inside one run", () => {
  const result = wrapBareMathRuns("K_w = [H⁺][OH⁻] = 1.0×10⁻¹⁴ M²");

  assert.equal(result, "$K_w = [H⁺][OH⁻] = 1.0×10⁻¹⁴ M²$");
  assert.equal(result.split("$").length, 3, "a single span");
});

test("bare math: markdown links keep their text and brackets intact", () => {
  const input = "详见 [文档](https://a.io/x) 说明 P_t";
  const result = wrapBareMathRuns(input);

  assert.equal(result, "详见 [文档](https://a.io/x) 说明 $P_t$");
  assert.ok(result.includes("[文档](https://a.io/x)"), "link untouched");

  // A formula inside the link text is wrapped without pulling the link apart.
  assert.equal(
    wrapBareMathRuns("详见 [P_t 文档](https://a.io/x) 说明"),
    "详见 [$P_t$ 文档](https://a.io/x) 说明",
  );
  assert.equal(
    wrapBareMathRuns("详见 [文档 P_t](https://a.io/x) 说明"),
    "详见 [文档 $P_t$](https://a.io/x) 说明",
  );
  assert.equal(
    wrapBareMathRuns("详见 [P_t](https://a.io/x) 说明"),
    "详见 [$P_t$](https://a.io/x) 说明",
  );
});

// ---------------------------------------------------------------------------
// Every emitted span has to render (reviewer blocker B1)
// ---------------------------------------------------------------------------

test("bare math: a dangling script retreats to a renderable boundary", () => {
  const input = "所以 Φ_闭合 = Φ_壳 + Φ_底 = 0 [p.32]；";
  const result = wrapBareMathRuns(input);

  const spans = wrappedSpans(result);
  assert.ok(spans.length > 0, "the symbols are still wrapped");
  for (const span of spans) {
    assert.ok(!/[_^\\]$/.test(span), `span ends on a dangling token: ${span}`);
  }
  assert.ok(!result.includes("Φ_$"), "no span swallows the subscript underscore");
});

test("bare math: unbalanced groups and loose combining marks are dropped", () => {
  // An unclosed `(` means the run is not a formula: nothing is wrapped.
  assert.equal(wrapBareMathRuns("P_t=(x + 1"), "P_t=(x + 1");
  assert.equal(wrapBareMathRuns("P_t={a + 1"), "P_t={a + 1");
  // A run that simply stops before the bracket is still a valid span.
  assert.equal(wrapBareMathRuns("P_t (x + 1"), "$P_t$ (x + 1");

  // A footnote marker only costs the bracket, not the symbol in front of it.
  assert.equal(wrapBareMathRuns("P_t[^1]"), "$P_t$[^1]");

  // A combining mark cannot start or join a run; a marked letter is untouched.
  const loose = "P_t \u0304 的值";
  assert.equal(wrapBareMathRuns(loose), "$P_t$ \u0304 的值");
  assert.ok(!wrappedSpans(wrapBareMathRuns(loose)).some((s) => s.startsWith("\u0304")));
  assert.equal(wrapBareMathRuns("x\u0304_t"), "x\u0304_t");
});

test("bare math: a marked letter inside a formula stays in one span", () => {
  assert.equal(
    wrapBareMathRuns("kurtosis = [Σ(xᵢ − x̄)⁴/n] / s⁴ − 3"),
    "kurtosis $= [Σ(xᵢ − x̄)⁴/n] / s⁴ − 3$",
  );
});

test("bare math: every emitted span from messy input renders in KaTeX", () => {
  const messy = [
    "所以 Φ_闭合 = Φ_壳 + Φ_底 = 0 [p.32]；",
    "Φ = Σq_",
    "Φ = q_",
    "Σ_{k=t}^{m}(P_{k+1}−P_k)",
    "lim_{Vᵢ→0}",
    "∫₀^∞ u²e^(−u)du",
    "Δw_t ∝ P_{t+1} − P_t",
    "ρ(r) = Ce^(−2r/a₀)",
    "K_w = [H⁺][OH⁻] = 1.0×10⁻¹⁴ M²",
    "E = mc^2",
    "Σ(xᵢ − c)² ⋯",
    "kurtosis = [Σ(xᵢ − x̄)⁴/n] / s⁴ − 3",
    "P_t = (x + 1",
    "P_t[^1]",
    "x^2 + y^2 = r^2",
    "∂C/∂t = D∇²C",
    "∂²u/∂x²",
    "K_w = [H⁺][OH⁻]",
    "P_",
    "x^",
    "∂",
  ];

  let spans = 0;
  for (const line of messy) {
    for (const span of wrappedSpans(wrapBareMathRuns(line))) {
      spans += 1;
      assert.doesNotThrow(
        () => katex.renderToString(span, { throwOnError: true, strict: false }),
        `KaTeX rejected ${JSON.stringify(span)} (from ${JSON.stringify(line)})`,
      );
    }
  }
  assert.ok(spans >= 15, `expected a decent sample of spans, got ${spans}`);
});

// ---------------------------------------------------------------------------
// Block structure stays markdown (reviewer blocker B2)
// ---------------------------------------------------------------------------

test("bare math: list items and block quotes keep their marker", () => {
  assert.equal(wrapBareMathRuns("- P_t = 1"), "- $P_t = 1$");
  assert.equal(wrapBareMathRuns("- E_y 的定义"), "- $E_y$ 的定义");
  assert.equal(wrapBareMathRuns("+ x_t 与 y_t"), "+ $x_t$ 与 $y_t$");
  assert.equal(wrapBareMathRuns("> P_t = 1"), "> $P_t = 1$");
  assert.equal(wrapBareMathRuns("  - P_t = 1"), "  - $P_t = 1$");
  assert.equal(wrapBareMathRuns("1. P_t = 1"), "1. $P_t = 1$");
  assert.equal(wrapBareMathRuns("  1. x^2 检验"), "  1. $x^2$ 检验");

  // A block shape whose marker cannot be measured exactly is left alone, while
  // a paragraph that merely starts with a number is still wrapped.
  assert.equal(wrapBareMathRuns(">quote P_t = 1"), ">quote P_t = 1");
  assert.equal(wrapBareMathRuns("3.14 是圆周率 P_t = 1"), "3.14 是圆周率 $P_t = 1$");

  // The list shape survives, and so does the line the reviewer caught.
  const broken = "- g₁ > 0: right (positive) skew";
  const wrapped = wrapBareMathRuns(broken);
  assert.ok(wrapped.startsWith("- "), "the marker stays a marker");
  assert.ok(wrapped.includes("$"), "the formula inside the item is wrapped");

  const md = unified().use(remarkParse).use(remarkGfm);
  const shape = (text: string) => {
    let lists = 0;
    let items = 0;
    let quotes = 0;
    const walk = (node: { type: string; children?: unknown[] }) => {
      if (node.type === "list") lists += 1;
      if (node.type === "listItem") items += 1;
      if (node.type === "blockquote") quotes += 1;
      for (const child of (node.children ?? []) as never[]) walk(child);
    };
    walk(md.parse(text) as never);
    return { lists, items, quotes };
  };

  const raw = `${broken}\n\n- P_t = 1\n\n> E_y 的定义\n`;
  assert.deepEqual(shape(wrapBareMathRuns(raw)), shape(raw));
});

// ---------------------------------------------------------------------------
// Loose symbols and prose no longer seed (reviewer S3)
// ---------------------------------------------------------------------------

test("bare math: prose arrows and name dots are not math", () => {
  const arrow = "descriptive stats → probability";
  const dot = "阿尔伯特·爱因斯坦";

  assert.equal(wrapBareMathRuns(arrow), arrow);
  assert.equal(wrapBareMathRuns(dot), dot);
  assert.equal(hasBareMathSeed(dot), false);

  // …but against a formula the same symbol belongs to it.
  assert.equal(wrapBareMathRuns("P_t→E_y"), "$P_t→E_y$");
  assert.equal(wrapBareMathRuns("Σ(xᵢ − c)² ⋯"), "$Σ(xᵢ − c)² ⋯$");
});

test("bare math: a bridge never crosses a clause mark", () => {
  assert.equal(wrapBareMathRuns("P_t = 1 ; x^2 = 4"), "$P_t = 1$ ; $x^2 = 4$");
  assert.equal(wrapBareMathRuns("P_t = 1, 见 x^2 = 4"), "$P_t = 1,$ 见 $x^2 = 4$");
});

test("bare math: bold prose is not swallowed into a span", () => {
  const input = "**μ** (mean), **σ²** (variance), **ρ**";
  const result = wrapBareMathRuns(input);

  assert.equal(result, "**$μ$** (mean), **$σ²$** (variance), **$ρ$**");
  for (const span of wrappedSpans(result)) {
    assert.ok(!/[A-Za-z]{2,}/.test(span), `prose inside a span: ${span}`);
  }

  // Emphasized math inside a formula is still traversed.
  assert.equal(wrapBareMathRuns("∫_Ref^P **E**·d**l**"), "$∫_Ref^P E·dl$");
});

// ---------------------------------------------------------------------------
// HTML and stray `$$` (reviewer S4)
// ---------------------------------------------------------------------------

test("bare math: inline HTML stays outside the span", () => {
  assert.equal(wrapBareMathRuns("<b>P_t</b>"), "<b>$P_t$</b>");
  assert.equal(wrapBareMathRuns("<span class=\"x\">E_y</span>"), "<span class=\"x\">$E_y$</span>");
});

test("bare math: a mid-line $$ does not open display math", () => {
  assert.equal(wrapBareMathRuns("text $$ more"), "text $$ more");
  assert.equal(wrapBareMathRuns("P_t = 1 and $$ left alone"), "$P_t = 1$ and $$ left alone");
  assert.equal(wrapBareMathRuns("$$\nP_t = 1\n$$"), "$$\nP_t = 1\n$$");
});

test("bare math: a mid-line $$ block keeps its body intact", () => {
  const cases = [
    "- 质能方程：$$E = mc^2$$ 说明",
    "> $$P_t = 1$$",
    "所以 $$E = mc^2$$ 成立",
    "| $$E=mc^2$$ | 值 |",
    "> $$L(p_{k+1})-L(p_k)\\ \\ge\\ L(p_k)-L(p_{k-1}).$$",
  ];

  for (const line of cases) {
    assert.equal(wrapBareMathRuns(line), line, `${line} must stay verbatim`);
  }

  // The body must not be wrapped a second time: every math node of the parsed
  // result still renders, so no `$...$` sits inside the display block.
  const md = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  for (const line of cases) {
    const tree = md.parse(wrapBareMathRuns(line));
    const values = mathNodeValues(tree);
    for (const value of values) {
      assert.doesNotThrow(
        () =>
          katex.renderToString(value, { throwOnError: true, strict: false }),
        `KaTeX rejected ${JSON.stringify(value)} (from ${line})`,
      );
    }
  }
});

test("bare math: existing math regions are left alone", () => {
  assert.equal(wrapBareMathRuns("设 $P_t$ 已知"), "设 $P_t$ 已知");
  assert.equal(wrapBareMathRuns("$$P_t$$ 文字"), "$$P_t$$ 文字");
  assert.equal(wrapBareMathRuns("$$\nP_t = 1\n$$"), "$$\nP_t = 1\n$$");
});

test("bare math: a table row keeps its pipes and its structure", () => {
  assert.equal(
    wrapBareMathRuns("| 下一步的预测 P_{t+1} |"),
    "| 下一步的预测 $P_{t+1}$ |",
  );

  const row = "| 下一步的预测 P_{t+1} | 说明 |";
  const wrapped = wrapBareMathRuns(row);
  assert.equal(wrapped, "| 下一步的预测 $P_{t+1}$ | 说明 |");
  assert.equal((wrapped.match(/\|/g) ?? []).length, 3);
});

test("bare math: identifiers, prices, code and urls are not math", () => {
  for (const line of [
    "**ring_field_setup.png**",
    "**pK_combined = 6.1**",
    "Tickets cost $5 and $10",
    "行内代码 `P_t = 1` 保持",
    "见 https://a.io/x_y 文档",
    "snake_case 名词",
    "版本 v1.2.3 发布",
    "含义 P(N) 表示",
  ]) {
    assert.equal(wrapBareMathRuns(line), line);
  }
});

// ---------------------------------------------------------------------------
// Seed detection (renderer routing)
// ---------------------------------------------------------------------------

test("hasBareMathSeed: bare formulas route to the rich renderer", () => {
  assert.equal(hasBareMathSeed("P_t"), true);
  assert.equal(hasBareMathSeed("∫₀^∞ u²e^(−u)du"), true);
  assert.equal(hasBareMathSeed("由 lim_{Vᵢ→0} 可知"), true);
  assert.equal(hasBareMathSeed("\\frac{1}{2}"), true);
  assert.equal(hasBareMathSeed("x^{2}"), true);
});

test("hasBareMathSeed: prose, identifiers and prices stay on the plain renderer", () => {
  assert.equal(hasBareMathSeed(""), false);
  assert.equal(hasBareMathSeed("snake_case 名词"), false);
  assert.equal(hasBareMathSeed("**pK_combined = 6.1**"), false);
  assert.equal(hasBareMathSeed("Tickets cost $5 and $10"), false);
  assert.equal(hasBareMathSeed("普通文本，没有任何公式"), false);
});

// ---------------------------------------------------------------------------
// KaTeX spot check on real corpus samples
// ---------------------------------------------------------------------------

const WRAPPED_SPAN = /(?<![$\\])\$(?![$\s])(?:\\.|[^$\n])*?(?<!\s)\$(?!\$)/g;

function wrappedSpans(text: string): string[] {
  return [...text.matchAll(WRAPPED_SPAN)].map((match) => match[0].slice(1, -1));
}

/** Values of every `math` / `inlineMath` node of a remark tree. */
function mathNodeValues(node: { type: string; value?: string; children?: unknown[] }): string[] {
  const values =
    (node.type === "math" || node.type === "inlineMath") && node.value
      ? [node.value]
      : [];
  for (const child of (node.children ?? []) as never[]) {
    values.push(...mathNodeValues(child));
  }
  return values;
}

test("bare math: every wrapped corpus formula renders in KaTeX", () => {
  const corpus = [
    "P_t",
    "q_enc",
    "∫₀^∞ u²e^(−u)du",
    "Σ_{k=t}^{m}(P_{k+1}−P_k)",
    "lim_{Vᵢ→0}",
    "Δw_t ∝ P_{t+1} − P_t",
    "ρ(r) = Ce^(−2r/a₀)",
    "K_w = [H⁺][OH⁻] = 1.0×10⁻¹⁴ M²",
    "∫_Ref^P **E**·d**l**",
    "所以 P_t = 1 成立",
  ];

  const spans = corpus.flatMap((input) => wrappedSpans(wrapBareMathRuns(input)));
  assert.ok(spans.length >= 5, `expected several wrapped spans, got ${spans.length}`);

  for (const span of spans) {
    assert.doesNotThrow(
      () => katex.renderToString(span, { throwOnError: true, strict: false }),
      `KaTeX rejected ${JSON.stringify(span)}`,
    );
  }
});
