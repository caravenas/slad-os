import fs from "node:fs";
import path from "node:path";
import type { BudgetState } from "../context/types.js";

export type PipelineStage = "explore" | "snapshot" | "plan" | "run" | "learn";

export interface AutoCheckpoint {
  intent: string;
  sessionId: string;
  lastStageCompleted: PipelineStage;
  artifacts: Record<string, string>;
  budgetState: BudgetState;
  savedAt: string;
}

function checkpointPath(cwd: string): string {
  return path.join(cwd, ".slad-os", "auto-checkpoint.json");
}

export function saveAutoCheckpoint(cp: AutoCheckpoint, cwd = process.cwd()): void {
  const filePath = checkpointPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cp, null, 2), "utf8");
}

export function loadAutoCheckpoint(cwd = process.cwd()): AutoCheckpoint | null {
  const filePath = checkpointPath(cwd);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AutoCheckpoint;
  } catch {
    return null;
  }
}

export function clearAutoCheckpoint(cwd = process.cwd()): void {
  const filePath = checkpointPath(cwd);
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
}
