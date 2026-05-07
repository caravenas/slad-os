import { stringifyYaml } from "../yaml.js";
import type { RunOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

export function renderRun(value: RunOutput, ctx: WriteContext): string {
  const frontmatter: Record<string, unknown> = {
    kind: "run",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    taskId: value.taskId,
    status: value.status,
    changedFiles: value.changedFiles,
    verification: value.verification,
    humanAnswers: value.humanAnswers,
    plannedTask: `[[plans/${ctx.sessionId}/${value.taskId}]]`,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
  };

  // Only include questions if non-empty
  if (value.questions.length > 0) {
    frontmatter.questions = value.questions;
  }

  const yamlBlock = stringifyYaml(frontmatter);

  const bodyParts: string[] = [
    `# Run ${value.taskId}`,
    "",
    "## Summary",
    value.summary,
    "",
    "## Reviewer Notes",
    ...value.reviewerNotes.map((n) => `- ${n}`),
    "",
    "## Follow-ups",
    ...value.followUps.map((f) => `- ${f}`),
    "",
  ];

  const body = bodyParts.join("\n");

  return `---\n${yamlBlock}---\n\n${body}`;
}
