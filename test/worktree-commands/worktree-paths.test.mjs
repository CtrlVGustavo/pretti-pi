import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	MANAGED_WORKTREES_EXCLUDE_PATTERN,
	assertNestedWorktreesAreSafe,
	parseMainWorktreePath,
	parseWorktreePaths,
	prepareManagedWorktreesDirectory,
} from "../../extensions/worktree-commands/worktree-paths.ts";

const execFileAsync = promisify(execFile);

async function execGit(cwd, args) {
	try {
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return { ...result, code: 0, killed: false };
	} catch (error) {
		if (typeof error.code !== "number") throw error;
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			code: error.code,
			killed: error.killed ?? false,
		};
	}
}

async function runGit(cwd, args) {
	const result = await execGit(cwd, args);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
	}
	return result;
}

async function createRepository(t) {
	const repository = await mkdtemp(join(tmpdir(), "pretti-pi-worktrees-"));
	t.after(() => rm(repository, { recursive: true, force: true }));
	await runGit(repository, ["init", "--quiet"]);
	await runGit(repository, ["config", "user.name", "Worktree Test"]);
	await runGit(repository, ["config", "user.email", "worktree@example.com"]);
	await writeFile(join(repository, "README.md"), "test\n");
	await runGit(repository, ["add", "README.md"]);
	await runGit(repository, ["commit", "--quiet", "-m", "initial"]);
	const commonDirectory = (await runGit(repository, ["rev-parse", "--git-common-dir"])).stdout.trim();
	return { repository, commonDirectory: join(repository, commonDirectory) };
}

test("parses paths from null-delimited worktree output", () => {
	const output = "worktree /repo\0HEAD abc\0\0worktree /repo/.worktrees/topic\0HEAD def\0\0";
	assert.equal(parseMainWorktreePath(output), "/repo");
	assert.deepEqual(parseWorktreePaths(output), ["/repo", "/repo/.worktrees/topic"]);
	assert.equal(parseMainWorktreePath("worktree /repo.git\0bare\0\0worktree /linked\0HEAD abc\0\0"), undefined);
});

test("prepares an ignored in-repository worktree directory idempotently", async (t) => {
	const { repository, commonDirectory } = await createRepository(t);
	const managedDirectory = await prepareManagedWorktreesDirectory(
		execGit,
		repository,
		commonDirectory,
		"feature-one",
	);
	await prepareManagedWorktreesDirectory(execGit, repository, commonDirectory, "feature-one");

	assert.equal(managedDirectory, join(repository, ".worktrees"));
	const exclude = await readFile(join(commonDirectory, "info", "exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((line) => line === MANAGED_WORKTREES_EXCLUDE_PATTERN).length, 1);

	const linkedPath = join(managedDirectory, "feature-one");
	await runGit(repository, ["worktree", "add", "--quiet", "-b", "feature-one", linkedPath, "HEAD"]);

	const linkedWorktreeList = (await runGit(linkedPath, ["worktree", "list", "--porcelain", "-z"])).stdout;
	const mainWorktreePath = parseMainWorktreePath(linkedWorktreeList);
	assert.equal(mainWorktreePath, repository);
	const linkedCommonDirectory = resolve(
		linkedPath,
		(await runGit(linkedPath, ["rev-parse", "--git-common-dir"])).stdout.trim(),
	);
	const sharedManagedDirectory = await prepareManagedWorktreesDirectory(
		execGit,
		mainWorktreePath,
		linkedCommonDirectory,
		"feature-two",
	);
	const secondLinkedPath = join(sharedManagedDirectory, "feature-two");
	await runGit(linkedPath, ["worktree", "add", "--quiet", "-b", "feature-two", secondLinkedPath, "HEAD"]);

	assert.equal(secondLinkedPath, join(repository, ".worktrees", "feature-two"));
	assert.equal((await runGit(repository, ["status", "--porcelain"])).stdout, "");
	await assertNestedWorktreesAreSafe(execGit, repository);
	await runGit(repository, ["add", "--all"]);
	assert.equal((await runGit(repository, ["ls-files", "--", ".worktrees"])).stdout, "");
});

test("rejects unignored and accidentally tracked nested worktrees before staging", async (t) => {
	const { repository } = await createRepository(t);
	const nestedPath = join(repository, "nested", "feature");
	await mkdir(join(repository, "nested"));
	await runGit(repository, ["worktree", "add", "--quiet", "-b", "nested-feature", nestedPath, "HEAD"]);

	await assert.rejects(assertNestedWorktreesAreSafe(execGit, repository), /is not ignored/);
	await runGit(repository, ["add", "nested/feature"]);
	await assert.rejects(assertNestedWorktreesAreSafe(execGit, repository), /already tracked by the outer repository/);
});

test("refuses to hide an existing unignored directory", async (t) => {
	const { repository, commonDirectory } = await createRepository(t);
	await mkdir(join(repository, ".worktrees"));

	await assert.rejects(
		prepareManagedWorktreesDirectory(execGit, repository, commonDirectory, "feature"),
		/existing unignored directory/,
	);
});

test("refuses a tracked .worktrees path", async (t) => {
	const { repository, commonDirectory } = await createRepository(t);
	await mkdir(join(repository, ".worktrees"));
	await writeFile(join(repository, ".worktrees", "tracked.txt"), "tracked\n");
	await runGit(repository, ["add", ".worktrees/tracked.txt"]);

	await assert.rejects(
		prepareManagedWorktreesDirectory(execGit, repository, commonDirectory, "feature"),
		/already tracked by Git/,
	);
});

test("refuses a higher-precedence ignore negation", async (t) => {
	const { repository, commonDirectory } = await createRepository(t);
	await writeFile(join(repository, ".gitignore"), "!/.worktrees/\n!/.worktrees/**\n");

	await assert.rejects(
		prepareManagedWorktreesDirectory(execGit, repository, commonDirectory, "feature"),
		/is not ignored by Git/,
	);
});
