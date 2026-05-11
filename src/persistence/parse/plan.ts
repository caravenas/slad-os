import { PlanOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";

export function parsePlan(text: string, sourcePath?: string): ParseResult<PlanOutput> {
  const { frontmatter } = parseFrontmatter(text, sourcePath);
  const parsed = PlanOutput.safeParse(frontmatter.value ?? frontmatter);
  if (!parsed.success) {
    throw new ParseError("PlanOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}
