import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
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
  "auth.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc",
  ".pypirc", ".ds_store", "herdr-agent-state.ts",
]);

/** A preflight file identity; reads must match it before source is submitted. */
export interface SelectedSourceFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly stat: Stats;
}

/** Bounded file selection; skipped files remain visible in the coverage report. */
export interface SourceSelection {
  readonly root: string;
  readonly discovered: number;
  readonly selected: number;
  readonly candidates: readonly SelectedSourceFile[];
  readonly outcomes: readonly FileClassificationOutcome[];
}

/** Read-only project selection with ignore rules, safe exclusions, and preflight budgets. */
export const selectSourceFiles = Effect.fn("selectSourceFiles")(function*(
  cwd: string, selection: FileSelection,
): Effect.fn.Return<SourceSelection, FileScanError> {
  const root = yield* Effect.tryPromise({
    try: () => realpath(cwd),
    catch: (): FileScanError => ({ tag: "DiscoveryFailed", message: "Jev files cannot open the project directory." }),
  });

  const discovered = yield* discoverProjectFiles(root);
  const eligible = new Set(discovered);

  const paths = yield* Effect.try({
    try: () => selection.kind === "paths"
      ? [...new Set(selection.paths)]
      : discovered.filter(path =>
          selection.include.some(glob => matchesGlob(path, glob)) &&
          !(selection.exclude ?? []).some(glob => matchesGlob(path, glob))),
    catch: (): FileScanError => ({ tag: "InvalidRequest", message: "Jev files glob is not supported." }),
  });

  paths.sort();

  if (paths.length > 200) return yield* Effect.fail<FileScanError>({ tag: "ScanLimit", message: "Jev files selection exceeds 200 files. Narrow the selection." });
  const candidates: SelectedSourceFile[] = [];
  const outcomes: FileClassificationOutcome[] = [];
  let bytes = 0;

  for (const path of paths) {
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

    const preflight = yield* Effect.tryPromise({
      try: async () => {
        if (!isWithinRoot(root, absolutePath) || !(await hasSafePathComponents(root, path))) {
          return { status: "skipped", path, reason: "symlink" } as const;
        }

        const stat = await lstat(absolutePath);

        if (!stat.isFile()) return { status: "skipped", path, reason: "not-regular" } as const;

        if (stat.size > MAX_FILE_BYTES) return { status: "skipped", path, reason: "oversized" } as const;

        return { path, absolutePath, stat };
      },
      catch: () => ({ status: "failed", path, reason: "unreadable" } as const),
    }).pipe(Effect.catch(outcome => Effect.succeed(outcome)));

    if (preflight.status !== undefined) { outcomes.push(preflight); continue; }

    bytes += preflight.stat.size;

    if (bytes > MAX_SCAN_BYTES) return yield* Effect.fail<FileScanError>({ tag: "ScanLimit", message: "Jev files selection exceeds 5 MiB. Narrow the selection." });
    candidates.push(preflight);
  }

  return { root, discovered: discovered.length, selected: paths.length, candidates, outcomes };
});

/** Read exactly one bounded UTF-8 file snapshot; cleanup waits for native I/O to settle. */
export const readSelectedSource = Effect.fn("readSelectedSource")(function*(root: string, file: SelectedSourceFile): Effect.fn.Return<
  { readonly content: string; readonly digest: string; readonly bytes: number },
  Exclude<FileClassificationOutcome, { status: "classified" | "preview" }>
> {
  const failed = (reason: "file-changed" | "unreadable") => ({ status: "failed", path: file.path, reason } as const);

  const safePath = yield* Effect.tryPromise({
    try: async () => isWithinRoot(root, file.absolutePath) && resolve(root, file.path) === file.absolutePath &&
      await hasSafePathComponents(root, file.path) && await realpath(file.absolutePath) === file.absolutePath,
    catch: () => failed("unreadable"),
  });

  if (!safePath) return yield* Effect.fail(failed("file-changed"));

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      catch: () => failed("unreadable"),
    }),
    handle => Effect.gen(function*() {
      // Node cannot cancel these handle operations. Finish each one before closing the handle.
      const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({
        try: operation, catch: () => failed("unreadable"),
      }).pipe(Effect.uninterruptible);

      const before = yield* io(() => handle.stat());

      if (!before.isFile() || !sameFileSnapshot(before, file.stat)) return yield* Effect.fail(failed("file-changed"));
      const buffer = Buffer.alloc(before.size + 1);
      let bytesRead = 0;

      while (bytesRead < buffer.length) {
        const read = yield* io(() => handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead));

        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }

      const unchanged = bytesRead === before.size && sameFileSnapshot(before, yield* io(() => handle.stat())) &&
        (yield* io(() => hasSafePathComponents(root, file.path))) &&
        sameFileSnapshot(before, yield* io(() => lstat(file.absolutePath)));

      if (!unchanged) return yield* Effect.fail(failed("file-changed"));
      const bytes = buffer.subarray(0, bytesRead);
      const binary = { status: "skipped", path: file.path, reason: "binary" } as const;

      if (bytes.includes(0)) return yield* Effect.fail(binary);

      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        catch: () => binary,
      });

      return { content, bytes: bytesRead, digest: createHash("sha256").update(bytes).digest("hex") };
    }),
    handle => Effect.tryPromise({ try: () => handle.close(), catch: () => failed("unreadable") }),
  );
});

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
    // oxlint-disable-next-line no-control-regex -- Control characters make project paths unsafe.
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

const discoverProjectFiles = Effect.fn("discoverProjectFiles")(function*(root: string): Effect.fn.Return<string[], FileScanError> {
  const args = ["--files", "--hidden", "--null", "--no-config", "--no-require-git",
    ...excludedDirectories.flatMap(directory => ["--glob", "!" + directory + "/**"]),
    ...piRuntimeDirectories.flatMap(directory => [
      "--glob", "!**/.pi/" + directory + "/**",
      "--glob", "!**/.pi/agent/" + directory + "/**",
    ])];

  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
        const ignoreError = () => {};

        child.on("error", ignoreError);
        const closed = new Promise<void>(resolveClosed => child.once("close", () => resolveClosed()));

        return { child, closed, ignoreError };
      },
      catch: (): FileScanError => ({ tag: "DiscoveryFailed", message: "Jev files discovery failed. Check that ripgrep is installed." }),
    }),
    ({ child }) => Effect.callback<string[], FileScanError>(resume => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let limited = false;
      let processError = false;
      const onError = () => { processError = true; };

      const onData = (chunk: Buffer) => {
        bytes += chunk.length;

        if (bytes > MAX_DISCOVERY_BYTES) { limited = true; child.kill("SIGKILL"); }
        else chunks.push(chunk);
      };

      const onClose = (code: number | null) => {
        const fail = (tag: FileScanError["tag"], message: string) => resume(Effect.fail({ tag, message }));

        if (limited) {
          fail("ScanLimit", "Jev files discovery exceeds its path budget.");

          return;
        }

        if (processError || (code !== 0 && code !== 1)) {
          fail("DiscoveryFailed", "Jev files discovery failed. Check that ripgrep is installed.");

          return;
        }

        const decoded = Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
          catch: (): FileScanError => ({ tag: "DiscoveryFailed", message: "Jev files discovery contains a non-UTF-8 path." }),
        });

        resume(decoded.pipe(Effect.flatMap(decodedPaths => {
          const paths = [...new Set(decodedPaths.split("\0").filter(Boolean))];

          if (paths.some(path => path.length > 1024)) return Effect.fail<FileScanError>({ tag: "ScanLimit", message: "Jev files discovery contains a path over 1024 characters." });

          if (paths.length > MAX_DISCOVERED_FILES) return Effect.fail<FileScanError>({ tag: "ScanLimit", message: "Jev files discovery exceeds 50000 paths." });

          return Effect.succeed(paths);
        })));
      };

      child.on("error", onError);
      child.stdout.on("data", onData);
      child.on("close", onClose);

      return Effect.sync(() => {
        child.off("error", onError);
        child.stdout.off("data", onData);
        child.off("close", onClose);
      });
    }),
    ({ child, closed, ignoreError }) => Effect.promise(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");

      return closed.finally(() => child.off("error", ignoreError));
    }),
  );
});
