import { listSessions } from "./session.js";
import type { SessionState } from "./types.js";

export type ProjectStats = {
  sessions: number;
  runs: number;
  learnings: number;
};

export function computeStatsFromSessions(sessions: SessionState[]): ProjectStats {
  return sessions.reduce<ProjectStats>(
    (stats, session) => {
      stats.sessions += 1;
      for (const artifact of session.artifacts) {
        if (artifact.kind === "run") stats.runs += 1;
        if (artifact.kind === "learn") stats.learnings += 1;
      }
      return stats;
    },
    { sessions: 0, runs: 0, learnings: 0 },
  );
}

export function getProjectStats(cwd = process.cwd()): ProjectStats {
  return computeStatsFromSessions(listSessions(cwd));
}
