import fs from "node:fs";
import path from "node:path";
import { HarnessConfig, HarnessMode } from "./types.js";

const CONFIG_PATH = ".slad-os/harness.json";

/**
 * Loads harness config from .slad-os/harness.json, merged with the CLI mode override.
 * The CLI flag always wins over the file config.
 */
export function loadHarnessConfig(
  modeOverride: HarnessMode,
  cwd = process.cwd(),
): HarnessConfig {
  const configPath = path.join(cwd, CONFIG_PATH);
  let fileConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      // Invalid config — use defaults
    }
  }

  return HarnessConfig.parse({
    ...fileConfig,
    mode: modeOverride, // CLI flag always wins
  });
}
