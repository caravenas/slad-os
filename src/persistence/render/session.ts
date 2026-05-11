import { stringifyYaml } from "../yaml.js";
import type { SessionState } from "../../core/types.js";
import type { WriteContext } from "../index.js";

export function renderSession(value: SessionState, _ctx?: Partial<WriteContext>): string {
  const frontmatter = {
    kind: "session",
    schemaVersion: 1,
    sessionId: value.id,
    createdAt: value.createdAt,
    session: value,
  };

  const artifacts = value.artifacts.length
    ? value.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`)
    : ["- None"];

  const body = [
    `# Session ${value.id}`,
    "",
    "## Intent",
    value.intent,
    "",
    "## Current Phase",
    value.currentPhase ?? "none",
    "",
    "## Artifacts",
    ...artifacts,
    "",
  ].join("\n");

  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
