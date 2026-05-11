import { stringifyYaml } from "../yaml.js";
import type { EvolveOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

function list(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

export function renderEvolve(value: EvolveOutput, ctx: WriteContext): string {
  const frontmatter = {
    kind: "evolve",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    value,
  };

  const updates = value.proposedUpdates.length
    ? value.proposedUpdates.flatMap((update) => [
        `### ${update.target}`,
        `Change: ${update.changeType}`,
        `Rationale: ${update.rationale}`,
        "",
        "```markdown",
        update.content,
        "```",
        "",
      ])
    : ["None"];

  const body = [
    `# ${value.title}`,
    "",
    "## Summary",
    value.summary,
    "",
    "## Proposed Updates",
    ...updates,
    "## Pattern Updates",
    ...list(value.patternUpdates),
    "",
    "## Snapshot Updates",
    ...list(value.snapshotUpdates),
    "",
    "## Next Actions",
    ...list(value.nextActions),
    "",
  ].join("\n");

  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
