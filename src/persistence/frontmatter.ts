import { ParseError } from "../core/errors.js";
import { parseYaml } from "./yaml.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface FrontmatterDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string, sourcePath?: string): FrontmatterDocument {
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    throw new ParseError("missing or malformed frontmatter", { path: sourcePath, phase: "yaml" });
  }

  try {
    return {
      frontmatter: parseYaml(match[1]) as Record<string, unknown>,
      body: match[2],
    };
  } catch (err) {
    throw new ParseError("invalid YAML in frontmatter", {
      path: sourcePath,
      phase: "yaml",
      cause: err,
    });
  }
}
