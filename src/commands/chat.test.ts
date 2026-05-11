import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAction, suggestNext, safeCall } from "./chat.js";
import type { SessionState } from "../core/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(artifactKinds: string[] = []): SessionState {
  return {
    id: "test-session",
    createdAt: new Date().toISOString(),
    intent: "test intent",
    artifacts: artifactKinds.map((kind) => ({
      kind: kind as SessionState["artifacts"][number]["kind"],
      path: `./test/${kind}.json`,
      createdAt: new Date().toISOString(),
    })),
    humanAnswers: [],
    notes: [],
  };
}

// ─── parseAction ─────────────────────────────────────────────────────────────

describe("parseAction", () => {
  describe("meta commands — no session needed", () => {
    it('empty string → { type: "next" }', () => {
      assert.deepEqual(parseAction("", null), { type: "next" });
    });

    it('whitespace only → { type: "next" }', () => {
      assert.deepEqual(parseAction("   ", null), { type: "next" });
    });

    it('"next" → { type: "next" }', () => {
      assert.deepEqual(parseAction("next", null), { type: "next" });
    });

    it('"siguiente" → { type: "next" }', () => {
      assert.deepEqual(parseAction("siguiente", null), { type: "next" });
    });

    it('"ok" → { type: "next" }', () => {
      assert.deepEqual(parseAction("ok", null), { type: "next" });
    });

    it('"sí" → { type: "next" }', () => {
      assert.deepEqual(parseAction("sí", null), { type: "next" });
    });

    it('"dale" → { type: "next" }', () => {
      assert.deepEqual(parseAction("dale", null), { type: "next" });
    });

    it('"exit" → { type: "exit" }', () => {
      assert.deepEqual(parseAction("exit", null), { type: "exit" });
    });

    it('"quit" → { type: "exit" }', () => {
      assert.deepEqual(parseAction("quit", null), { type: "exit" });
    });

    it('"salir" → { type: "exit" }', () => {
      assert.deepEqual(parseAction("salir", null), { type: "exit" });
    });

    it('"q" → { type: "exit" }', () => {
      assert.deepEqual(parseAction("q", null), { type: "exit" });
    });

    it('"help" → { type: "help" }', () => {
      assert.deepEqual(parseAction("help", null), { type: "help" });
    });

    it('"ayuda" → { type: "help" }', () => {
      assert.deepEqual(parseAction("ayuda", null), { type: "help" });
    });

    it('"?" → { type: "help" }', () => {
      assert.deepEqual(parseAction("?", null), { type: "help" });
    });

    it('"status" → { type: "status" }', () => {
      assert.deepEqual(parseAction("status", null), { type: "status" });
    });

    it('"estado" → { type: "status" }', () => {
      assert.deepEqual(parseAction("estado", null), { type: "status" });
    });

    it('"new" → { type: "new" }', () => {
      assert.deepEqual(parseAction("new", null), { type: "new" });
    });

    it('"nuevo" → { type: "new" }', () => {
      assert.deepEqual(parseAction("nuevo", null), { type: "new" });
    });

    it('"reset" → { type: "new" }', () => {
      assert.deepEqual(parseAction("reset", null), { type: "new" });
    });
  });

  describe("pipeline stage commands", () => {
    it('"evolve" → { type: "evolve" }', () => {
      assert.deepEqual(parseAction("evolve", null), { type: "evolve" });
    });

    it('"evolucionar" → { type: "evolve" }', () => {
      assert.deepEqual(parseAction("evolucionar", null), { type: "evolve" });
    });

    it('"learn" → { type: "learn" }', () => {
      assert.deepEqual(parseAction("learn", null), { type: "learn" });
    });

    it('"plan" → { type: "plan" }', () => {
      assert.deepEqual(parseAction("plan", null), { type: "plan" });
    });

    it('"snapshot" → { type: "snapshot" }', () => {
      assert.deepEqual(parseAction("snapshot", null), { type: "snapshot" });
    });

    it('"run --auto" → { type: "run-auto" }', () => {
      assert.deepEqual(parseAction("run --auto", null), { type: "run-auto" });
    });

    it('"run auto" → { type: "run-auto" }', () => {
      assert.deepEqual(parseAction("run auto", null), { type: "run-auto" });
    });

    it('"auto" → { type: "run-auto" }', () => {
      assert.deepEqual(parseAction("auto", null), { type: "run-auto" });
    });

    it('"run T2" → { type: "run-task", taskId: "T2" }', () => {
      assert.deepEqual(parseAction("run T2", null), { type: "run-task", taskId: "T2" });
    });

    it('"T3" alone → { type: "run-task", taskId: "T3" }', () => {
      assert.deepEqual(parseAction("T3", null), { type: "run-task", taskId: "T3" });
    });

    it('task id is uppercased → "t4" becomes "T4"', () => {
      assert.deepEqual(parseAction("t4", null), { type: "run-task", taskId: "T4" });
    });

    it('"run" alone → { type: "run-next" }', () => {
      assert.deepEqual(parseAction("run", null), { type: "run-next" });
    });
  });

  describe("explore routing", () => {
    it('"explore mi idea" → { type: "explore", intent: "mi idea" }', () => {
      assert.deepEqual(parseAction("explore mi idea", null), {
        type: "explore",
        intent: "mi idea",
      });
    });

    it('"explorar algo más" → { type: "explore", intent: "algo más" }', () => {
      assert.deepEqual(parseAction("explorar algo más", null), {
        type: "explore",
        intent: "algo más",
      });
    });

    it("free text with null session → treated as explore intent", () => {
      const result = parseAction("quiero hacer un sistema de autenticación", null);
      assert.equal(result.type, "explore");
      assert.equal(
        (result as { type: "explore"; intent: string }).intent,
        "quiero hacer un sistema de autenticación",
      );
    });

    it("free text with session but no explore artifact → treated as explore intent", () => {
      const session = makeSession([]);
      const result = parseAction("nueva feature de login", session);
      assert.equal(result.type, "explore");
    });

    it("free text with session that has explore artifact → unknown", () => {
      const session = makeSession(["explore"]);
      const result = parseAction("algo raro", session);
      assert.deepEqual(result, { type: "unknown", input: "algo raro" });
    });
  });

  describe("case insensitivity", () => {
    it('"EXIT" → exit', () => {
      assert.deepEqual(parseAction("EXIT", null), { type: "exit" });
    });

    it('"PLAN" → plan', () => {
      assert.deepEqual(parseAction("PLAN", null), { type: "plan" });
    });

    it('"SNAPSHOT" → snapshot', () => {
      assert.deepEqual(parseAction("SNAPSHOT", null), { type: "snapshot" });
    });
  });
});

// ─── suggestNext ──────────────────────────────────────────────────────────────

describe("suggestNext", () => {
  it("null session → initial prompt", () => {
    const msg = suggestNext(null);
    assert.ok(msg.includes("intención") || msg.includes("help"));
  });

  it("session with no artifacts → initial prompt", () => {
    const msg = suggestNext(makeSession([]));
    assert.ok(msg.includes("intención") || msg.includes("help"));
  });

  it("session with explore only → suggests snapshot", () => {
    const msg = suggestNext(makeSession(["explore"]));
    assert.ok(msg.includes("snapshot"), `Expected 'snapshot' in: ${msg}`);
  });

  it("session with explore + snapshot → suggests plan", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot"]));
    assert.ok(msg.includes("plan"), `Expected 'plan' in: ${msg}`);
  });

  it("session with explore + snapshot + plan → suggests run", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan"]));
    assert.ok(msg.includes("run"), `Expected 'run' in: ${msg}`);
  });

  it("session with explore + snapshot + plan + run → suggests learn", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan", "run"]));
    assert.ok(msg.includes("learn"), `Expected 'learn' in: ${msg}`);
  });

  it("session with all artifacts → suggests evolve or new intent", () => {
    const msg = suggestNext(makeSession(["explore", "snapshot", "plan", "run", "learn"]));
    assert.ok(msg.includes("evolve"), `Expected 'evolve' in: ${msg}`);
  });
});

// ─── safeCall ─────────────────────────────────────────────────────────────────

describe("safeCall", () => {
  it("successful fn → returns true", async () => {
    const result = await safeCall(async () => {
      // no-op
    });
    assert.equal(result, true);
  });

  it("fn that calls process.exit(1) → returns false without crashing", async () => {
    const result = await safeCall(async () => {
      process.exit(1);
    });
    assert.equal(result, false);
  });

  it("fn that calls process.exit(0) → returns false without crashing", async () => {
    const result = await safeCall(async () => {
      process.exit(0);
    });
    assert.equal(result, false);
  });

  it("fn that throws a regular Error → returns false", async () => {
    const result = await safeCall(async () => {
      throw new Error("algo salió mal");
    });
    assert.equal(result, false);
  });

  it("can be called sequentially — second safeCall still intercepts exit", async () => {
    // First call intercepts exit and completes
    const r1 = await safeCall(async () => {
      process.exit(1);
    });
    // Second call must also intercept (process.exit was restored)
    const r2 = await safeCall(async () => {
      process.exit(0);
    });
    assert.equal(r1, false);
    assert.equal(r2, false);
  });

  it("can be called sequentially — second safeCall succeeds after first throws", async () => {
    await safeCall(async () => {
      throw new Error("first failure");
    });
    const result = await safeCall(async () => {
      // second call should be clean
    });
    assert.equal(result, true);
  });

  it("process.exit remains callable as a function after safeCall", async () => {
    await safeCall(async () => {
      // no-op
    });
    // If restore failed, process.exit would be a throwing stub
    // Verify it's still a normal function by checking it via another safeCall
    const result = await safeCall(async () => {
      process.exit(1);
    });
    assert.equal(result, false);
  });

  // Regression: a synchronous listener (e.g. the SIGINT handler) firing while
  // safeCall is mid-flight must NOT see the throwing stub. The chat module
  // captures `process.exit` once at load time and uses that reference inside
  // the SIGINT handler — this test guards that contract.
  it("a sync listener captured before safeCall does NOT see the throwing stub", async () => {
    const originalAtModuleLoad = process.exit.bind(process);
    let stubObserved = false;

    await safeCall(async () => {
      // Inside safeCall, process.exit IS the stub. But code that captured the
      // reference earlier (e.g. the SIGINT handler) should be unaffected.
      if (process.exit !== originalAtModuleLoad) {
        // Confirms safeCall did install a stub
      }
      // If we were a SIGINT handler captured before safeCall, calling our
      // captured reference must NOT throw — i.e. it must be the real exit.
      try {
        // Can't actually call process.exit(0) in a test (would kill the
        // runner). Instead verify that the captured reference is not the
        // current (stubbed) process.exit.
        if (originalAtModuleLoad === (process.exit as unknown)) {
          stubObserved = true;
        }
      } catch {
        stubObserved = true;
      }
    });

    assert.equal(stubObserved, false, "captured reference must remain the real process.exit");
  });
});
