import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateExploreOutput } from "./explore.js";
import type { ModelProvider } from "../models/index.js";

function createProjectRoot(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"test-project"}\n', "utf8");
  return cwd;
}

function createExploreProvider(): { provider: ModelProvider; getCalls: () => number } {
  let calls = 0;

  return {
    provider: {
      name: "cli",
      async complete() {
        calls += 1;
        return JSON.stringify({
          status: "completed",
          intent: "cache por proyecto",
          reframing: "Reusar resultados válidos con aislamiento fuerte.",
          approaches: [
            {
              name: "Filesystem cache",
              summary: "Persistir objetos por proyecto y tipo.",
              pros: ["Reutiliza flujos repetidos."],
              cons: ["Requiere invalidación correcta."],
            },
          ],
          risks: [],
          openQuestions: [],
          recommendedNext: "Integrar planner",
          questions: [],
        });
      },
    },
    getCalls: () => calls,
  };
}

test("generateExploreOutput reuses agent cache and invalidates deterministically when wiki context changes", async () => {
  const cwd = createProjectRoot("slad-explore-cache-");
  const cacheRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-explore-cache-root-"));
  const registrationsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slad-explore-registrations-"));
  const wikiPath = path.join(cwd, "wiki");
  fs.mkdirSync(wikiPath, { recursive: true });
  fs.writeFileSync(path.join(wikiPath, "index.md"), "Contexto inicial\n", "utf8");

  const { provider, getCalls } = createExploreProvider();
  const previousRegistrationsRoot = process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;

  process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = registrationsRoot;

  try {
    const first = await generateExploreOutput({
      cwd,
      cacheRootDir,
      intent: "Necesito una cache por proyecto",
      provider,
      providerName: "cli",
      wikiPath,
    });
    const second = await generateExploreOutput({
      cwd,
      cacheRootDir,
      intent: "Necesito una cache por proyecto",
      provider,
      providerName: "cli",
      wikiPath,
    });

    fs.writeFileSync(path.join(wikiPath, "index.md"), "Contexto actualizado\n", "utf8");

    const third = await generateExploreOutput({
      cwd,
      cacheRootDir,
      intent: "Necesito una cache por proyecto",
      provider,
      providerName: "cli",
      wikiPath,
    });

    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.equal(third.cacheStatus, "miss");
    assert.equal(getCalls(), 2);
  } finally {
    if (previousRegistrationsRoot === undefined) {
      delete process.env.SLAD_PROJECT_REGISTRATIONS_ROOT;
    } else {
      process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = previousRegistrationsRoot;
    }
  }
});
