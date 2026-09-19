import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	DynamicBorder,
	SessionManager,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

import {
	assertManagedWorktree,
	branchName,
	managedWorktrees,
	parseRemovalArgs,
	parseWorktrees,
	removalCompletions,
	resolveRemovalTarget,
	type WorktreeEntry,
} from "./rmworktree-core.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

async function execGitDirect(cwd: string, args: string[]): Promise<ExecResult> {
	return new Promise<ExecResult>((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") {
				reject(error);
				return;
			}
			resolvePromise({
				stdout,
				stderr,
				code: typeof error?.code === "number" ? error.code : 0,
				killed: error?.killed ?? false,
			});
		});
	});
}

async function runGitDirect(cwd: string, args: string[]): Promise<ExecResult> {
	const result = await execGitDirect(cwd, args);
	if (result.code !== 0) {
		throw commandError(args, result);
	}
	return result;
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

function retentionMessage(worktree: WorktreeEntry): string {
	const prefix = "refs/heads/";
	if (worktree.branch?.startsWith(prefix)) {
		return `Branch ${worktree.branch.slice(prefix.length)} will be retained.`;
	}
	if (worktree.detached) {
		return `This worktree has detached HEAD at ${worktree.head.slice(0, 8)}; removing it may leave commits unreachable.`;
	}
	return "No local branch is attached to this worktree.";
}

function removalSummary(worktree: WorktreeEntry): string {
	const prefix = "refs/heads/";
	return worktree.branch?.startsWith(prefix)
		? `; branch ${worktree.branch.slice(prefix.length)} was retained`
		: "";
}

async function selectLinkedWorktree(
	worktrees: WorktreeEntry[],
	ctx: ExtensionCommandContext,
): Promise<WorktreeEntry | undefined> {
	const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
	const items: SelectItem[] = worktrees.map((worktree) => {
		const flags = [worktree.detached ? "detached" : "", worktree.locked ? "locked" : ""].filter(Boolean);
		return {
			value: worktree.path,
			label: branchName(worktree),
			description: `${worktree.path}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`,
		};
	});

	const selectedPath = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Remove Linked Worktree")), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedPath ? byPath.get(selectedPath) : undefined;
}

async function createSessionFile(sourceSessionFile: string | undefined, targetCwd: string): Promise<string> {
	const targetSession =
		sourceSessionFile && existsSync(sourceSessionFile)
			? SessionManager.forkFrom(sourceSessionFile, targetCwd)
			: SessionManager.create(targetCwd, undefined, { parentSession: sourceSessionFile });
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

async function findRemovalTarget(mainPath: string, targetPath: string): Promise<WorktreeEntry> {
	const worktrees = parseWorktrees((await runGitDirect(mainPath, ["worktree", "list", "--porcelain", "-z"])).stdout);
	const main = worktrees[0];
	if (!main || main.bare || (await canonicalPath(main.path)) !== (await canonicalPath(mainPath))) {
		throw new Error("The repository's main worktree changed; removal was cancelled");
	}

	const canonicalTarget = await canonicalPath(targetPath);
	for (let index = 1; index < worktrees.length; index++) {
		const worktree = worktrees[index];
		if (resolve(worktree.path) === resolve(targetPath) && (await canonicalPath(worktree.path)) === canonicalTarget) {
			assertManagedWorktree(mainPath, worktree);
			return worktree;
		}
	}
	throw new Error("The selected path is no longer a linked worktree; removal was cancelled");
}

async function removeLinkedWorktree(mainPath: string, targetPath: string): Promise<WorktreeEntry> {
	const target = await findRemovalTarget(mainPath, targetPath);
	const args = ["worktree", "remove", "--force"];
	if (target.locked) {
		args.push("--force");
	}
	args.push(target.path);
	await runGitDirect(mainPath, args);
	return target;
}

export default function rmWorktreeExtension(pi: ExtensionAPI) {
	let completionCwd: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		completionCwd = ctx.cwd;
	});
	pi.on("session_shutdown", () => {
		completionCwd = undefined;
	});

	pi.registerCommand("rmworktree", {
		description: "Remove a worktree inside the main checkout's .worktrees/ (optional name or path)",
		getArgumentCompletions: (prefix) => {
			if (!completionCwd) return null;
			try {
				// This API is synchronous. Query local Git with a deadline rather than
				// caching registrations that other Pi sessions or terminals can change.
				const output = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
					cwd: completionCwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "pipe"],
				});
				return removalCompletions(prefix, completionCwd, parseWorktrees(output));
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			completionCwd = ctx.cwd;
			let target: string | undefined;
			try {
				target = parseRemovalArgs(args);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			await ctx.waitForIdle();

			let mainPath: string;
			let selected: WorktreeEntry;
			let removingCurrent: boolean;
			try {
				const [repoRootResult, gitDirResult, commonDirResult, worktreeListResult] = await Promise.all([
					runGit(pi, ctx.cwd, ["rev-parse", "--show-toplevel"]),
					runGit(pi, ctx.cwd, ["rev-parse", "--absolute-git-dir"]),
					runGit(pi, ctx.cwd, ["rev-parse", "--git-common-dir"]),
					runGit(pi, ctx.cwd, ["worktree", "list", "--porcelain", "-z"]),
				]);

				const repoRoot = await canonicalPath(repoRootResult.stdout.trim());
				const gitDir = await canonicalPath(gitDirResult.stdout.trim());
				const commonDir = await canonicalPath(resolve(ctx.cwd, commonDirResult.stdout.trim()));
				const currentIsMain = gitDir === commonDir;

				const worktrees = parseWorktrees(worktreeListResult.stdout);
				const main = worktrees[0];
				if (!main || main.bare || !existsSync(main.path)) {
					throw new Error("Could not find a usable main worktree");
				}
				mainPath = await canonicalPath(main.path);

				const entriesWithPaths = await Promise.all(
					worktrees.map(async (worktree) => ({ worktree, canonicalPath: await canonicalPath(worktree.path) })),
				);
				const currentIndex = entriesWithPaths.findIndex((entry) => entry.canonicalPath === repoRoot);
				if (currentIndex < 0) {
					throw new Error("Could not identify the current Git worktree");
				}
				if (currentIsMain !== (currentIndex === 0 && repoRoot === mainPath)) {
					throw new Error("Git reported inconsistent main-worktree information; removal was cancelled");
				}

				if (target !== undefined) {
					selected = resolveRemovalTarget(target, ctx.cwd, worktrees);
				} else if (currentIsMain) {
					if (ctx.mode !== "tui") {
						throw new Error("Run /rmworktree in interactive mode to select a linked worktree");
					}
					const linked = managedWorktrees(worktrees);
					if (linked.length === 0) {
						throw new Error("No linked worktrees inside the main checkout's .worktrees/ are available to remove");
					}
					const choice = await selectLinkedWorktree(linked, ctx);
					if (!choice) {
						return;
					}
					selected = choice;
				} else {
					selected = worktrees[currentIndex];
					if (!selected || selected.bare) {
						throw new Error("Could not identify the current linked worktree");
					}
				}
				assertManagedWorktree(mainPath, selected);
				removingCurrent = (await canonicalPath(selected.path)) === repoRoot;
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/rmworktree requires confirmation in an interactive UI", "error");
				return;
			}

			let status = "";
			try {
				status = (await runGit(pi, selected.path, ["status", "--porcelain"])).stdout.trim();
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const warning = [
				`Permanently remove ${selected.path}?`,
				retentionMessage(selected),
				"The folder and Git registration will be deleted, including all uncommitted, untracked, and ignored files.",
				status ? "Git currently reports local changes in this worktree." : "",
			]
				.filter(Boolean)
				.join("\n");
			if (!(await ctx.ui.confirm("Remove linked worktree?", warning))) {
				ctx.ui.notify("Worktree removal cancelled", "info");
				return;
			}

			if (!removingCurrent) {
				try {
					const removed = await removeLinkedWorktree(mainPath, selected.path);
					ctx.ui.notify(`Removed ${removed.path}${removalSummary(removed)}`, "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}

			let targetSessionFile: string;
			try {
				targetSessionFile = await createSessionFile(ctx.sessionManager.getSessionFile(), mainPath);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const selectedPath = selected.path;
			const switchResult = await ctx.switchSession(targetSessionFile, {
				withSession: async (replacementCtx) => {
					try {
						const removed = await removeLinkedWorktree(mainPath, selectedPath);
						replacementCtx.ui.notify(
							`Moved to ${mainPath} and removed ${removed.path}${removalSummary(removed)}`,
							"info",
						);
					} catch (error) {
						replacementCtx.ui.notify(
							`Moved to ${mainPath}, but could not remove ${selectedPath}: ${errorMessage(error)}`,
							"error",
						);
					}
				},
			});

			if (switchResult.cancelled) {
				ctx.ui.notify(`Session switch cancelled. Worktree remains at ${selectedPath}.`, "warning");
			}
		},
	});
}
