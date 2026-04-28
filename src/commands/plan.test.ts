import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generatePlanOutput } from "./plan.js";
import { resolveProjectId } from "../project/project-id.js";
import { resolveCacheEntriesDir } from "../cache/store.js";
import type { ModelProvider } from "../models/index.js";

function createProjectRoot(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"test-project"}\n', "utf8");
  return cwd;
}

function createPlannerProvider(): { provider: ModelProvider; getCalls: () => number } {
  let calls = 0;

  return {
    provider: {
      name: "cli",
      async complete() {
        calls += 1;
        return JSON.stringify({
          status: "completed",
          snapshot: "Cache v1",
          summary: "Plan generado",
          tasks: [
            {
              id: "T1",
              title: "Integrar cache",
              description: "Implementar la integración inicial",
              type: "implementation",
              priority: "high",
              dependsOn: [],
              files: ["src/commands/plan.ts"],
              acceptanceCriteria: ["La integración persiste resultados válidos."],
            },
          ],
          verification: ["node --test"],
          risks: [],
          openQuestions: [],
          recommendedFirstTask: "T1",
        });
      },
    },
    getCalls: () => calls,
  };
}

test("generatePlanOutput reuses cache on repeated planner runs and misses when snapshot changes", async () => {
  const cwd = createProjectRoot("slad-plan-cache-");
  const cacheRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-plan-cache-root-"));
  const registrationsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slad-plan-registrations-"));
  const { provider, getCalls } = createPlannerProvider();
  const previousRegistrationsRoot = process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;

  process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = registrationsRoot;

  try {
    const first = await generatePlanOutput({
      cwd,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nPrimera versión\n",
    });
    const second = await generatePlanOutput({
      cwd,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nPrimera versión\n",
    });
    const third = await generatePlanOutput({
      cwd,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nVersión cambiada\n",
    });

    const { projectId } = resolveProjectId({ cwd });
    const entriesDir = resolveCacheEntriesDir({
      rootDir: cacheRootDir,
      projectId,
      objectType: "planner",
    });

    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.equal(third.cacheStatus, "miss");
    assert.equal(getCalls(), 2);
    assert.equal(fs.existsSync(entriesDir), true);
    assert.equal(fs.readdirSync(entriesDir).length > 0, true);
  } finally {
    if (previousRegistrationsRoot === undefined) {
      delete process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;
    } else {
      process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = previousRegistrationsRoot;
    }
  }
});

test("generatePlanOutput isolates planner cache by projectId", async () => {
  const cacheRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-plan-isolation-root-"));
  const registrationsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slad-plan-isolation-registrations-"));
  const firstProject = createProjectRoot("slad-plan-project-a-");
  const secondProject = createProjectRoot("slad-plan-project-b-");
  const { provider, getCalls } = createPlannerProvider();
  const previousRegistrationsRoot = process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;

  process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = registrationsRoot;

  try {
    const first = await generatePlanOutput({
      cwd: firstProject,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nCompartido\n",
    });
    const second = await generatePlanOutput({
      cwd: secondProject,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nCompartido\n",
    });
    const repeatedFirst = await generatePlanOutput({
      cwd: firstProject,
      cacheRootDir,
      provider,
      providerName: "cli",
      snapshotContent: "# Snapshot\n\nCompartido\n",
    });

    const firstProjectId = resolveProjectId({ cwd: firstProject }).projectId;
    const secondProjectId = resolveProjectId({ cwd: secondProject }).projectId;
    const firstDir = resolveCacheEntriesDir({
      rootDir: cacheRootDir,
      projectId: firstProjectId,
      objectType: "planner",
    });
    const secondDir = resolveCacheEntriesDir({
      rootDir: cacheRootDir,
      projectId: secondProjectId,
      objectType: "planner",
    });

    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "miss");
    assert.equal(repeatedFirst.cacheStatus, "hit");
    assert.equal(getCalls(), 2);
    assert.notEqual(firstProjectId, secondProjectId);
    assert.notEqual(firstDir, secondDir);
  } finally {
    if (previousRegistrationsRoot === undefined) {
      delete process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;
    } else {
      process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = previousRegistrationsRoot;
    }
  }
});
