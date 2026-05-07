/**
 * hitl-auto-resolve.ts — Heuristics for auto-resolving HITL questions.
 *
 * In auto pipeline mode, some questions have obvious answers:
 * - confirm with default → use the default
 * - choice with a single option → use that option
 * - questions that match known patterns (approach selection, etc.)
 *
 * This module provides auto-resolvers per stage that the hitlLoop
 * tries BEFORE falling back to interactive HITL.
 */
import kleur from "kleur";
import type { Question } from "./types.js";
import type { HitlAwareOutput } from "./hitl-loop.js";
import { log } from "./logger.js";

/**
 * Generic auto-resolver: tries heuristics that apply to any stage.
 * Returns answers for questions it can resolve. Unresolved questions
 * get an empty object (caller falls through to interactive HITL).
 */
export function autoResolveGeneric(output: HitlAwareOutput): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const q of output.questions) {
    const resolved = tryResolve(q);
    if (resolved !== null) {
      answers[q.id] = resolved;
      log.dim(`  auto-resolve: ${q.id} → ${kleur.cyan(resolved)}`);
    }
  }

  return answers;
}

/**
 * Try to resolve a single question with heuristics.
 * Returns the answer string or null if it can't be resolved.
 */
function tryResolve(q: Question): string | null {
  // 1. Confirm with a default → use the default
  if (q.kind === "confirm" && q.default !== undefined) {
    return String(q.default);
  }

  // 2. Choice with only one option → use it
  if (q.kind === "choice" && q.choices && q.choices.length === 1) {
    return q.choices[0];
  }

  // 3. Choice with a default → use the default
  if (q.kind === "choice" && q.default !== undefined) {
    return String(q.default);
  }

  // 4. Non-blocking questions with a default → use the default
  if (!q.blocking && q.default !== undefined) {
    return String(q.default);
  }

  // 5. Free text with a default and non-blocking → use the default
  if (q.kind === "free" && !q.blocking && q.default !== undefined) {
    return String(q.default);
  }

  // Can't resolve — needs human input
  return null;
}

/**
 * Explore-specific auto-resolver.
 * Adds heuristics for approach selection.
 */
export function autoResolveExplore(output: HitlAwareOutput): Record<string, string> {
  const answers = autoResolveGeneric(output);

  for (const q of output.questions) {
    if (answers[q.id]) continue; // already resolved

    // Approach selection: if question ID suggests approach and has choices,
    // pick the first one (which is typically the recommended one)
    if (
      /approach|enfoque|strategy/i.test(q.id) &&
      q.kind === "choice" &&
      q.choices &&
      q.choices.length > 0
    ) {
      answers[q.id] = q.choices[0];
      log.dim(`  auto-resolve (explore): ${q.id} → ${kleur.cyan(q.choices[0])} (primer approach)`);
    }
  }

  return answers;
}

/**
 * Plan-specific auto-resolver.
 * Adds heuristics for task ordering, priority questions.
 */
export function autoResolvePlan(output: HitlAwareOutput): Record<string, string> {
  const answers = autoResolveGeneric(output);

  for (const q of output.questions) {
    if (answers[q.id]) continue;

    // Priority/ordering: use default ranking if provided
    if (q.kind === "ranking" && q.choices && q.choices.length > 0 && q.default) {
      answers[q.id] = String(q.default);
      log.dim(`  auto-resolve (plan): ${q.id} → default ranking`);
    }
  }

  return answers;
}
