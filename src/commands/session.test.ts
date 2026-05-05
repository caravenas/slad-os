import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSession } from "../core/session.js";
import type { BootEvent, BootUi, BootUiOptions } from "../cli/ui.js";
import { sessionStartCommand, shouldRenderVisualBootUiForEnv } from "./session.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createBootUiSpy(events: BootEvent[], enabledValues: boolean[]) {
  return (opts: BootUiOptions): BootUi => {
    enabledValues.push(Boolean(opts.enabled));
    const emit = (event: BootEvent): void => {
      events.push(event);
      opts.onEvent?.(event);
    };

    return {
      async showBanner(): Promise<void> {
        emit({ type: "banner", content: "SLAD OS vtest" });
      },
      start(message: string): void {
        emit({ type: "start", message });
      },
      milestone(milestone, message): void {
        emit({ type: "milestone", milestone, message: message ?? milestone });
      },
      succeed(message: string): void {
        emit({ type: "succeed", message });
      },
      async fail(message: string, failOpts): Promise<void> {
        emit({ type: "error", message, lingerMs: failOpts?.lingerMs ?? 0 });
        emit({ type: "stop" });
      },
      stop(): void {
        emit({ type: "stop" });
      },
    };
  };
}

test("session start nueva sesión emite banner/progreso por hitos", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ui-new-");
  process.chdir(project);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await sessionStartCommand("crear sesion de prueba", "binario-inexistente", {
      bootUiFactory: createBootUiSpy(events, enabledValues),
    });

    assert.deepEqual(enabledValues, [false]);
    assert.equal(events.some((event) => event.type === "banner"), true);
    assert.equal(events.some((event) => event.type === "start"), true);

    const milestones = events
      .filter((event): event is Extract<BootEvent, { type: "milestone" }> => event.type === "milestone")
      .map((event) => event.milestone);
    assert.deepEqual(milestones, ["config", "config", "config", "fs", "persistence"]);
    assert.equal(events.some((event) => event.type === "succeed"), true);
  } finally {
    process.chdir(cwd);
  }
});

test("session start resume no renderiza banner/progreso", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ui-resume-");
  process.chdir(project);

  const existing = createSession("sesion existente para resume");
  assert.ok(existing.id.length > 0);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await sessionStartCommand("ignorado en resume", undefined, {
      bootUiFactory: createBootUiSpy(events, enabledValues),
    });

    assert.deepEqual(enabledValues, [false]);
    assert.equal(events.length, 0);
  } finally {
    process.chdir(cwd);
  }
});

test("guardia visual boot UI: CI y no-TTY desactivan render", () => {
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: true, ci: "1" }),
    false,
  );
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: false, stderrIsTty: true, ci: undefined }),
    false,
  );
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: false, ci: undefined }),
    false,
  );
  assert.equal(
    shouldRenderVisualBootUiForEnv({ stdoutIsTty: true, stderrIsTty: true, ci: undefined }),
    true,
  );
});

test("session start error inicialización emite error breve y detiene", { concurrency: false }, async () => {
  const cwd = process.cwd();
  const project = await makeTempDir("slad-session-ui-error-");
  process.chdir(project);

  const events: BootEvent[] = [];
  const enabledValues: boolean[] = [];

  try {
    await assert.rejects(() =>
      sessionStartCommand("x", undefined, {
        bootUiFactory: createBootUiSpy(events, enabledValues),
      }),
    );

    assert.deepEqual(enabledValues, [false]);
    const errorIndex = events.findIndex((event) => event.type === "error");
    const stopIndex = events.findIndex((event) => event.type === "stop");

    assert.ok(errorIndex >= 0);
    assert.ok(stopIndex > errorIndex);

    const errorEvent = events[errorIndex] as Extract<BootEvent, { type: "error" }>;
    assert.match(errorEvent.message, /Intención vacía/);
  } finally {
    process.chdir(cwd);
  }
});
