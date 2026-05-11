import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateLearnOutput, learnCommand } from "./learn.js";
import {
  RunOutput as RunOutputSchema,
  type ChatMessage,
  type CompletionOptions,
  type LearnOutput,
  type RunOutput,
} from "../core/types.js";
import { appendArtifact, createSession, saveSession } from "../core/session.js";
import type { ModelProvider } from "../models/index.js";
import { parseRun } from "../persistence/parse/run.js";
import { parseSession } from "../persistence/parse/session.js";
import { readArtifact } from "../persistence/index.js";
import { renderRun } from "../persistence/render/run.js";

type MarkdownRunFixture = {
  projectRoot: string;
  sessionId: string;
  runPath: string;
  runRelativePath: string;
  runOutput: RunOutput;
};

type CapturedCompleteCall = {
  messages: ChatMessage[];
  opts?: CompletionOptions;
};

function createMarkdownRunFixture(): MarkdownRunFixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slad-learn-run-md-"));
  const taskId = "T1";
  const runOutput: RunOutput = {
    taskId,
    status: "completed",
    summary: "Fixture run summary",
    changedFiles: ["src/commands/learn.ts"],
    verification: [
      {
        command: "node --import tsx/esm --test src/commands/learn.test.ts",
        status: "passed",
        notes: "fixture command captured for learn input",
      },
    ],
    reviewerNotes: ["Reviewed fixture output"],
    followUps: ["Use this run as learn input"],
    questions: [
      {
        id: "fixture_question",
        prompt: "Should this fixture be reused?",
        kind: "confirm",
        default: "true",
        blocking: false,
        context: "Exercises question round-trip through run frontmatter.",
      },
    ],
    humanAnswers: {
      fixture_question: "true",
    },
  };

  const session = createSession("learn markdown run fixture", projectRoot);
  const runRelativePath = path.join("docs", "log", "runs", `${session.id}_${taskId}.md`);
  const runPath = path.join(projectRoot, runRelativePath);
  const runContent = renderRun(runOutput, {
    sessionId: session.id,
    createdAt: "2026-05-07T00:00:00.000Z",
  });

  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(runPath, runContent, "utf8");
  saveSession(appendArtifact(session, "run", runRelativePath, taskId), projectRoot);

  return {
    projectRoot,
    sessionId: session.id,
    runPath,
    runRelativePath,
    runOutput,
  };
}

function createLearnProvider(learnOutput: LearnOutput): {
  provider: ModelProvider;
  getCalls: () => CapturedCompleteCall[];
} {
  const calls: CapturedCompleteCall[] = [];

  return {
    provider: {
      name: "cli",
      async complete(messages, opts) {
        calls.push({ messages, opts });
        return JSON.stringify(learnOutput);
      },
    },
    getCalls: () => calls,
  };
}

function createQueuedLearnProvider(learnOutputs: LearnOutput[]): {
  provider: ModelProvider;
  getCalls: () => CapturedCompleteCall[];
} {
  const calls: CapturedCompleteCall[] = [];
  let index = 0;

  return {
    provider: {
      name: "cli",
      async complete(messages, opts) {
        calls.push({ messages, opts });
        const output = learnOutputs[index] ?? learnOutputs[learnOutputs.length - 1];
        index++;
        return JSON.stringify(output);
      },
    },
    getCalls: () => calls,
  };
}

function writeRunFixture(
  fixture: MarkdownRunFixture,
  runOutput: RunOutput,
  createdAt: string,
): string {
  const runRelativePath = path.join(
    "docs",
    "log",
    "runs",
    `${fixture.sessionId}_${runOutput.taskId}.md`,
  );
  const runPath = path.join(fixture.projectRoot, runRelativePath);
  fs.writeFileSync(
    runPath,
    renderRun(runOutput, {
      sessionId: fixture.sessionId,
      createdAt,
    }),
    "utf8",
  );

  const sessionPath = path.join(fixture.projectRoot, "docs", "log", "sessions", `${fixture.sessionId}.md`);
  const session = parseSession(fs.readFileSync(sessionPath, "utf8"), sessionPath).value;
  saveSession(appendArtifact(session, "run", runRelativePath, runOutput.taskId), fixture.projectRoot);

  return runPath;
}

function extractRunReportsFromPrompt(content: string): RunOutput[] {
  const reports: RunOutput[] = [];
  let cursor = 0;
  const marker = "Run report:\n";

  while (true) {
    const markerIndex = content.indexOf(marker, cursor);
    if (markerIndex === -1) break;

    const jsonStart = content.indexOf("{", markerIndex + marker.length);
    if (jsonStart === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = jsonStart; index < content.length; index++) {
      const char = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          reports.push(RunOutputSchema.parse(JSON.parse(content.slice(jsonStart, index + 1))));
          cursor = index + 1;
          break;
        }
      }
    }
  }

  return reports;
}

function parsedRunFixture(runPath: string): RunOutput {
  return parseRun(fs.readFileSync(runPath, "utf8"), runPath).value;
}

test("learn fixture creates a hermetic Markdown run artifact without legacy JSON", () => {
  const fixture = createMarkdownRunFixture();

  try {
    const statePath = path.join(fixture.projectRoot, "docs", "log", "sessions");
    const stateFiles = fs.readdirSync(statePath);
    const sessionFiles = stateFiles.filter((file) => file.endsWith(".md"));
    assert.equal(sessionFiles.length, 1);

    const state = parseSession(
      fs.readFileSync(path.join(statePath, sessionFiles[0]), "utf8"),
      path.join(statePath, sessionFiles[0]),
    ).value;
    assert.deepEqual(state.artifacts, [
      {
        kind: "run",
        path: fixture.runRelativePath,
        createdAt: state.artifacts[0].createdAt,
        taskId: fixture.runOutput.taskId,
      },
    ]);
    assert.equal(
      fixture.runRelativePath,
      path.join("docs", "log", "runs", `${state.id}_${fixture.runOutput.taskId}.md`),
    );

    const parsed = parseRun(fs.readFileSync(fixture.runPath, "utf8"), fixture.runPath);
    assert.deepEqual(parsed.value, fixture.runOutput);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "runs")), false);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("generateLearnOutput sends parsed Markdown run data to a fake provider", async () => {
  const fixture = createMarkdownRunFixture();
  const learnOutput: LearnOutput = {
    status: "completed",
    sourceRun: fixture.runPath,
    taskId: fixture.runOutput.taskId,
    summary: "Captured learning from Markdown run",
    decisions: ["Use parseRun output as learn input"],
    errors: [],
    patterns: ["Markdown run artifacts can feed learn without legacy JSON"],
    openQuestions: [],
    followUps: ["Assert captured provider messages in integration tests"],
    wikiEntryTitle: "Learn Markdown Run Artifact",
    questions: [],
  };
  const { provider, getCalls } = createLearnProvider(learnOutput);

  try {
    const result = await generateLearnOutput({
      runPath: fixture.runPath,
      provider,
      model: "fake-learn-model",
      cwd: fixture.projectRoot,
    });

    assert.deepEqual(result, learnOutput);

    const calls = getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts?.model, "fake-learn-model");
    assert.equal(calls[0].opts?.temperature, 0.2);
    assert.equal(calls[0].opts?.maxTokens, 2200);

    const [message] = calls[0].messages;
    assert.equal(message.role, "user");
    assert.ok(message.content.includes(`Source run path:\n${fixture.runPath}`));
    assert.match(message.content, /"taskId": "T1"/);
    assert.match(message.content, /"summary": "Fixture run summary"/);
    assert.match(message.content, /"changedFiles": \[\n    "src\/commands\/learn\.ts"\n  \]/);
    assert.match(message.content, /"command": "node --import tsx\/esm --test src\/commands\/learn\.test\.ts"/);
    assert.match(message.content, /"reviewerNotes": \[\n    "Reviewed fixture output"\n  \]/);
    assert.match(message.content, /"humanAnswers": \{\n    "fixture_question": "true"\n  \}/);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "runs")), false);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("learnCommand uses the active session Markdown run artifact as provider context", async () => {
  const fixture = createMarkdownRunFixture();
  const distractorRun: RunOutput = {
    ...fixture.runOutput,
    taskId: "T2",
    summary: "Distractor run summary that is not referenced by the active session",
  };
  const distractorPath = path.join(fixture.projectRoot, "docs", "log", "runs", "newer-unreferenced_T2.md");
  fs.writeFileSync(
    distractorPath,
    renderRun(distractorRun, {
      sessionId: "newer-unreferenced",
      createdAt: "2026-05-07T00:01:00.000Z",
    }),
    "utf8",
  );
  const newerMtime = new Date(Date.now() + 60_000);
  fs.utimesSync(distractorPath, newerMtime, newerMtime);

  const learnOutput: LearnOutput = {
    status: "completed",
    sourceRun: fixture.runPath,
    taskId: fixture.runOutput.taskId,
    summary: "Captured learning from learnCommand Markdown run",
    decisions: ["learnCommand consumed the session run artifact"],
    errors: [],
    patterns: ["Markdown+YAML run artifacts are valid learn inputs"],
    openQuestions: [],
    followUps: [],
    wikiEntryTitle: "Learn Command Markdown Run",
    questions: [],
  };
  const { provider, getCalls } = createLearnProvider(learnOutput);
  const previousCwd = process.cwd();

  try {
    process.chdir(fixture.projectRoot);

    await learnCommand({
      provider: "cli",
      model: "fake-learn-model",
      json: true,
      output: path.join(fixture.projectRoot, "learnings", "learn-output.json"),
      modelProvider: provider,
    });

    const calls = getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts?.model, "fake-learn-model");

    const [message] = calls[0].messages;
    assert.equal(message.role, "user");
    const expectedSourcePath = fs.realpathSync(fixture.runPath);
    assert.match(
      message.content,
      new RegExp(`Source run path:\\n${expectedSourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.match(message.content, /"taskId": "T1"/);
    assert.match(message.content, /"summary": "Fixture run summary"/);
    assert.match(message.content, /"changedFiles": \[\n    "src\/commands\/learn\.ts"\n  \]/);
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "runs")), false);

    const learnDir = path.join(fixture.projectRoot, "docs", "log", "learnings");
    const learnFiles = fs.readdirSync(learnDir).filter((file) => file.endsWith(".md"));
    assert.equal(learnFiles.length, 1);
    assert.match(learnFiles[0], /_all\.md$/);
    const parsed = await readArtifact("learn", path.join(learnDir, learnFiles[0]));
    assert.deepEqual(parsed.value, {
      ...learnOutput,
      sourceRun: "session",
      taskId: "all",
    });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, "learnings")), false);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("learnCommand consolidates all session run statuses and sends each full RunOutput", async () => {
  const fixture = createMarkdownRunFixture();
  const failedRun: RunOutput = {
    ...fixture.runOutput,
    taskId: "T2",
    status: "failed",
    summary: "Failed fixture run summary",
    changedFiles: ["src/core/session.ts"],
    verification: [
      {
        command: "npm test",
        status: "failed",
        notes: "fixture failure captured for consolidated learn",
      },
    ],
    reviewerNotes: ["Failed run reviewed"],
    followUps: ["Investigate failed run"],
  };
  const blockedRun: RunOutput = {
    ...fixture.runOutput,
    taskId: "T3",
    status: "blocked",
    summary: "Blocked fixture run summary",
    changedFiles: [],
    verification: [
      {
        command: "npm run typecheck",
        status: "not_run",
        notes: "blocked before verification",
      },
    ],
    reviewerNotes: ["Blocked run reviewed"],
    followUps: ["Resolve technical blocker"],
    questions: [],
    humanAnswers: {},
  };
  const awaitingHumanRun: RunOutput = {
    ...fixture.runOutput,
    taskId: "T4",
    status: "awaiting_human",
    summary: "Awaiting human fixture run summary",
    changedFiles: [],
    verification: [],
    reviewerNotes: ["Awaiting-human run reviewed"],
    followUps: [],
    questions: [
      {
        id: "choose_path",
        prompt: "Which consolidation path should learn use?",
        kind: "choice",
        choices: ["session", "single-run"],
        default: "session",
        context: "Fixture requires a pending human decision.",
        blocking: true,
      },
    ],
    humanAnswers: {},
  };
  const failedRunPath = writeRunFixture(fixture, failedRun, "2026-05-07T00:02:00.000Z");
  const blockedRunPath = writeRunFixture(fixture, blockedRun, "2026-05-07T00:03:00.000Z");
  const awaitingHumanRunPath = writeRunFixture(fixture, awaitingHumanRun, "2026-05-07T00:04:00.000Z");

  const learnOutput: LearnOutput = {
    status: "completed",
    sourceRun: fixture.runPath,
    taskId: fixture.runOutput.taskId,
    summary: "Captured consolidated learning from session runs",
    decisions: ["T1 completed, T2 failed, T3 blocked, and T4 awaiting_human were all considered"],
    errors: ["T2 failed in the fixture", "T3 blocked before verification"],
    patterns: ["Consolidated learn keeps run statuses separated by taskId"],
    openQuestions: ["T4 awaits human input for choose_path"],
    followUps: ["Review all non-completed statuses before evolve"],
    wikiEntryTitle: "Consolidated Learn Command",
    questions: [],
  };
  const { provider, getCalls } = createLearnProvider(learnOutput);
  const previousCwd = process.cwd();

  try {
    process.chdir(fixture.projectRoot);

    await learnCommand({
      provider: "cli",
      model: "fake-learn-model",
      modelProvider: provider,
    });

    const calls = getCalls();
    assert.equal(calls.length, 1);
    const [message] = calls[0].messages;
    const expectedRuns = [
      fixture.runOutput,
      parsedRunFixture(failedRunPath),
      parsedRunFixture(blockedRunPath),
      parsedRunFixture(awaitingHumanRunPath),
    ];
    assert.deepEqual(extractRunReportsFromPrompt(message.content), expectedRuns);
    assert.match(message.content, /"status": "completed"/);
    assert.match(message.content, /"status": "failed"/);
    assert.match(message.content, /"status": "blocked"/);
    assert.match(message.content, /"status": "awaiting_human"/);

    const learnDir = path.join(fixture.projectRoot, "docs", "log", "learnings");
    const learnFiles = fs.readdirSync(learnDir).filter((file) => file.endsWith(".md"));
    assert.deepEqual(learnFiles, [`${fixture.sessionId}_all.md`]);
    const parsed = await readArtifact("learn", path.join(learnDir, learnFiles[0]));
    assert.deepEqual(parsed.value, {
      ...learnOutput,
      sourceRun: "session",
      taskId: "all",
    });
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("learnCommand replaces the previous consolidated learn artifact on rerun", async () => {
  const fixture = createMarkdownRunFixture();
  const firstLearnOutput: LearnOutput = {
    status: "completed",
    sourceRun: fixture.runPath,
    taskId: fixture.runOutput.taskId,
    summary: "First consolidated learning",
    decisions: ["First learn run decision"],
    errors: [],
    patterns: ["First learn run pattern"],
    openQuestions: [],
    followUps: [],
    wikiEntryTitle: "First Consolidated Learn",
    questions: [],
  };
  const secondLearnOutput: LearnOutput = {
    status: "completed",
    sourceRun: fixture.runPath,
    taskId: fixture.runOutput.taskId,
    summary: "Second consolidated learning",
    decisions: ["Second learn run decision"],
    errors: ["Second learn run error"],
    patterns: ["Second learn run pattern"],
    openQuestions: ["Second learn run question"],
    followUps: ["Second learn run follow-up"],
    wikiEntryTitle: "Second Consolidated Learn",
    questions: [],
  };
  const { provider, getCalls } = createQueuedLearnProvider([firstLearnOutput, secondLearnOutput]);
  const previousCwd = process.cwd();

  try {
    process.chdir(fixture.projectRoot);

    await learnCommand({
      provider: "cli",
      model: "fake-learn-model",
      modelProvider: provider,
    });
    await learnCommand({
      provider: "cli",
      model: "fake-learn-model",
      modelProvider: provider,
    });

    assert.equal(getCalls().length, 2);
    const learnDir = path.join(fixture.projectRoot, "docs", "log", "learnings");
    const learnFiles = fs.readdirSync(learnDir).filter((file) => file.endsWith(".md"));
    assert.deepEqual(learnFiles, [`${fixture.sessionId}_all.md`]);
    const parsed = await readArtifact("learn", path.join(learnDir, learnFiles[0]));
    assert.deepEqual(parsed.value, {
      ...secondLearnOutput,
      sourceRun: "session",
      taskId: "all",
    });

    const sessionPath = path.join(fixture.projectRoot, "docs", "log", "sessions", `${fixture.sessionId}.md`);
    const session = parseSession(fs.readFileSync(sessionPath, "utf8"), sessionPath).value;
    const learnArtifacts = session.artifacts.filter((artifact) => artifact.kind === "learn");
    assert.deepEqual(
      learnArtifacts.map((artifact) => fs.realpathSync(artifact.path)),
      [fs.realpathSync(path.join(learnDir, learnFiles[0]))],
    );
    assert.deepEqual(learnArtifacts.map((artifact) => artifact.taskId), ["all"]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});
