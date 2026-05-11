import { stringifyYaml } from "../yaml.js";
import type { PlanOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

function list(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

export function renderPlan(value: PlanOutput, ctx: WriteContext): string {
  const frontmatter = {
    kind: "plan",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    value,
  };

  const body = [
    `# Plan ${ctx.sessionId}`,
    "",
    "## Summary",
    value.summary,
    "",
    "## Tasks",
    ...value.tasks.flatMap((task) => [
      `### ${task.id}. ${task.title}`,
      task.description,
      "",
      `Type: ${task.type}`,
      `Priority: ${task.priority}`,
      `Depends on: ${task.dependsOn.length ? task.dependsOn.join(", ") : "none"}`,
      "",
      "Files:",
      ...list(task.files),
      "",
      "Acceptance criteria:",
      ...list(task.acceptanceCriteria),
      "",
    ]),
    "## Verification",
    ...list(value.verification),
    "",
    "## Risks",
    ...list(value.risks),
    "",
    "## Open Questions",
    ...list(value.openQuestions),
    "",
  ].join("\n");

  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
