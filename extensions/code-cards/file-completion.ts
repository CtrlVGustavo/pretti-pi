import { execFile } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { parseCodeCommand, quoteFilePath, resolveFilePath, safeText } from "./core.ts";

const exec = promisify(execFile);
const MAX_CANDIDATES = 20_000;
const MAX_RESULTS = 20;
const TIMEOUT_MS = 2_000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".worktrees"]);

/** Non-Git fallback. Never follow directory symlinks or walk an unbounded tree. */
async function walkFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const pending = [""];
	let visited = 0;
	while (pending.length && visited < MAX_CANDIDATES) {
		const directory = pending.shift()!;
		try {
			for await (const entry of await opendir(join(cwd, directory))) {
				signal.throwIfAborted();
				if (++visited > MAX_CANDIDATES) break;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					if (!SKIP_DIRECTORIES.has(entry.name) && path.split("/").length < 20) pending.push(path);
				} else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
			}
		} catch (error) {
			signal.throwIfAborted();
			if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
		}
	}
	return files;
}

async function projectFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
	try {
		// NUL separation preserves spaces/quotes. Git handles nested ignores, worktrees,
		// tracked ignored files, and cwd-relative paths without shell interpolation.
		const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
			cwd, signal, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
		});
		return [...new Set(stdout.split("\0").filter(Boolean))].slice(0, MAX_CANDIDATES);
	} catch (error) {
		signal.throwIfAborted();
		const failure = error as NodeJS.ErrnoException & { stderr?: string };
		if (failure.code === "ENOENT" || failure.stderr?.includes("not a git repository")) return walkFiles(cwd, signal);
		return [];
	}
}

function completionQuery(input: string): { query: string; suffix: string } {
	const value = input.trimStart();
	if (!value) return { query: "", suffix: "" };
	try {
		const command = parseCodeCommand(`--file ${value}`);
		if (command.kind === "file") {
			return { query: command.request.path, suffix: /:\d+(?::\d+)?$/.exec(value)?.[0] ?? "" };
		}
	} catch { /* A partially typed quote is expected during completion. */ }
	return { query: value.replace(/^["']/, "").replace(/\\(["\\])/g, "$1"), suffix: "" };
}

/** Async, bounded discovery; completion never reads file contents or opens an editor. */
export async function fileCompletions(cwd: string, input: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
	const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
	try {
		boundedSignal.throwIfAborted();
		const { query: rawQuery, suffix } = completionQuery(input);
		const query = rawQuery.replace(/^\.\//, "");
		const external = isAbsolute(rawQuery) || rawQuery.startsWith("~/") || rawQuery.startsWith("../");
		let candidates: string[];
		let search = query;
		if (external) {
			// Explicit external paths browse one directory at a time, not the whole home/root.
			const slash = query.lastIndexOf("/");
			const base = query.slice(0, slash + 1);
			search = query.slice(slash + 1);
			candidates = [];
			for await (const entry of await opendir(resolveFilePath(cwd, base))) {
				boundedSignal.throwIfAborted();
				candidates.push(base + entry.name);
				if (candidates.length >= MAX_CANDIDATES) break;
			}
		} else {
			candidates = await projectFiles(cwd, boundedSignal);
		}
		// Control characters cannot be inserted into the one-line command safely.
		candidates = candidates.filter((path) => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(path)).sort();
		const ranked = fuzzyFilter(candidates, search, (path) => external ? path.slice(path.lastIndexOf("/") + 1) : path);
		const items: AutocompleteItem[] = [];
		for (const path of ranked.slice(0, MAX_RESULTS * 3)) {
			boundedSignal.throwIfAborted();
			try {
				const info = await stat(resolveFilePath(cwd, external ? path : `./${path}`));
				if (!info.isFile() && !(external && info.isDirectory())) continue;
				const display = path + (info.isDirectory() ? "/" : "");
				// Project paths starting with ~ or @ must stay literal, not expand to home/attachments.
				const literal = !external && /^[~@]/.test(display) ? `./${display}` : display;
				items.push({
					value: `--file ${quoteFilePath(literal)}${info.isDirectory() ? "" : suffix}`,
					label: safeText(display), description: info.isDirectory() ? "Directory" : "Open file in Neovim",
				});
				if (items.length === MAX_RESULTS) break;
			} catch { boundedSignal.throwIfAborted(); /* Deleted, inaccessible, or broken symlink. */ }
		}
		return items;
	} catch { return []; }
}

export interface FileCompletionContext {
	cwd: string;
	signal: AbortSignal;
}

/** Intercept both natural suggestions and forced Tab; delegate all other commands/cards. */
export function createFileAutocompleteProvider(
	current: AutocompleteProvider,
	getContext: () => FileCompletionContext | undefined,
): AutocompleteProvider {
	const match = (lines: string[], line: number, col: number) =>
		/^\/code(?::\d+)?[ \t]+(--file[ \t]+)(.*)$/.exec((lines[line] ?? "").slice(0, col));
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, line, col, options) {
			const matched = match(lines, line, col);
			const context = getContext();
			if (!matched || !context) return current.getSuggestions(lines, line, col, options);
			const signal = AbortSignal.any([options.signal, context.signal]);
			const items = await fileCompletions(context.cwd, matched[2], signal);
			return signal.aborted || !items.length ? null : { items, prefix: matched[1] + matched[2] };
		},
		applyCompletion(lines, line, col, item, prefix) {
			if (!match(lines, line, col) || !/^--file[ \t]+/.test(prefix)) {
				return current.applyCompletion(lines, line, col, item, prefix);
			}
			const text = lines[line] ?? "";
			const before = text.slice(0, col - prefix.length);
			let after = text.slice(col);
			const quote = prefix.replace(/^--file[ \t]+/, "")[0];
			// When completing inside quotes, replace the closing quote as well.
			if ((quote === '"' || quote === "'") && after.startsWith(quote)) after = after.slice(1);
			const updated = [...lines];
			updated[line] = before + item.value + after;
			const insideDirectoryQuote = item.label.endsWith("/") && item.value.endsWith('"');
			return { lines: updated, cursorLine: line, cursorCol: before.length + item.value.length - (insideDirectoryQuote ? 1 : 0) };
		},
		shouldTriggerFileCompletion(lines, line, col) {
			return match(lines, line, col) ? true : current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
		},
	};
}
