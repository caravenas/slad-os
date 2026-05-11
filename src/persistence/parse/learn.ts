import { LearnOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";

export function parseLearn(text: string, sourcePath?: string): ParseResult<LearnOutput> {
  const { frontmatter } = parseFrontmatter(text, sourcePath);
  const parsed = LearnOutput.safeParse(frontmatter.value ?? frontmatter);
  if (!parsed.success) {
    throw new ParseError("LearnOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}
