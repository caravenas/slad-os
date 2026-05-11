import { EvolveOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";

export function parseEvolve(text: string, sourcePath?: string): ParseResult<EvolveOutput> {
  const { frontmatter } = parseFrontmatter(text, sourcePath);
  const parsed = EvolveOutput.safeParse(frontmatter.value ?? frontmatter);
  if (!parsed.success) {
    throw new ParseError("EvolveOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}
