import { execSync } from "node:child_process";
import type { ToolDefinition } from "../types.js";

export const execDef: ToolDefinition = {
  name: "exec",
  description: "Ejecuta un comando shell en el directorio del proyecto. Timeout 30s. El harness clasifica el nivel de riesgo real del comando.",
  parameters: [
    { name: "command", type: "string", description: "Comando a ejecutar", required: true },
    { name: "timeout", type: "number", description: "Timeout en ms (default 30000)", required: false },
  ],
  // El harness reclasifica según el contenido real del comando
  // readOnly: npm test, tsc, cat → "read"
  // workspace: git add/commit, npm install, touch → "workspace"
  // full: rm -rf, sudo, git push --force → "full"
  permissionLevel: "full",
};

export async function execExec(args: { command: string; timeout?: number }, cwd: string): Promise<string> {
  const timeout = args.timeout ?? 30000;
  try {
    const output = execSync(args.command, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024, // 1MB
    });
    return output.trim() || "(sin output)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; status?: number };
    const stderr = e.stderr?.trim() ?? "";
    const stdout = e.stdout?.trim() ?? "";
    const parts = [
      `ERROR (exit ${e.status ?? "?"})`,
      stderr ? `stderr: ${stderr}` : null,
      stdout ? `stdout: ${stdout}` : null,
    ].filter(Boolean);
    return parts.join("\n");
  }
}
