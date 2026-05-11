import { stringifyYaml } from "../yaml.js";
import type { ExploreOutput } from "../../core/types.js";
import type { WriteContext } from "../index.js";

function list(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None"];
}

export function renderExplore(value: ExploreOutput, ctx: WriteContext): string {
  const frontmatter = {
    kind: "explore",
    schemaVersion: 1,
    sessionId: ctx.sessionId,
    createdAt: ctx.createdAt ?? new Date().toISOString(),
    value,
  };

  const body = [
    `# Explore ${ctx.sessionId}`,
    "",
    "## Intent",
    value.intent,
    "",
    "## Reframing",
    value.reframing,
    "",
    "## Approaches",
    ...value.approaches.flatMap((approach) => [
      `### ${approach.name}`,
      approach.summary,
      "",
      "Pros:",
      ...list(approach.pros),
      "",
      "Cons:",
      ...list(approach.cons),
      "",
    ]),
    "## Risks",
    ...list(value.risks),
    "",
    "## Open Questions",
    ...list(value.openQuestions),
    "",
    "## Recommended Next",
    value.recommendedNext,
    "",
  ].join("\n");

  return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
}
