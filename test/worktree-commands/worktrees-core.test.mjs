import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	formatWorktreeList,
	parseWorktrees,
	parseWorktreesCommandArgs,
	WORKTREES_USAGE,
} from "../../extensions/worktree-commands/worktrees-core.ts";

function worktree(overrides = {}) {
	return {
		path: "/repo/.worktrees/feature",
		head: "1234567890abcdef",
		branch: "refs/heads/feature",
		bare: false,
		detached: false,
		locked: false,
		prunable: false,
		main: false,
		current: false,
		...overrides,
	};
}

test("parses picker and list command modes and rejects unsupported arguments", () => {
	assert.equal(parseWorktreesCommandArgs(""), "picker");
	assert.equal(parseWorktreesCommandArgs("   "), "picker");
	assert.equal(parseWorktreesCommandArgs(" --list "), "list");
	assert.throws(() => parseWorktreesCommandArgs("--unknown"), { message: WORKTREES_USAGE });
	assert.throws(() => parseWorktreesCommandArgs("--list extra"), { message: WORKTREES_USAGE });
});

test("formats branch, path, and worktree status details", () => {
	const output = formatWorktreeList([
		worktree({ path: "/repo", branch: "refs/heads/main", main: true, current: true }),
		worktree(),
		worktree({
			path: "/tmp/review",
			head: "abcdef1234567890",
			branch: undefined,
			detached: true,
			locked: true,
		}),
	]);

	assert.equal(
		output,
		[
			"Worktrees:",
			"- main [main, current] — /repo",
			"- feature — /repo/.worktrees/feature",
			"- (detached abcdef12) [detached, locked] — /tmp/review",
		].join("\n"),
	);
});

test("parses only usable worktrees that still exist", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pretti-pi-worktree-list-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const linked = join(root, "linked");
	await mkdir(linked);
	const missing = join(root, "missing");
	const output = [
		`worktree ${root}\0HEAD 11111111\0branch refs/heads/main\0\0`,
		`worktree ${linked}\0HEAD 22222222\0detached\0locked reason\0\0`,
		`worktree ${missing}\0HEAD 33333333\0branch refs/heads/missing\0\0`,
	].join("");

	const detached = worktree({
		path: linked,
		head: "22222222",
		detached: true,
		locked: true,
	});
	delete detached.branch;

	assert.deepEqual(parseWorktrees(output), [
		worktree({ path: root, head: "11111111", branch: "refs/heads/main", main: true }),
		detached,
	]);
});
