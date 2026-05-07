import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderRun } from "./render/run.js";
import { parseRun } from "./parse/run.js";
import { ParseError } from "../core/errors.js";
import { resetDocsRootCache } from "./layout.js";
import type { RunOutput } from "../core/types.js";

const BASE_CTX = { sessionId: "2026-05-06_test-session", createdAt: "2026-05-06T12:00:00.000Z" };

function makeRunOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    taskId: "T1",
    status: "completed",
    summary: "Implemented the cache key generator with userId salt.",
    changedFiles: ["src/cache/store.ts", "src/cache/keys.ts"],
    verification: [
      { command: "npm test", status: "passed", notes: "" },
      { command: "npm run typecheck", status: "passed", notes: "No errors" },
    ],
    reviewerNotes: ["Verified no collisions with existing cache entries", "No performance regression"],
    followUps: ["Consider adding TTL-based eviction", "Document the new salt format"],
    questions: [],
    humanAnswers: {},
    ...overrides,
  };
}

describe("persistence/run", () => {
  beforeEach(() => {
    resetDocsRootCache();
  });

  // ── Test 1: Roundtrip happy-path ──────────────────────────────────────────

  it("1. roundtrip happy-path: render → parse → deep-equal", () => {
    const original = makeRunOutput();
    const rendered = renderRun(original, BASE_CTX);
    const { value, warnings } = parseRun(rendered);

    assert.deepEqual(value, original);
    assert.equal(warnings.length, 0);
  });

  // ── Test 2: Roundtrip con campos opcionales vacíos ────────────────────────

  it("2. roundtrip con campos opcionales vacíos", () => {
    const original = makeRunOutput({
      reviewerNotes: [],
      followUps: [],
      questions: [],
      humanAnswers: {},
      changedFiles: [],
      verification: [],
    });
    const rendered = renderRun(original, BASE_CTX);
    const { value, warnings } = parseRun(rendered);

    assert.deepEqual(value, original);
    assert.equal(warnings.length, 0);
  });

  // ── Test 3: Tolerancia — body sin ## Summary ──────────────────────────────

  it("3. tolerancia: body sin ## Summary → warning emitido, summary = ''", () => {
    const original = makeRunOutput();
    const rendered = renderRun(original, BASE_CTX);
    // Strip the Summary section
    const stripped = rendered.replace("## Summary\n" + original.summary + "\n", "");
    const { value, warnings } = parseRun(stripped);

    assert.equal(value.summary, "");
    assert.ok(warnings.some((w) => w.includes("## Summary")));
  });

  // ── Test 4: Tolerancia — bullets con espacios extras ─────────────────────

  it("4. tolerancia: bullets con espacios extras se parsean preservando espacios internos", () => {
    const original = makeRunOutput({ reviewerNotes: [] });
    const rendered = renderRun(original, BASE_CTX);
    // Inject bullets with extra leading space after dash
    const withExtraSpaces = rendered.replace(
      "## Reviewer Notes\n",
      "## Reviewer Notes\n-   item con   espacios\n",
    );
    const { value } = parseRun(withExtraSpaces);

    assert.deepEqual(value.reviewerNotes, ["item con   espacios"]);
  });

  // ── Test 5: Falla — frontmatter ausente ──────────────────────────────────

  it("5. falla: frontmatter ausente → ParseError con phase=yaml", () => {
    const badText = "# Run T1\n\nSin frontmatter aquí.";
    assert.throws(
      () => parseRun(badText, "/fake/path.md"),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "yaml");
        assert.equal(err.path, "/fake/path.md");
        return true;
      },
    );
  });

  // ── Test 6: Falla — YAML malformado ──────────────────────────────────────

  it("6. falla: YAML malformado → ParseError con phase=yaml", () => {
    const badYaml = "---\nkind: run\n  bad: indent: broken:\n---\n\n# Run T1\n";
    assert.throws(
      () => parseRun(badYaml),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "yaml");
        return true;
      },
    );
  });

  // ── Test 7: Falla — status inválido → ParseError zod ─────────────────────

  it("7. falla: status con valor inválido → ParseError con phase=zod", () => {
    // Build a valid MD, then corrupt the status in frontmatter
    const original = makeRunOutput();
    const rendered = renderRun(original, BASE_CTX);
    // The RunOutput.status transform maps unknown values to "not_run" (verification),
    // but RunOutput.status is a strict enum: completed|blocked|failed|awaiting_human
    // Replace "status: completed" with an invalid value
    const corrupted = rendered.replace("status: completed", "status: invalid_value_xyz");
    assert.throws(
      () => parseRun(corrupted),
      (err: unknown) => {
        assert.ok(err instanceof ParseError);
        assert.equal(err.phase, "zod");
        return true;
      },
    );
  });

  // ── Test 8: Render — verification vacío produce array en frontmatter ──────

  it("8. render: verification: [] produce verification: [] en frontmatter (no omitido)", () => {
    const original = makeRunOutput({ verification: [] });
    const rendered = renderRun(original, BASE_CTX);

    assert.ok(rendered.includes("verification: []"), `Expected 'verification: []' in:\n${rendered}`);
  });

  // ── Test 9: Idempotencia del render ───────────────────────────────────────

  it("9. idempotencia: render(parse(render(x))) === render(x)", () => {
    const original = makeRunOutput();
    const firstRender = renderRun(original, BASE_CTX);
    const parsed = parseRun(firstRender).value;
    const secondRender = renderRun(parsed, BASE_CTX);

    assert.equal(secondRender, firstRender);
  });
});
