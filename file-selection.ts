import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { FileSelection, FileClassificationOutcome, FileScanError } from "./file-classification-contract.ts";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const MAX_DISCOVERED_FILES = 50_000;
const excludedDirectories = [
  ".git", "node_modules", "vendor", "dist", "build", "coverage", ".next",
  ".cache", "target", ".venv", "__pycache__",
];
const piRuntimeDirectories = ["sessions", "oauth", "npm", "bin", "logs"];
const deniedNames = new Set([
  "auth.json", "credentials", "credentials.json", "credentials.toml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc",
  ".pypirc", ".ds_store", "herdr-agent-state.ts",
]);

/** A preflight file identity; reads must match it before source is submitted. */
export interface SelectedSourceFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly stat: Stats;
}
/** Bounded file selection; skipped files remain visible in the coverage report. */
export type SourceSelection =
  | { readonly status: "ok"; readonly root: string; readonly discovered: number; readonly selected: number;
      readonly candidates: readonly SelectedSourceFile[]; readonly outcomes: readonly FileClassificationOutcome[] }
  | { readonly status: "error"; readonly error: FileScanError };

/** Read-only project selection with ignore rules, safe exclusions, and preflight budgets. */
export async function selectSourceFiles(cwd: string, selection: FileSelection, signal: AbortSignal): Promise<SourceSelection> {
  let root: string;
  try { root = await realpath(cwd); }
  catch { return { status: "error", error: { tag: "DiscoveryFailed", message: "Jev files cannot open the project directory." } }; }
  const discovered = await discoverProjectFiles(root, signal);
  if (discovered.status === "error") return discovered;
  const eligible = new Set(discovered.paths);
  let paths: string[];
  try {
    paths = selection.kind === "paths"
      ? [...new Set(selection.paths)]
      : discovered.paths.filter(path =>
          selection.include.some(glob => matchesGlob(path, glob)) &&
          !(selection.exclude ?? []).some(glob => matchesGlob(path, glob)));
  } catch {
    return { status: "error", error: { tag: "InvalidRequest", message: "Jev files glob is not supported." } };
  }
  paths.sort();
  if (paths.length > 200) return { status: "error", error: { tag: "ScanLimit", message: "Jev files selection exceeds 200 files. Narrow the selection." } };
  const candidates: SelectedSourceFile[] = [];
  const outcomes: FileClassificationOutcome[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (signal.aborted) return { status: "error", error: { tag: "Cancelled", message: "Jev files selection was cancelled." } };
    if (isExcludedSourcePath(path)) {
      outcomes.push({ status: "skipped", path, reason: "excluded" });
      continue;
    }
    // Exact paths cannot bypass ignore rules. Missing paths are reported, not read directly.
    if (!eligible.has(path)) {
      outcomes.push({ status: "skipped", path, reason: "not-eligible" });
      continue;
    }
    const absolutePath = resolve(root, path);
    try {
      if (!isWithinRoot(root, absolutePath) || !(await hasSafePathComponents(root, path))) {
        outcomes.push({ status: "skipped", path, reason: "symlink" }); continue;
      }
      const stat = await lstat(absolutePath);
      if (!stat.isFile()) {
        outcomes.push({ status: "skipped", path, reason: "not-regular" }); continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        outcomes.push({ status: "skipped", path, reason: "oversized" }); continue;
      }
      bytes += stat.size;
      if (bytes > MAX_SCAN_BYTES) return { status: "error", error: { tag: "ScanLimit", message: "Jev files selection exceeds 5 MiB. Narrow the selection." } };
      candidates.push({ path, absolutePath, stat });
    } catch {
      outcomes.push({ status: "failed", path, reason: "unreadable" });
    }
  }
  return { status: "ok", root, discovered: discovered.paths.length, selected: paths.length, candidates, outcomes };
}

/** Read exactly one bounded UTF-8 file snapshot; no source appears in returned failures. */
export async function readSelectedSource(root: string, file: SelectedSourceFile, signal: AbortSignal): Promise<
  | { readonly status: "ok"; readonly content: string; readonly digest: string; readonly bytes: number }
  | { readonly status: "error"; readonly outcome: FileClassificationOutcome }
> {
  const failed = (reason: "file-changed" | "unreadable") =>
    ({ status: "error", outcome: { status: "failed", path: file.path, reason } } as const);
  if (signal.aborted) return { status: "error", outcome: { status: "unprocessed", path: file.path, reason: "cancelled" } };
  try {
    if (!isWithinRoot(root, file.absolutePath) || resolve(root, file.path) !== file.absolutePath ||
        !(await hasSafePathComponents(root, file.path)) ||
        (await realpath(file.absolutePath)) !== file.absolutePath) return failed("file-changed");
    const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameFileSnapshot(before, file.stat)) return failed("file-changed");
      const buffer = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length && !signal.aborted) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (signal.aborted) return { status: "error", outcome: { status: "unprocessed", path: file.path, reason: "cancelled" } };
      if (bytesRead !== before.size || !sameFileSnapshot(before, await handle.stat()) ||
          !(await hasSafePathComponents(root, file.path)) ||
          !sameFileSnapshot(before, await lstat(file.absolutePath))) return failed("file-changed");
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return { status: "error", outcome: { status: "skipped", path: file.path, reason: "binary" } };
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { status: "error", outcome: { status: "skipped", path: file.path, reason: "binary" } };
      }
      return { status: "ok", content, bytes: bytesRead, digest: createHash("sha256").update(bytes).digest("hex") };
    } finally { await handle.close(); }
  } catch { return failed("unreadable"); }
}

function isWithinRoot(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && !part.startsWith("../") && part !== ".." && !isAbsolute(part);
}

function isExcludedSourcePath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return parts.some(part => excludedDirectories.includes(part) || part === ".ssh" || part === ".aws") ||
    deniedNames.has(name) || name.startsWith(".env") ||
    /\.(pem|key|p12|pfx|keystore)$/u.test(name) ||
    // Sensitive data names stay denied; source and style names are not secret detection.
    ((extname(name) === "" || /\.(jsonc?|toml|yaml|yml|ini|cfg|conf|txt|csv|xml|properties|log|bak)$/u.test(name)) &&
      /(^|[-_.])(credentials|secrets|tokens)([-_.]|$)/u.test(name)) ||
    parts.some((part, index) => part === ".pi" &&
      piRuntimeDirectories.includes(parts[index + (parts[index + 1] === "agent" ? 2 : 1)] ?? "")) ||
    /[\x00-\x1f\x7f\\]/u.test(path);
}

async function hasSafePathComponents(root: string, path: string): Promise<boolean> {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function discoverProjectFiles(root: string, signal: AbortSignal): Promise<
  | { readonly status: "ok"; readonly paths: string[] }
  | { readonly status: "error"; readonly error: FileScanError }
> {
  return new Promise(resolveResult => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let limited = false;
    let processError = false;
    const args = ["--files", "--hidden", "--null", "--no-config", "--no-require-git",
      ...excludedDirectories.flatMap(directory => ["--glob", "!" + directory + "/**"]),
      ...piRuntimeDirectories.flatMap(directory => [
        "--glob", "!**/.pi/" + directory + "/**",
        "--glob", "!**/.pi/agent/" + directory + "/**",
      ])];
    const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.on("error", () => { processError = true; });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_DISCOVERY_BYTES) { limited = true; stop(); }
      else chunks.push(chunk);
    });
    child.on("close", code => {
      signal.removeEventListener("abort", stop);
      const error = (tag: FileScanError["tag"], message: string) => resolveResult({ status: "error", error: { tag, message } });
      if (signal.aborted) { error("Cancelled", "Jev files discovery was cancelled."); return; }
      if (limited) { error("ScanLimit", "Jev files discovery exceeds its path budget."); return; }
      if (processError || (code !== 0 && code !== 1)) { error("DiscoveryFailed", "Jev files discovery failed. Check that ripgrep is installed."); return; }
      let decodedPaths: string;
      try { decodedPaths = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
      catch { error("DiscoveryFailed", "Jev files discovery contains a non-UTF-8 path."); return; }
      const paths = [...new Set(decodedPaths.split("\0").filter(Boolean))];
      if (paths.some(path => path.length > 1024)) { error("ScanLimit", "Jev files discovery contains a path over 1024 characters."); return; }
      if (paths.length > MAX_DISCOVERED_FILES) { error("ScanLimit", "Jev files discovery exceeds 50000 paths."); return; }
      resolveResult({ status: "ok", paths });
    });
  });
}
