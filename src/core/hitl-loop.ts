/**
 * hitl-loop.ts — Generic HITL loop for the auto pipeline.
 *
 * Encapsulates the pattern: call LLM → check awaiting_human → collect answers → retry.
 * Reuses the existing HITL infrastructure (collectAnswers, formatAnswersForPrompt).
 *
 * This allows `slad auto` to run any stage with interactive HITL, without
 * duplicating the loop logic from each individual command.
 */
import type { ChatMessage, Question, CompletionOptions } from "./types.js";
import type { ModelProvider } from "../models/index.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "./hitl.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Any agent output that has status + questions (all SLAD OS outputs share this) */
export interface HitlAwareOutput {
  status: string;
  questions: Question[];
  [key: string]: unknown;
}

/** Options for the HITL loop */
export interface HitlLoopOpts<T extends HitlAwareOutput> {
  /** Display name for HITL headers (e.g. "Explorer", "Planner") */
  stageName: string;
  /** Max HITL rounds before giving up */
  maxRounds?: number;
  /** LLM completion options (CompletionOptions already includes onUsage) */
  completionOpts: CompletionOptions;
  /** Parse raw LLM response into typed output */
  parse: (raw: string) => T;
  /**
   * Optional auto-resolve function. If provided, the loop tries to auto-resolve
   * questions before falling back to interactive HITL.
   * Returns answers for questions it can resolve, or empty object to skip.
   */
  autoResolve?: (output: T) => Record<string, string>;
  /** Called after each LLM call with the raw response (for session tracking) */
  onRaw?: (raw: string) => void;
}

export interface HitlLoopResult<T extends HitlAwareOutput> {
  output: T;
  /** All human answers collected across rounds */
  humanAnswers: Record<string, string>;
  /** Number of HITL rounds used */
  rounds: number;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

/**
 * Runs the LLM + HITL loop for a single stage.
 *
 * Flow:
 *  1. Call provider.complete() with the current messages
 *  2. Parse the response
 *  3. If status !== "awaiting_human" → done
 *  4. Try auto-resolve for obvious questions
 *  5. If unresolved questions remain → interactive HITL (collectAnswers)
 *  6. Append answers to messages, loop
 *
 * @param provider - LLM provider
 * @param messages - Initial messages (mutated: tool results and HITL answers are appended)
 * @param opts - Loop configuration
 * @returns The final output + collected human answers
 */
export async function hitlLoop<T extends HitlAwareOutput>(
  provider: ModelProvider,
  messages: ChatMessage[],
  opts: HitlLoopOpts<T>,
): Promise<HitlLoopResult<T>> {
  const maxRounds = opts.maxRounds ?? 3;
  const allAnswers: Record<string, string> = {};
  let output!: T;
  let raw = "";
  let rounds = 0;

  while (rounds <= maxRounds) {
    raw = await provider.complete(messages, opts.completionOpts);
    opts.onRaw?.(raw);
    output = opts.parse(raw);

    // Done — no HITL needed
    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      return { output, humanAnswers: allAnswers, rounds };
    }

    // Max rounds exhausted
    if (rounds >= maxRounds) {
      return { output, humanAnswers: allAnswers, rounds };
    }

    // Try auto-resolve first
    let answers: Record<string, string> = {};
    let unresolvedQuestions = output.questions;

    if (opts.autoResolve) {
      const autoAnswers = opts.autoResolve(output);
      const autoResolved = new Set(Object.keys(autoAnswers));
      unresolvedQuestions = output.questions.filter((q) => !autoResolved.has(q.id));
      answers = { ...autoAnswers };
    }

    // Interactive HITL for remaining questions
    if (unresolvedQuestions.length > 0) {
      printHitlHeader(opts.stageName, (output as Record<string, unknown>).summary as string ?? "", rounds + 1, maxRounds);
      const interactiveAnswers = await collectAnswers(unresolvedQuestions);
      answers = { ...answers, ...interactiveAnswers };
    }

    Object.assign(allAnswers, answers);

    // Append to conversation and continue
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  return { output, humanAnswers: allAnswers, rounds };
}
