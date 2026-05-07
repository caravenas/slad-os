import { parseYaml } from "../yaml.js";
import { extractSection, extractBulletSection } from "../sections.js";
import { RunOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import type { ParseResult } from "../index.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function parseRun(text: string, sourcePath?: string): ParseResult<RunOutput> {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    throw new ParseError("missing or malformed frontmatter", { path: sourcePath, phase: "yaml" });
  }
  const [, yamlBlock, body] = match;

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlBlock) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError("invalid YAML in frontmatter", {
      path: sourcePath,
      phase: "yaml",
      cause: err,
    });
  }

  const warnings: string[] = [];

  const summary = extractSection(body, "## Summary");
  if (summary === undefined) warnings.push("missing '## Summary' section");

  const reviewerNotes = extractBulletSection(body, "## Reviewer Notes");
  const followUps = extractBulletSection(body, "## Follow-ups");

  // Reconstruct shape expected by RunOutput Zod schema
  const candidate = {
    taskId: frontmatter.taskId,
    status: frontmatter.status,
    summary: summary ?? "",
    changedFiles: frontmatter.changedFiles ?? [],
    verification: frontmatter.verification ?? [],
    reviewerNotes,
    followUps,
    questions: frontmatter.questions ?? [],
    humanAnswers: frontmatter.humanAnswers ?? {},
  };

  const parsed = RunOutput.safeParse(candidate);
  if (!parsed.success) {
    throw new ParseError("RunOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }

  return { value: parsed.data, warnings };
}
