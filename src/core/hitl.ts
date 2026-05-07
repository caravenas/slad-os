import { input, select, confirm } from "@inquirer/prompts";
import kleur from "kleur";
import type { Question } from "./types.js";

export async function askQuestion(q: Question): Promise<string> {
  const header = q.context ? `${q.prompt}\n  (${q.context})` : q.prompt;
  switch (q.kind) {
    case "free":
      return input({ message: header, default: q.default });
    case "choice": {
      const choices = (q.choices ?? []).map((c) => ({ name: c, value: c }));
      return select({ message: header, choices, default: q.default });
    }
    case "confirm": {
      const answer = await confirm({ message: header, default: q.default !== "no" });
      return answer ? "yes" : "no";
    }
    case "ranking": {
      const items = q.choices ?? [];
      if (items.length === 0) return input({ message: header, default: q.default });
      return input({
        message: `${header}\nOpciones: ${items.join(", ")}\nIngresá el orden separado por comas:`,
        default: q.default ?? items.join(", "),
      });
    }
  }
}

export async function collectAnswers(questions: Question[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    console.log("");
    answers[q.id] = await askQuestion(q);
  }
  return answers;
}

export function formatAnswersForPrompt(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value}`);
  return `Respuestas del humano:\n${lines.join("\n")}\n\nContinuá la tarea con esta información. Respondé ÚNICAMENTE con el JSON de output según el schema esperado, sin texto adicional.`;
}

export function printHitlHeader(label: string, summary: string, round: number, maxRounds: number): void {
  console.log("");
  console.log(
    kleur.bold().yellow(`⟳ ${label} necesita tu input`) +
      kleur.dim(` (round ${round}/${maxRounds})`),
  );
  if (summary) console.log(kleur.dim(`  ${summary}`));
}
