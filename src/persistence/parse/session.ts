import { DiscoveryResult, SessionState } from "../../core/types.js";
import { ParseError } from "../../core/errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { ParseResult } from "../index.js";
import type { DiscoveryResult as DiscoveryResultType } from "../../core/types.js";

export function parseSession(text: string, sourcePath?: string): ParseResult<SessionState> {
  const { frontmatter } = parseFrontmatter(text, sourcePath);
  const parsed = SessionState.safeParse(frontmatter.session ?? frontmatter);
  if (!parsed.success) {
    throw new ParseError("SessionState failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return { value: parsed.data, warnings: [] };
}

export function parseCliDiscoveryArtifact(
  text: string,
  sourcePath?: string,
): DiscoveryResultType {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    const { frontmatter } = parseFrontmatter(text, sourcePath);
    candidate = frontmatter.discovery ?? frontmatter.value ?? frontmatter;
  }

  const parsed = DiscoveryResult.safeParse(candidate);
  if (!parsed.success) {
    throw new ParseError("DiscoveryResult failed Zod validation", {
      path: sourcePath,
      phase: "zod",
      cause: parsed.error,
    });
  }
  return parsed.data;
}
