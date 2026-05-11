import { ExploreOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";

export function parseExplore(text: string, sourcePath?: string): ParseResult<ExploreOutput> {
  const { frontmatter } = parseFrontmatter(text, sourcePath);
  const parsed = ExploreOutput.safeParse(frontmatter.value ?? frontmatter);
  if (!parsed.success) {
    throw new ParseError("ExploreOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}
