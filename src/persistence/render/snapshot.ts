import { stringifyYaml } from "../yaml.js";
import type { SnapshotOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

export function renderSnapshot(value: SnapshotOutput, ctx: WriteContext): string {
  const frontmatter = {
    kind: "snapshot",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    status: value.status,
    questions: value.questions,
  };

  const body = value.content.trim() || "# Snapshot\n";
  return `---\n${stringifyYaml(frontmatter)}---\n\n${body.trim()}\n`;
}
