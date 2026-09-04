import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export const MANAGED_WORKTREES_DIRECTORY = ".worktrees";
export const MANAGED_WORKTREES_EXCLUDE_PATTERN = `/${MANAGED_WORKTREES_DIRECTORY}/`;

type GitExecutor = (cwd: string, args: string[]) => Promise<ExecResult>;

function gitError(args: string[], result: ExecResult): Error {
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	return new Error(`git ${args.join(" ")} failed (exit ${result.code})${output ? `:\n${output}` : ""}`);
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isDirectory()) {
			throw new Error(`Managed worktree path exists but is not a directory: ${path}`);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

async function appendExcludePattern(excludePath: string): Promise<void> {
	await mkdir(dirname(excludePath), { recursive: true });
	let contents = "";
	try {
		contents = await readFile(excludePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	if (contents.split(/\r?\n/).includes(MANAGED_WORKTREES_EXCLUDE_PATTERN)) {
		return;
	}

	const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
	await appendFile(excludePath, `${separator}${MANAGED_WORKTREES_EXCLUDE_PATTERN}\n`, "utf8");
}

export function parseMainWorktreePath(output: string): string | undefined {
	const fields = (output.split("\0\0")[0] ?? "").split("\0");
	if (fields.includes("bare")) {
		return undefined;
	}
	return fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
}

export function parseWorktreePaths(output: string): string[] {
	return output
		.split("\0\0")
		.filter(Boolean)
		.map((record) =>
			record
				.split("\0")
				.find((field) => field.startsWith("worktree "))
				?.slice("worktree ".length),
		)
		.filter((path): path is string => Boolean(path));
}

function isNestedPath(parent: string, candidate: string): boolean {
	const relativePath = relative(resolve(parent), resolve(candidate));
	return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

export async function assertNestedWorktreesAreSafe(execGit: GitExecutor, repoRoot: string): Promise<void> {
	const listArgs = ["worktree", "list", "--porcelain", "-z"];
	const listResult = await execGit(repoRoot, listArgs);
	if (listResult.code !== 0) {
		throw gitError(listArgs, listResult);
	}
	const nestedWorktrees = parseWorktreePaths(listResult.stdout).filter(
		(path) => existsSync(path) && isNestedPath(repoRoot, path),
	);

	for (const worktreePath of nestedWorktrees) {
		const relativePath = relative(repoRoot, worktreePath);
		const trackedArgs = ["ls-files", "-z", "--", relativePath];
		const trackedResult = await execGit(repoRoot, trackedArgs);
		if (trackedResult.code !== 0) {
			throw gitError(trackedArgs, trackedResult);
		}
		if (trackedResult.stdout) {
			throw new Error(
				`Refusing to stage changes because linked worktree ${worktreePath} is already tracked by the outer repository`,
			);
		}

		const ignoredArgs = ["check-ignore", "--quiet", "--no-index", "--", relativePath];
		const ignoredResult = await execGit(repoRoot, ignoredArgs);
		if (ignoredResult.code === 1) {
			throw new Error(
				`Refusing to stage changes because linked worktree ${worktreePath} is inside the current checkout but is not ignored. Add an appropriate root-anchored rule to .git/info/exclude or move the worktree`,
			);
		}
		if (ignoredResult.code !== 0) {
			throw gitError(ignoredArgs, ignoredResult);
		}
	}
}

export async function prepareManagedWorktreesDirectory(
	execGit: GitExecutor,
	mainWorktreePath: string,
	commonGitDirectory: string,
	targetSegment: string,
): Promise<string> {
	const managedDirectory = join(mainWorktreePath, MANAGED_WORKTREES_DIRECTORY);
	const relativeTarget = `${MANAGED_WORKTREES_DIRECTORY}/${targetSegment}`;

	const trackedArgs = ["ls-files", "-z", "--", MANAGED_WORKTREES_DIRECTORY];
	const trackedResult = await execGit(mainWorktreePath, trackedArgs);
	if (trackedResult.code !== 0) {
		throw gitError(trackedArgs, trackedResult);
	}
	if (trackedResult.stdout) {
		throw new Error(
			`Cannot use ${managedDirectory} because ${MANAGED_WORKTREES_DIRECTORY} is already tracked by Git`,
		);
	}

	if (await pathExistsAsDirectory(managedDirectory)) {
		const existingIgnoreArgs = ["check-ignore", "--quiet", "--no-index", "--", MANAGED_WORKTREES_DIRECTORY];
		const existingIgnoreResult = await execGit(mainWorktreePath, existingIgnoreArgs);
		if (existingIgnoreResult.code === 1) {
			throw new Error(
				`Cannot use existing unignored directory ${managedDirectory}; move it or ignore it explicitly first`,
			);
		}
		if (existingIgnoreResult.code !== 0) {
			throw gitError(existingIgnoreArgs, existingIgnoreResult);
		}
	}

	await appendExcludePattern(join(commonGitDirectory, "info", "exclude"));

	const verifyArgs = ["check-ignore", "--quiet", "--no-index", "--", relativeTarget];
	const verifyResult = await execGit(mainWorktreePath, verifyArgs);
	if (verifyResult.code === 1) {
		throw new Error(
			`${relativeTarget} is not ignored by Git. Remove any conflicting .gitignore negation before creating an in-repository worktree`,
		);
	}
	if (verifyResult.code !== 0) {
		throw gitError(verifyArgs, verifyResult);
	}

	await mkdir(managedDirectory, { recursive: true });
	return managedDirectory;
}
