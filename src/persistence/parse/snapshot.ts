import { SnapshotOutput } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";

export function parseSnapshot(text: string, sourcePath?: string): ParseResult<SnapshotOutput> {
  const { frontmatter, body } = parseFrontmatter(text, sourcePath);
  const parsed = SnapshotOutput.safeParse({
    status: frontmatter.status,
    content: body.trim(),
    questions: frontmatter.questions ?? [],
  });
  if (!parsed.success) {
    throw new ParseError("SnapshotOutput failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}
