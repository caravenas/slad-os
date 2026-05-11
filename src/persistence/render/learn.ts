import { stringifyYaml } from "../yaml.js";
import type { LearnOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

function list(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

export function renderLearn(value: LearnOutput, ctx: WriteContext): string {
  const frontmatter = {
    kind: "learn",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    taskId: value.taskId,
    sourceRun: value.sourceRun,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    value,
  };

  const body = [
    `# ${value.wikiEntryTitle}`,
    "",
    `Source run: ${value.sourceRun}`,
    `Task: ${value.taskId}`,
    "",
    "## Summary",
    value.summary,
    "",
    "## Decisions",
    ...list(value.decisions),
    "",
    "## Errors / Blockers",
    ...list(value.errors),
    "",
    "## Patterns",
    ...list(value.patterns),
    "",
    "## Open Questions",
    ...list(value.openQuestions),
    "",
    "## Follow-ups",
    ...list(value.followUps),
    "",
  ].join("\n");

  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
