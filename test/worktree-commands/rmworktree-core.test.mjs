import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertManagedWorktree,
	managedWorktrees,
	parseRemovalArgs,
	parseWorktrees,
	removalCompletions,
	resolveRemovalTarget,
} from "../../extensions/worktree-commands/rmworktree-core.ts";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pretti-pi-removal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = join(root, "repo");
	await mkdir(main);
	const worktrees = [];
	async function add(path, branch, overrides = {}) {
		await mkdir(path, { recursive: true });
		const entry = { path, branch: branch ? `refs/heads/${branch}` : undefined, head: "12345678", bare: false,
			detached: !branch, locked: false, prunable: false, ...overrides };
		worktrees.push(entry);
		return entry;
	}
	await add(main, "main");
	return { root, main, worktrees, add };
}

test("parses a single positional target, quoted paths and escapes; rejects flags and extra arguments", () => {
	assert.equal(parseRemovalArgs("  "), undefined);
	assert.equal(parseRemovalArgs(" feature/login "), "feature/login");
	assert.equal(parseRemovalArgs('"/repo/path with spaces"'), "/repo/path with spaces");
	assert.equal(parseRemovalArgs("'/repo/path with spaces'"), "/repo/path with spaces");
	assert.equal(parseRemovalArgs(String.raw`"/repo/a\"b\\c"`), '/repo/a"b\\c');
	assert.equal(parseRemovalArgs(String.raw`a\ b`), "a b");
	for (const input of ["one two", "--list", "--force foo", '"unfinished', "trailing\\", '""']) {
		assert.throws(() => parseRemovalArgs(input), /Usage: \/rmworktree/);
	}
});

test("retains unusable registrations and the true main checkout in parsing", () => {
	const entries = parseWorktrees("worktree /bare\0bare\0\0worktree /missing\0HEAD abc\0detached\0prunable reason\0locked reason\0\0");
	assert.equal(entries[0].bare, true);
	assert.equal(entries[1].path, "/missing");
	assert.equal(entries[1].prunable, true);
	assert.equal(entries[1].locked, true);
});

test("resolves exact branches, unique directory names, and absolute/relative paths", async (t) => {
	const { root, main, worktrees, add } = await fixture(t);
	const nested = await add(join(main, ".worktrees", "feature", "login"), "feature/login");
	const spaced = await add(join(main, ".worktrees", "review copy"));
	const outside = await add(join(root, "outside"), "outside");
	for (const target of ["feature/login", "login", nested.path, ".worktrees/feature/login", "./.worktrees/feature/login"]) {
		assert.equal(resolveRemovalTarget(target, main, worktrees), nested);
	}
	assert.equal(resolveRemovalTarget("../../review copy", nested.path, worktrees), spaced);
	assert.equal(resolveRemovalTarget(parseRemovalArgs(`"${spaced.path}"`), main, worktrees), spaced);
	assert.throws(() => resolveRemovalTarget("feat", main, worktrees), /Unknown worktree/);
	assert.throws(() => resolveRemovalTarget("main", main, worktrees), /main worktree cannot/);
	assert.throws(() => resolveRemovalTarget(outside.path, main, worktrees), /only removes/);
	assert.throws(() => resolveRemovalTarget("./.worktrees/../../outside", main, worktrees), /only removes/);
});

test("rejects ambiguous names, including collisions with excluded worktrees", async (t) => {
	const { root, main, worktrees, add } = await fixture(t);
	const first = await add(join(main, ".worktrees", "one", "topic"), "topic");
	await add(join(root, "topic"), "other");
	assert.throws(() => resolveRemovalTarget("topic", main, worktrees), /Ambiguous worktree/);
	assert.equal(resolveRemovalTarget(first.path, main, worktrees), first);
	const items = removalCompletions("top", main, worktrees);
	assert.equal(items.length, 1);
	assert.equal(items[0].value, first.path);
});

test("only offers eligible worktrees and every completion round-trips unambiguously", async (t) => {
	const { root, main, worktrees, add } = await fixture(t);
	const feature = await add(join(main, ".worktrees", "feature"), "feature/login", { locked: true });
	const spaced = await add(join(main, ".worktrees", 'review "copy"'));
	await add(join(root, "outside"), "outside");
	await add(join(main, ".worktrees-extra", "wrong"), "wrong");
	await add(join(main, ".worktrees", "prunable"), "prunable", { prunable: true });
	const missing = await add(join(main, ".worktrees", "missing"), "missing");
	await rm(missing.path, { recursive: true });
	assert.deepEqual(managedWorktrees(worktrees), [feature, spaced]);
	const items = removalCompletions("", main, worktrees);
	assert.deepEqual(items.map((item) => resolveRemovalTarget(parseRemovalArgs(item.value), main, worktrees)), [feature, spaced]);
	assert.match(items[0].description, /\[locked\]/);
	assert.equal(removalCompletions("feat", main, worktrees)[0].value, "feature/login");
	assert.equal(removalCompletions("./.worktrees/feat", main, worktrees)[0].value, "feature/login");
	assert.equal(removalCompletions('"review ', main, worktrees)[0].value, items[1].value);
	assert.equal(removalCompletions("--list", main, worktrees), null);
	assert.equal(removalCompletions("no-match", main, worktrees), null);
	assert.throws(() => assertManagedWorktree(main, { ...feature, path: join(main, ".worktrees") }), /only removes/);
});

test("rejects symlink escapes through children or the managed root", async (t) => {
	const { root, main, worktrees, add } = await fixture(t);
	const inside = await add(join(main, ".worktrees", "inside"), "inside");
	const outside = await add(join(root, "outside"), "outside");
	const link = join(main, ".worktrees", "escape");
	await symlink(outside.path, link);
	const escaped = { ...outside, path: link };
	assert.throws(() => assertManagedWorktree(main, escaped), /only removes/);
	assert.deepEqual(managedWorktrees([...worktrees, escaped]), [inside]);
	await rm(join(main, ".worktrees"), { recursive: true });
	await symlink(root, join(main, ".worktrees"));
	assert.throws(() => assertManagedWorktree(main, { ...outside, path: join(main, ".worktrees", "outside") }), /only removes/);
	assert.deepEqual(managedWorktrees(worktrees), []);
});
