import kleur from "kleur";
import { getProjectStats, type ProjectStats } from "../core/stats.js";

type StatsCommandOptions = {
  json?: boolean;
};

function formatStats(stats: ProjectStats): string {
  const totalTokens = stats.budget.totalInputTokens + stats.budget.totalOutputTokens;
  const budgetLines =
    stats.budget.totalRuns > 0
      ? [
          "",
          kleur.bold("Budget history"),
          `  Auto runs: ${kleur.cyan(String(stats.budget.totalRuns))}`,
          `  Total tokens: ${kleur.cyan(totalTokens.toLocaleString())} (in: ${stats.budget.totalInputTokens.toLocaleString()}, out: ${stats.budget.totalOutputTokens.toLocaleString()})`,
          `  Estimated cost: ${kleur.cyan("$" + stats.budget.totalEstimatedCostUsd.toFixed(4))}`,
        ]
      : [];

  return [
    "",
    kleur.bold("Project stats"),
    `  Sessions: ${kleur.cyan(String(stats.sessions))}`,
    `  Runs: ${kleur.cyan(String(stats.runs))}`,
    `  Learnings: ${kleur.cyan(String(stats.learnings))}`,
    ...budgetLines,
  ].join("\n");
}

export async function statsCommand(opts: StatsCommandOptions = {}): Promise<void> {
  const stats = getProjectStats();

  if (opts.json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatStats(stats) + "\n");
}
