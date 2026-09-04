import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SessionManager, type ExecResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseMainWorktreePath, prepareManagedWorktreesDirectory } from "./worktree-paths.ts";

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

function pathSegmentForBranch(branch: string): string {
	return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function addWorktreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("addworktree", {
		description: "Create a Git worktree for a named branch and continue this session in it",
		handler: async (args, ctx) => {
			const branch = args.trim();
			if (!branch) {
				ctx.ui.notify("Usage: /addworktree <branch>", "error");
				return;
			}

			await ctx.waitForIdle();

			const sourceCwd = ctx.cwd;
			let prepared: { worktreePath: string; targetSessionFile: string };

			try {
				const repositoryResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: sourceCwd });
				if (repositoryResult.code !== 0) {
					await runGit(pi, sourceCwd, ["init"]);
				}

				const repoRoot = (await runGit(pi, sourceCwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
				const [commonDirResult, worktreeListResult] = await Promise.all([
					runGit(pi, repoRoot, ["rev-parse", "--git-common-dir"]),
					runGit(pi, repoRoot, ["worktree", "list", "--porcelain", "-z"]),
				]);
				const mainWorktreePath = parseMainWorktreePath(worktreeListResult.stdout);
				if (!mainWorktreePath) {
					throw new Error("Could not identify a non-bare main worktree");
				}

				await runGit(pi, repoRoot, ["check-ref-format", "--branch", branch]);
				const targetSegment = pathSegmentForBranch(branch);
				const worktreesDir = await prepareManagedWorktreesDirectory(
					(cwd, gitArgs) => pi.exec("git", gitArgs, { cwd }),
					mainWorktreePath,
					resolve(repoRoot, commonDirResult.stdout.trim()),
					targetSegment,
				);
				const worktreePath = join(worktreesDir, targetSegment);
				if (existsSync(worktreePath)) {
					throw new Error(`Worktree path already exists: ${worktreePath}`);
				}

				const headResult = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
				if (headResult.code !== 0) {
					await runGit(pi, repoRoot, ["add", "--all"]);
					await runGit(pi, repoRoot, ["commit", "--allow-empty", "-m", "init commit"]);
				}

				await runGit(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);

				const branchResult = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
					cwd: repoRoot,
				});
				if (branchResult.code === 0) {
					await runGit(pi, repoRoot, ["worktree", "add", worktreePath, branch]);
				} else if (branchResult.code === 1) {
					await runGit(pi, repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
				} else {
					throw commandError(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], branchResult);
				}

				const sourceSessionFile = ctx.sessionManager.getSessionFile();
				let targetSession: SessionManager;
				if (sourceSessionFile && existsSync(sourceSessionFile)) {
					targetSession = SessionManager.forkFrom(sourceSessionFile, worktreePath);
				} else {
					targetSession = SessionManager.create(worktreePath, undefined, {
						parentSession: sourceSessionFile,
					});
				}

				const targetSessionFile = targetSession.getSessionFile();
				if (!targetSessionFile) {
					throw new Error("Failed to create a session for the worktree");
				}

				// SessionManager delays creating an empty session file until the first
				// assistant message. Persist its header now so switchSession can resolve
				// the worktree cwd even when /addworktree is the session's first command.
				if (!existsSync(targetSessionFile)) {
					const header = targetSession.getHeader();
					if (!header) {
						throw new Error("Failed to create a session header for the worktree");
					}
					await writeFile(targetSessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
				}
				prepared = { worktreePath, targetSessionFile };
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			const { worktreePath, targetSessionFile } = prepared;
			const switchResult = await ctx.switchSession(targetSessionFile, {
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify(`Now working in ${worktreePath} on ${branch}`, "info");
				},
			});

			if (switchResult.cancelled) {
				ctx.ui.notify(`Session switch cancelled. Worktree remains at ${worktreePath}.`, "warning");
			}
		},
	});
}
