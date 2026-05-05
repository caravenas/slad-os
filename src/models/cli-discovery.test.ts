import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SladError } from "../core/errors.js";
import { sessionStartCommand } from "../commands/session.js";
import { computePathHash, discoverCliCandidates } from "./cli-discovery.js";

const TEST_TIMEOUT_MS = 3000;

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await fs.writeFile(filePath, body, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function linkEchoBinary(filePath: string): Promise<void> {
  await fs.symlink("/bin/echo", filePath);
}

function shScript(output: string): string {
  return `#!/bin/sh\nprintf '%s\\n' "${output}"\n`;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("(1) detección básica de binario IA conocido", async () => {
  const dir = await makeTempDir("cli-discovery-basic-");
  const binaryName = "codex";
  await writeExecutable(path.join(dir, binaryName), shScript("AI assistant 1.2.3"));

  const result = await discoverCliCandidates({
    env: { PATH: dir, SLAD_CLI_DISCOVERY_STRICT_PATH: "1" },
    knownBinaries: ["codex"],
    concurrency: 1,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.selected?.binary, binaryName);
  assert.equal(result.candidates.length, 1);
});

test("(2) colisión de nombres: mismo binario en dos paths", async () => {
  const dirA = await makeTempDir("cli-discovery-a-");
  const dirB = await makeTempDir("cli-discovery-b-");
  const binaryName = "codex";

  await writeExecutable(path.join(dirA, binaryName), shScript("AI assistant 1.0.0"));
  await writeExecutable(path.join(dirB, binaryName), shScript("AI assistant 2.0.0"));

  const result = await discoverCliCandidates({
    env: { PATH: `${dirA}${path.delimiter}${dirB}`, SLAD_CLI_DISCOVERY_STRICT_PATH: "1" },
    knownBinaries: ["codex"],
    concurrency: 1,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  const matches = result.candidates.filter((entry) => entry.binary === binaryName);
  assert.equal(matches.length, 2);
  for (const candidate of matches) {
    assert.equal(candidate.conflicts.length, 1);
    assert.notEqual(candidate.conflicts[0], candidate.resolvedPath);
  }
  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, undefined);
});

test("(3) ambigüedad expone datos suficientes para Question bloqueante en HITL", async () => {
  const dirA = await makeTempDir("cli-discovery-q-a-");
  const dirB = await makeTempDir("cli-discovery-q-b-");
  const binaryName = "gemini";

  await writeExecutable(path.join(dirA, binaryName), shScript("LLM assistant 1.0.0"));
  await writeExecutable(path.join(dirB, binaryName), shScript("LLM assistant 2.0.0"));

  const result = await discoverCliCandidates({
    env: { PATH: `${dirA}${path.delimiter}${dirB}`, SLAD_CLI_DISCOVERY_STRICT_PATH: "1" },
    knownBinaries: ["gemini"],
    concurrency: 1,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  assert.equal(result.status, "ambiguous");
  const choices = result.candidates.map((candidate) => {
    const score = candidate.confidenceScore.toFixed(2);
    return `${candidate.binary} | ${candidate.resolvedPath} | score=${score}`;
  });
  assert.ok(choices.length >= 2);
  assert.ok(choices.every((choice) => choice.includes(" | ")));
});

test("(4) fallo explícito ante ambigüedad sin HITL con mensaje de conflictos", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ambiguous-");
  const dirA = await makeTempDir("cli-discovery-fail-a-");
  const dirB = await makeTempDir("cli-discovery-fail-b-");
  const binaryName = "claude";
  await linkEchoBinary(path.join(dirA, binaryName));
  await linkEchoBinary(path.join(dirB, binaryName));

  const prevArgv = process.argv.slice();
  const prevPath = process.env.PATH;
  const prevStrictPath = process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
  process.chdir(project);
  process.argv = [prevArgv[0] ?? "node", prevArgv[1] ?? "test", "--non-interactive"];
  process.env.PATH = `${dirA}${path.delimiter}${dirB}`;
  process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = "1";

  try {
    await assert.rejects(
      () => sessionStartCommand("probar ambiguedad cli"),
      (error: unknown) => {
        assert.ok(error instanceof SladError);
        assert.equal(error.code, "SESSION_CLI_DISCOVERY_AMBIGUOUS");
        assert.match(error.message, /Autodiscovery CLI ambiguo sin HITL disponible\./);
        assert.match(error.message, /Conflictos detectados:/);
        assert.match(error.message, new RegExp(binaryName));
        return true;
      },
    );
  } finally {
    process.argv = prevArgv;
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    if (prevStrictPath === undefined) {
      delete process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
    } else {
      process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = prevStrictPath;
    }
    process.chdir(cwd);
  }
});

test("(5) reutiliza artefacto previo resuelto (sesión posterior) sin re-preguntar", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-reuse-");
  const pathA = await makeTempDir("path-a-");
  const pathB = await makeTempDir("path-b-");
  const currentPath = `${pathA}${path.delimiter}${pathB}`;
  const hash = computePathHash([pathA, pathB]);

  const previousSessionId = "s-prev";
  const prevArtifactDir = path.join(project, "sessions", previousSessionId, "artifacts");
  await fs.mkdir(prevArtifactDir, { recursive: true });
  const prevArtifactPath = path.join(prevArtifactDir, "cli-discovery.json");
  await fs.writeFile(
    prevArtifactPath,
    JSON.stringify(
      {
        candidates: [
          {
            binary: "codex",
            resolvedPath: "/fake/bin/codex",
            version: "1.0.0",
            evidence: ["validated:help_or_version"],
            confidenceScore: 0.9,
            conflicts: [],
          },
        ],
        selected: {
          binary: "codex",
          resolvedPath: "/fake/bin/codex",
          version: "1.0.0",
          evidence: ["validated:help_or_version"],
          confidenceScore: 0.9,
          conflicts: [],
        },
        pathHash: hash,
        status: "resolved",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const prevStatePath = path.join(project, "sessions", previousSessionId, "state.json");
  await fs.writeFile(
    prevStatePath,
    JSON.stringify(
      {
        id: previousSessionId,
        createdAt: new Date().toISOString(),
        intent: "prev",
        artifacts: [{ kind: "cli-discovery", path: prevArtifactPath, createdAt: new Date().toISOString() }],
        humanAnswers: [{ taskId: "sessionStart", questionId: "cli_candidate", answer: "codex | /fake/bin/codex | score=0.90", askedAt: new Date().toISOString() }],
        notes: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const prevArgv = process.argv.slice();
  const prevPath = process.env.PATH;
  const prevStrictPath = process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
  process.chdir(project);
  process.argv = [prevArgv[0] ?? "node", prevArgv[1] ?? "test", "--non-interactive"];
  process.env.PATH = currentPath;
  process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = "1";

  try {
    await sessionStartCommand("nueva sesion reutiliza discovery");
    const sessionsRoot = path.join(project, "sessions");
    const entries = await fs.readdir(sessionsRoot);
    const newSessionId = entries.find((id) => id !== previousSessionId);
    assert.ok(newSessionId);
    const artifactPath = path.join(sessionsRoot, newSessionId as string, "artifacts", "cli-discovery.json");
    const artifact = (await readJson(artifactPath)) as { selected?: { resolvedPath: string }; status: string; pathHash: string };
    assert.equal(artifact.status, "resolved");
    assert.equal(artifact.pathHash, hash);
    assert.equal(artifact.selected?.resolvedPath, "/fake/bin/codex");
  } finally {
    process.argv = prevArgv;
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    if (prevStrictPath === undefined) {
      delete process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
    } else {
      process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = prevStrictPath;
    }
    process.chdir(cwd);
  }
});

test("(6) invalida selección previa cuando cambia PATH y desaparece binario elegido", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-invalidate-");
  const prevA = await makeTempDir("prev-a-");
  const prevB = await makeTempDir("prev-b-");
  const currA = await makeTempDir("curr-a-");
  const currB = await makeTempDir("curr-b-");
  const oldHash = computePathHash([prevA, prevB]);

  await linkEchoBinary(path.join(currA, "codex"));
  await linkEchoBinary(path.join(currB, "codex"));

  const previousSessionId = "s-prev";
  const prevArtifactDir = path.join(project, "sessions", previousSessionId, "artifacts");
  await fs.mkdir(prevArtifactDir, { recursive: true });
  const prevArtifactPath = path.join(prevArtifactDir, "cli-discovery.json");
  await fs.writeFile(
    prevArtifactPath,
    JSON.stringify(
      {
        candidates: [
          {
            binary: "codex",
            resolvedPath: "/gone/bin/codex",
            version: "1.0.0",
            evidence: ["validated:help_or_version"],
            confidenceScore: 0.9,
            conflicts: [],
          },
        ],
        selected: {
          binary: "codex",
          resolvedPath: "/gone/bin/codex",
          version: "1.0.0",
          evidence: ["validated:help_or_version"],
          confidenceScore: 0.9,
          conflicts: [],
        },
        pathHash: oldHash,
        status: "resolved",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const prevStatePath = path.join(project, "sessions", previousSessionId, "state.json");
  await fs.writeFile(
    prevStatePath,
    JSON.stringify(
      {
        id: previousSessionId,
        createdAt: new Date().toISOString(),
        intent: "prev",
        artifacts: [{ kind: "cli-discovery", path: prevArtifactPath, createdAt: new Date().toISOString() }],
        humanAnswers: [{ taskId: "sessionStart", questionId: "cli_candidate", answer: "codex | /gone/bin/codex | score=0.90", askedAt: new Date().toISOString() }],
        notes: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const prevArgv = process.argv.slice();
  const prevPath = process.env.PATH;
  const prevStrictPath = process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
  process.chdir(project);
  process.argv = [prevArgv[0] ?? "node", prevArgv[1] ?? "test", "--non-interactive"];
  process.env.PATH = `${currA}${path.delimiter}${currB}`;
  process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = "1";

  try {
    await assert.rejects(
      () => sessionStartCommand("invalida seleccion vieja"),
      (error: unknown) => {
        assert.ok(error instanceof SladError);
        assert.equal(error.code, "SESSION_CLI_DISCOVERY_AMBIGUOUS");
        assert.match(error.message, /codex/);
        return true;
      },
    );
  } finally {
    process.argv = prevArgv;
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    if (prevStrictPath === undefined) {
      delete process.env.SLAD_CLI_DISCOVERY_STRICT_PATH;
    } else {
      process.env.SLAD_CLI_DISCOVERY_STRICT_PATH = prevStrictPath;
    }
    process.chdir(cwd);
  }
});

test("(7) reutiliza artefacto previo cuando pathHash no cambia", async () => {
  const dirA = await makeTempDir("hash-a-");
  const dirB = await makeTempDir("hash-b-");

  const first = await discoverCliCandidates({
    env: { PATH: `${dirA}${path.delimiter}${dirB}`, SLAD_CLI_DISCOVERY_STRICT_PATH: "1" },
    knownBinaries: [],
    concurrency: 1,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  const second = await discoverCliCandidates({
    env: { PATH: `${dirA}${path.delimiter}${dirB}`, SLAD_CLI_DISCOVERY_STRICT_PATH: "1" },
    knownBinaries: [],
    concurrency: 1,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  assert.equal(first.pathHash, second.pathHash);
  assert.equal(first.status, "empty");
  assert.equal(second.status, "empty");
});
