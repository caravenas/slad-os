import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DiscoveryResult, type CliCandidate, type DiscoveryResult as DiscoveryResultType } from "../core/types.js";

/**
 * Known AI agent CLI binary names to look for.
 * Order matters: higher priority first.
 */
const KNOWN_AGENT_BINARIES = ["codex", "gemini", "claude", "agent"] as const;

const DEFAULT_TIMEOUT_MS = 350;
const DEFAULT_CONCURRENCY = 4;

export type CliDiscoveryOptions = {
  timeoutMs?: number;
  concurrency?: number;
  env?: NodeJS.ProcessEnv;
  /** Override the binary names to look for (useful in tests). Defaults to KNOWN_AGENT_BINARIES. */
  knownBinaries?: readonly string[];
};

/**
 * Build the ordered list of directories to search, prioritizing:
 * 1. The bin dir of the running Node binary (covers nvm, fnm, volta — version-agnostic).
 * 2. ~/.local/bin (manually installed tools, pipx, etc.)
 * 3. All PATH entries as fallback.
 */
function buildSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const strictPathOnly = env.SLAD_CLI_DISCOVERY_STRICT_PATH === "1";

  const add = (dir: string) => {
    const normalized = path.resolve(dir);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      dirs.push(normalized);
    }
  };

  if (!strictPathOnly) {
    // 1. Bin dir of current Node executable (handles any nvm/fnm/volta version).
    add(path.dirname(process.execPath));

    // 2. ~/.local/bin — common for manually installed CLIs.
    add(path.join(env.HOME ?? os.homedir(), ".local", "bin"));
  }

  // PATH entries.
  for (const entry of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    add(entry);
  }

  return dirs;
}

/**
 * Find the first path where a known binary exists and is executable.
 * Returns all matches (one per dir) for conflict detection.
 */
async function findBinaryPaths(name: string, dirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of dirs) {
    const fullPath = path.join(dir, name);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        found.push(fullPath);
      }
    } catch {
      // not found in this dir
    }
  }
  return found;
}

function runProbe(binaryPath: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
    });

    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve("");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output.toLowerCase());
    });
  });
}

async function validateBinary(
  name: string,
  resolvedPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<CliCandidate> {
  const [helpText, versionText] = await Promise.all([
    runProbe(resolvedPath, ["--help"], timeoutMs, env),
    runProbe(resolvedPath, ["--version"], timeoutMs, env),
  ]);

  const combined = `${helpText}\n${versionText}`;
  const hasModelSignal = /model|assistant|chat|prompt|completion|token|api.?key|inference|llm\b|ai\b/.test(combined);

  // Exact name match = base score 0.5; model signal bumps to 0.9.
  const confidenceScore = hasModelSignal ? 0.9 : 0.5;

  const versionMatch = combined.match(/\b\d+\.\d+(?:\.\d+)?\b/);
  const version = versionMatch ? versionMatch[0] : "unknown";

  const evidence: string[] = [`exact:${name}`, "validated:help_or_version"];
  if (hasModelSignal) evidence.push("signal:model_terms");

  return {
    binary: name,
    resolvedPath,
    version,
    evidence,
    confidenceScore,
    conflicts: [],
  };
}

function attachConflicts(candidates: CliCandidate[]): CliCandidate[] {
  const byName = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byName.get(c.binary) ?? [];
    list.push(c.resolvedPath);
    byName.set(c.binary, list);
  }
  return candidates.map((c) => ({
    ...c,
    conflicts: (byName.get(c.binary) ?? []).filter((p) => p !== c.resolvedPath).sort(),
  }));
}

function pickSelected(candidates: CliCandidate[]): CliCandidate | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    // Prefer the order in KNOWN_AGENT_BINARIES as a tiebreak.
    const ia = KNOWN_AGENT_BINARIES.indexOf(a.binary as typeof KNOWN_AGENT_BINARIES[number]);
    const ib = KNOWN_AGENT_BINARIES.indexOf(b.binary as typeof KNOWN_AGENT_BINARIES[number]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const [first, second] = sorted;
  if (!second) return first;
  if (first!.confidenceScore > second.confidenceScore) return first;
  // Ambiguous: same score, different binary — let HITL resolve.
  return undefined;
}

export function computePathHash(paths: string[]): string {
  const normalized = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const digest = crypto.createHash("sha256");
  digest.update(JSON.stringify(normalized));
  return digest.digest("hex");
}

export async function discoverCliCandidates(options: CliDiscoveryOptions = {}): Promise<DiscoveryResultType> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const binariesToFind = options.knownBinaries ?? KNOWN_AGENT_BINARIES;

  const searchDirs = buildSearchDirs(env);

  // Find all paths for each known binary, then validate concurrently.
  const tasks: Array<{ name: string; resolvedPath: string }> = [];
  for (const name of binariesToFind) {
    const found = await findBinaryPaths(name, searchDirs);
    for (const resolvedPath of found) {
      tasks.push({ name, resolvedPath });
    }
  }

  const validated: CliCandidate[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(({ name, resolvedPath }) => validateBinary(name, resolvedPath, timeoutMs, env)),
    );
    validated.push(...results);
  }

  const candidates = attachConflicts(validated).sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    const ia = KNOWN_AGENT_BINARIES.indexOf(a.binary as typeof KNOWN_AGENT_BINARIES[number]);
    const ib = KNOWN_AGENT_BINARIES.indexOf(b.binary as typeof KNOWN_AGENT_BINARIES[number]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const selected = pickSelected(candidates);
  const status = candidates.length === 0 ? "empty" : selected ? "resolved" : "ambiguous";

  const pathHash = computePathHash(searchDirs);

  const result = { candidates, selected, pathHash, status };
  const parsed = DiscoveryResult.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Invalid DiscoveryResult: ${parsed.error.message}`);
  }
  return parsed.data;
}
