import kleur from "kleur";
import { getProjectStats, type ProjectStats } from "../core/stats.js";

type StatsCommandOptions = {
  json?: boolean;
};

function formatStats(stats: ProjectStats): string {
  return [
    "",
    kleur.bold("Project stats"),
    `  Sessions: ${kleur.cyan(String(stats.sessions))}`,
    `  Runs: ${kleur.cyan(String(stats.runs))}`,
    `  Learnings: ${kleur.cyan(String(stats.learnings))}`,
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
