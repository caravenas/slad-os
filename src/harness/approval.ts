import { confirm } from "@inquirer/prompts";
import kleur from "kleur";
import type { CommandClassification } from "./types.js";

/**
 * Interactively asks the user to approve a dangerous action.
 * Returns true if approved, false if rejected.
 */
export async function confirmDangerousAction(
  taskId: string,
  classifications: CommandClassification[],
): Promise<boolean> {
  const dangerous = classifications.filter((c) => c.level === "full");
  if (dangerous.length === 0) return true;

  console.log("");
  console.log(kleur.bold().red(`⚠ ${taskId} · Acción de alto riesgo detectada`));
  for (const c of dangerous) {
    console.log(kleur.red(`  ● ${c.reason}: `) + kleur.dim(c.original));
  }
  console.log("");

  return confirm({
    message: `¿Autorizás la ejecución de ${dangerous.length} acción(es) de nivel Full?`,
    default: false,
  });
}
