import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
	SessionManager,
	type ExecResult,
	type ExtensionAPI,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { fuzzyMatch, Input, type Component, type Focusable, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface WorktreeEntry {
	path: string;
	head: string;
	branch?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
	main: boolean;
	current: boolean;
	sessions?: SessionInfo[];
}

interface SearchToken {
	kind: "fuzzy" | "phrase";
	value: string;
}

interface ParsedSearch {
	mode: "tokens" | "regex";
	tokens: SearchToken[];
	regex: RegExp | null;
	error?: string;
}

interface WorktreeMatch {
	worktree: WorktreeEntry;
	session?: SessionInfo;
	score: number;
}

interface WorktreeSelection {
	worktree: WorktreeEntry;
	session?: SessionInfo;
}

function commandError(args: string[], result: ExecResult): Error {
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	return new Error(`git ${args.join(" ")} failed (exit ${result.code})${output ? `:\n${output}` : ""}`);
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) {
		throw commandError(args, result);
	}
	return result;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function parseWorktrees(output: string): WorktreeEntry[] {
	return output
		.split("\0\0")
		.filter(Boolean)
		.map((record, index) => {
			const entry: WorktreeEntry = {
				path: "",
				head: "",
				bare: false,
				detached: false,
				locked: false,
				prunable: false,
				main: index === 0,
				current: false,
			};

			for (const field of record.split("\0")) {
				if (field.startsWith("worktree ")) {
					entry.path = field.slice("worktree ".length);
				} else if (field.startsWith("HEAD ")) {
					entry.head = field.slice("HEAD ".length);
				} else if (field.startsWith("branch ")) {
					entry.branch = field.slice("branch ".length);
				} else if (field === "bare") {
					entry.bare = true;
				} else if (field === "detached") {
					entry.detached = true;
				} else if (field === "locked" || field.startsWith("locked ")) {
					entry.locked = true;
				} else if (field === "prunable" || field.startsWith("prunable ")) {
					entry.prunable = true;
				}
			}

			return entry;
		})
		.filter((entry) => entry.path && !entry.bare && !entry.prunable && existsSync(entry.path));
}

function branchName(worktree: WorktreeEntry): string {
	const prefix = "refs/heads/";
	if (worktree.branch?.startsWith(prefix)) {
		return worktree.branch.slice(prefix.length);
	}
	return worktree.detached ? `(detached ${worktree.head.slice(0, 8)})` : "(no branch)";
}

function worktreeSearchText(worktree: WorktreeEntry): string {
	const statuses = [
		worktree.main ? "main" : "",
		worktree.current ? "current" : "",
		worktree.detached ? "detached" : "",
		worktree.locked ? "locked" : "",
	]
		.filter(Boolean)
		.join(" ");
	return `${branchName(worktree)} ${worktree.branch ?? ""} ${basename(worktree.path)} ${worktree.path} ${worktree.head} ${statuses}`;
}

function sessionSearchText(worktree: WorktreeEntry, session: SessionInfo): string {
	return `${worktreeSearchText(worktree)} ${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseSearchQuery(query: string): ParsedSearch {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (error) {
			return { mode: "regex", tokens: [], regex: null, error: errorMessage(error) };
		}
	}

	const tokens: SearchToken[] = [];
	let buffer = "";
	let inQuote = false;
	const flush = (kind: SearchToken["kind"]) => {
		const value = buffer.trim();
		buffer = "";
		if (value) {
			tokens.push({ kind, value });
		}
	};

	for (const character of trimmed) {
		if (character === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
		} else if (!inQuote && /\s/.test(character)) {
			flush("fuzzy");
		} else {
			buffer += character;
		}
	}

	if (inQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((value) => value.trim())
				.filter(Boolean)
				.map((value) => ({ kind: "fuzzy", value })),
			regex: null,
		};
	}
	flush("fuzzy");
	return { mode: "tokens", tokens, regex: null };
}

function matchText(text: string, parsed: ParsedSearch): { matches: boolean; score: number } {
	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const index = text.search(parsed.regex);
		return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
	}

	let score = 0;
	let normalizedText: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			normalizedText ??= normalizeWhitespaceLower(text);
			const phrase = normalizeWhitespaceLower(token.value);
			const index = normalizedText.indexOf(phrase);
			if (index < 0) {
				return { matches: false, score: 0 };
			}
			score += index * 0.1;
		} else {
			const match = fuzzyMatch(token.value, text);
			if (!match.matches) {
				return { matches: false, score: 0 };
			}
			score += match.score;
		}
	}
	return { matches: true, score };
}

function filterWorktrees(worktrees: WorktreeEntry[], query: string): { matches: WorktreeMatch[]; error?: string } {
	const parsed = parseSearchQuery(query);
	if (parsed.error) {
		return { matches: [], error: parsed.error };
	}

	if (!query.trim()) {
		return {
			matches: worktrees.map((worktree) => ({
				worktree,
				session: worktree.sessions?.[0],
				score: 0,
			})),
		};
	}

	const matches: WorktreeMatch[] = [];
	for (const worktree of worktrees) {
		const sessions = worktree.sessions ?? [];
		const candidates = sessions.length > 0 ? sessions : [undefined];
		let best: WorktreeMatch | undefined;

		for (const session of candidates) {
			const result = matchText(session ? sessionSearchText(worktree, session) : worktreeSearchText(worktree), parsed);
			if (!result.matches) {
				continue;
			}
			if (
				!best ||
				result.score < best.score ||
				(result.score === best.score &&
					(session?.modified.getTime() ?? 0) > (best.session?.modified.getTime() ?? 0))
			) {
				best = { worktree, session, score: result.score };
			}
		}

		if (best) {
			matches.push(best);
		}
	}

	matches.sort((left, right) => {
		if (left.score !== right.score) {
			return left.score - right.score;
		}
		return (right.session?.modified.getTime() ?? 0) - (left.session?.modified.getTime() ?? 0);
	});
	return { matches };
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatAge(date: Date): string {
	const milliseconds = Date.now() - date.getTime();
	const minutes = Math.floor(milliseconds / 60_000);
	const hours = Math.floor(milliseconds / 3_600_000);
	const days = Math.floor(milliseconds / 86_400_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function cleanText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

class WorktreeSelector implements Component, Focusable {
	private readonly searchInput = new Input();
	private worktrees: WorktreeEntry[];
	private matches: WorktreeMatch[] = [];
	private selectedIndex = 0;
	private queryError?: string;
	private loadError?: string;
	private loading = true;
	private loadedCount = 0;
	private readonly maxVisible = 7;
	private _focused = false;

	onSelect?: (selection: WorktreeSelection) => void;
	onCancel?: () => void;

	constructor(
		worktrees: WorktreeEntry[],
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
	) {
		this.worktrees = worktrees;
		this.refreshMatches();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	setLoadingProgress(count: number): void {
		this.loadedCount = count;
	}

	setWorktrees(worktrees: WorktreeEntry[]): void {
		this.worktrees = worktrees;
		this.loading = false;
		this.refreshMatches();
	}

	setLoadError(message: string): void {
		this.loading = false;
		this.loadError = message;
	}

	private refreshMatches(): void {
		const result = filterWorktrees(this.worktrees, this.searchInput.getValue());
		this.matches = result.matches;
		this.queryError = result.error;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.matches.length - 1)));
	}

	private statusLabels(worktree: WorktreeEntry): string {
		const labels = [
			worktree.main ? "main" : "",
			worktree.current ? "current" : "",
			worktree.detached ? "detached" : "",
			worktree.locked ? "locked" : "",
		].filter(Boolean);
		return labels.length > 0 ? ` [${labels.join(", ")}]` : "";
	}

	private selectedLine(line: string, selected: boolean, width: number): string {
		const truncated = truncateToWidth(line, width, "");
		if (!selected) {
			return truncated;
		}
		const padded = truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		return this.theme.bg("selectedBg", padded);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = this.theme.fg("borderAccent", "─".repeat(Math.max(0, width)));
		lines.push(border);

		const progress = this.loading ? ` (${this.loadedCount}/${this.worktrees.length} worktrees indexed)` : "";
		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(`Resume Worktree${progress}`)), width, "…"));
		lines.push(this.theme.fg("dim", truncateToWidth('re:<pattern> regex · "phrase" exact', width, "…")));
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.loadError) {
			lines.push(this.theme.fg("error", truncateToWidth(`  ${this.loadError}`, width, "…")));
		} else if (this.queryError) {
			lines.push(this.theme.fg("error", truncateToWidth(`  Invalid regex: ${this.queryError}`, width, "…")));
		} else if (this.matches.length === 0) {
			lines.push(this.theme.fg("muted", truncateToWidth("  No worktrees found", width, "…")));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.matches.length - this.maxVisible),
			);
			const endIndex = Math.min(startIndex + this.maxVisible, this.matches.length);

			for (let index = startIndex; index < endIndex; index++) {
				const match = this.matches[index];
				const selected = index === this.selectedIndex;
				const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
				const label = `${branchName(match.worktree)}${this.statusLabels(match.worktree)}`;
				const path = truncateToWidth(shortenPath(match.worktree.path), Math.max(10, Math.floor(width * 0.48)), "…");
				const availableLabel = Math.max(1, width - 2 - visibleWidth(path) - 1);
				let styledLabel = truncateToWidth(label, availableLabel, "…");
				if (selected) {
					styledLabel = this.theme.bold(styledLabel);
				}
				const left = cursor + styledLabel;
				const spacing = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(path)));
				lines.push(this.selectedLine(`${left}${spacing}${this.theme.fg("dim", path)}`, selected, width));

				const session = match.session;
				const sessionTitle = session
					? cleanText(session.name ?? session.firstMessage) || session.id
					: "(new session)";
				const sessionRight = session ? `${session.messageCount} msgs ${formatAge(session.modified)}` : "";
				const prefix = "    ↳ ";
				const availableTitle = Math.max(1, width - visibleWidth(prefix) - visibleWidth(sessionRight) - 1);
				const title = truncateToWidth(sessionTitle, availableTitle, "…");
				const detailSpacing = " ".repeat(
					Math.max(1, width - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(sessionRight)),
				);
				const detail = `${this.theme.fg("dim", prefix + title)}${detailSpacing}${this.theme.fg("dim", sessionRight)}`;
				lines.push(this.selectedLine(detail, selected, width));
			}

			if (startIndex > 0 || endIndex < this.matches.length) {
				lines.push(
					this.theme.fg(
						"muted",
						truncateToWidth(`  (${this.selectedIndex + 1}/${this.matches.length})`, width, ""),
					),
				);
			}
		}

		const help = this.loading
			? "Loading session text… · esc cancel"
			: "↑↓ navigate · enter resume · esc cancel";
		lines.push(this.theme.fg("dim", truncateToWidth(help, width, "…")));
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.matches.length > 0) {
				this.selectedIndex = Math.min(this.matches.length - 1, this.selectedIndex + 1);
			}
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			if (this.matches.length > 0) {
				this.selectedIndex = Math.min(this.matches.length - 1, this.selectedIndex + this.maxVisible);
			}
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (!this.loading && !this.loadError) {
				const selected = this.matches[this.selectedIndex];
				if (selected) {
					this.onSelect?.({ worktree: selected.worktree, session: selected.session });
				}
			}
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.searchInput.handleInput(data);
			this.refreshMatches();
		}
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

async function createSessionFile(targetCwd: string): Promise<string> {
	const targetSession = SessionManager.create(targetCwd);
	const targetSessionFile = targetSession.getSessionFile();
	if (!targetSessionFile) {
		throw new Error(`Failed to create a session for ${targetCwd}`);
	}

	if (!existsSync(targetSessionFile)) {
		const header = targetSession.getHeader();
		if (!header) {
			throw new Error(`Failed to create a session header for ${targetCwd}`);
		}
		await mkdir(dirname(targetSessionFile), { recursive: true });
		await writeFile(targetSessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}
	return targetSessionFile;
}

export default function worktreesExtension(pi: ExtensionAPI) {
	pi.registerCommand("worktrees", {
		description: "Search worktrees and their Pi sessions, then resume one",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("worktrees requires interactive mode", "error");
				return;
			}
			await ctx.waitForIdle();

			let worktrees: WorktreeEntry[];
			try {
				const [repoRootResult, worktreeListResult] = await Promise.all([
					runGit(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]),
					runGit(pi, ctx.cwd, ["worktree", "list", "--porcelain", "-z"]),
				]);
				const currentPath = await canonicalPath(repoRootResult.stdout.trim());
				worktrees = parseWorktrees(worktreeListResult.stdout);
				await Promise.all(
					worktrees.map(async (worktree) => {
						worktree.current = (await canonicalPath(worktree.path)) === currentPath;
					}),
				);
				if (worktrees.length === 0) {
					throw new Error("No usable worktrees found in the current Git repository");
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const selection = await ctx.ui.custom<WorktreeSelection | null>((tui, theme, keybindings, done) => {
				const selector = new WorktreeSelector(worktrees, theme, keybindings);
				let active = true;
				selector.onSelect = (value) => {
					active = false;
					done(value);
				};
				selector.onCancel = () => {
					active = false;
					done(null);
				};

				let loadedCount = 0;
				Promise.all(
					worktrees.map(async (worktree) => {
						const sessions = await SessionManager.list(worktree.path);
						sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
						loadedCount++;
						if (active) {
							selector.setLoadingProgress(loadedCount);
							tui.requestRender();
						}
						return { ...worktree, sessions };
					}),
				)
					.then((loadedWorktrees) => {
						if (active) {
							selector.setWorktrees(loadedWorktrees);
							tui.requestRender();
						}
					})
					.catch((error) => {
						if (active) {
							selector.setLoadError(errorMessage(error));
							tui.requestRender();
						}
					});

				return {
					get focused() {
						return selector.focused;
					},
					set focused(value: boolean) {
						selector.focused = value;
					},
					render: (width: number) => selector.render(width),
					handleInput: (data: string) => {
						selector.handleInput(data);
						tui.requestRender();
					},
					invalidate: () => selector.invalidate(),
				};
			});

			if (!selection) {
				return;
			}

			let targetSessionFile: string;
			try {
				targetSessionFile = selection.session?.path ?? (await createSessionFile(selection.worktree.path));
				const currentSessionFile = ctx.sessionManager.getSessionFile();
				if (
					currentSessionFile &&
					(await canonicalPath(currentSessionFile)) === (await canonicalPath(targetSessionFile))
				) {
					ctx.ui.notify(`Already working in ${selection.worktree.path}`, "info");
					return;
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const selectedPath = selection.worktree.path;
			const selectedBranch = branchName(selection.worktree);
			const switchResult = await ctx.switchSession(targetSessionFile, {
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(`Now working in ${selectedPath} on ${selectedBranch}`, "info");
				},
			});

			if (switchResult.cancelled) {
				ctx.ui.notify("Worktree session switch cancelled", "warning");
			}
		},
	});
}
