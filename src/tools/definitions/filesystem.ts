import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { ToolDefinition } from "../types.js";

// ─── readFile ─────────────────────────────────────────────────────────────────

export const readFileDef: ToolDefinition = {
  name: "readFile",
  description: "Lee el contenido de un archivo. Retorna el texto completo. Si el archivo supera 500 líneas, retorna las primeras 200 con indicador de truncado.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
  ],
  permissionLevel: "read",
};

export async function readFileExec(args: { path: string }, cwd: string): Promise<string> {
  const fullPath = path.resolve(cwd, args.path);
  // Seguridad: no salir del cwd
  if (!fullPath.startsWith(path.resolve(cwd) + path.sep) && fullPath !== path.resolve(cwd)) {
    throw new Error(`Path traversal detectado: ${args.path}`);
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Archivo no existe: ${args.path}`);
  }
  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  if (lines.length > 500) {
    return lines.slice(0, 200).join("\n") + `\n... [TRUNCADO: ${lines.length} líneas totales, mostrando 200]`;
  }
  return content;
}

// ─── writeFile ────────────────────────────────────────────────────────────────

export const writeFileDef: ToolDefinition = {
  name: "writeFile",
  description: "Escribe contenido a un archivo. Crea directorios intermedios si no existen.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
    { name: "content", type: "string", description: "Contenido a escribir", required: true },
  ],
  permissionLevel: "workspace",
};

export async function writeFileExec(args: { path: string; content: string }, cwd: string): Promise<string> {
  const fullPath = path.resolve(cwd, args.path);
  if (!fullPath.startsWith(path.resolve(cwd) + path.sep) && fullPath !== path.resolve(cwd)) {
    throw new Error(`Path traversal detectado: ${args.path}`);
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, args.content, "utf8");
  return `Escrito: ${args.path} (${args.content.length} chars)`;
}

// ─── listDir ──────────────────────────────────────────────────────────────────

export const listDirDef: ToolDefinition = {
  name: "listDir",
  description: "Lista archivos y directorios en un path.",
  parameters: [
    { name: "path", type: "string", description: "Path relativo al proyecto", required: true },
    { name: "recursive", type: "boolean", description: "Incluir subdirectorios recursivamente", required: false },
  ],
  permissionLevel: "read",
};

export async function listDirExec(args: { path: string; recursive?: boolean }, cwd: string): Promise<string> {
  const fullPath = path.resolve(cwd, args.path);
  if (!fullPath.startsWith(path.resolve(cwd) + path.sep) && fullPath !== path.resolve(cwd)) {
    throw new Error(`Path traversal detectado: ${args.path}`);
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directorio no existe: ${args.path}`);
  }

  function listRecursive(dir: string, base: string, depth: number): string[] {
    if (depth > 5) return ["... [MAX DEPTH]"];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = path.join(base, entry.name);
      result.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory() && args.recursive) {
        result.push(...listRecursive(path.join(dir, entry.name), rel, depth + 1));
      }
    }
    return result;
  }

  const entries = listRecursive(fullPath, "", 0);
  return entries.length > 0 ? entries.join("\n") : "(directorio vacío)";
}

// ─── grep ─────────────────────────────────────────────────────────────────────

export const grepDef: ToolDefinition = {
  name: "grep",
  description: "Busca un patrón regex en archivos del proyecto. Retorna líneas con matches y sus paths.",
  parameters: [
    { name: "pattern", type: "string", description: "Regex pattern a buscar", required: true },
    { name: "glob", type: "string", description: "Glob de archivos a buscar (default: src/**/*.ts)", required: false },
  ],
  permissionLevel: "read",
};

export async function grepExec(args: { pattern: string; glob?: string }, cwd: string): Promise<string> {
  const globPattern = args.glob ?? "src/**/*.ts";
  try {
    const output = execSync(
      `grep -rn --include="${globPattern.replace("**/*", "*")}" -E "${args.pattern.replace(/"/g, '\\"')}" .`,
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    );
    const lines = output.trim().split("\n").slice(0, 50);
    const result = lines.join("\n");
    return result || "(sin matches)";
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    // exit code 1 = sin matches (normal en grep)
    if (e.status === 1) return "(sin matches)";
    return `(sin matches para: ${args.pattern})`;
  }
}
