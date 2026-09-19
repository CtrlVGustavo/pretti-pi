import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

// Exercise the actual command against disposable Git repositories without
// requiring Pi's bundled runtime or an interactive terminal.
const agentStub = `
export class DynamicBorder {}
export class SessionManager {
	static create(cwd) {
		return { getSessionFile: () => cwd + '/.git/removal-test-session.jsonl', getHeader: () => ({ type: 'session', cwd }) };
	}
}
`;
const tuiStub = `
export const selections = [];
export class Container { addChild() {} render() { return []; } invalidate() {} }
export class Text {}
export class SelectList {
	constructor(items) { this.items = items; selections.push(items); }
	handleInput(key) { if (key === 'cancel') this.onCancel(); else this.onSelect(this.items[Number(key)]); }
}
`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		const source = specifier === "@earendil-works/pi-coding-agent" ? agentStub
			: specifier === "@earendil-works/pi-tui" ? tuiStub : undefined;
		return source === undefined ? nextResolve(specifier, context)
			: { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
	},
});
const { default: initialize } = await import("../../extensions/worktree-commands/rmworktree.ts");
const { selections } = await import("@earendil-works/pi-tui");
hooks.deregister();
const execFileAsync = promisify(execFile);

async function git(cwd, args) {
	try {
		return { ...await execFileAsync("git", args, { cwd, encoding: "utf8" }), code: 0, killed: false };
	} catch (error) {
		if (typeof error.code !== "number") throw error;
		return { stdout: error.stdout, stderr: error.stderr, code: error.code, killed: false };
	}
}
async function runGit(cwd, args) {
	const result = await git(cwd, args);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pretti-pi-rm-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const main = join(root, "repo");
	await mkdir(main);
	await runGit(main, ["init", "--quiet"]);
	await runGit(main, ["config", "user.name", "Test"]);
	await runGit(main, ["config", "user.email", "test@example.com"]);
	await runGit(main, ["commit", "--quiet", "--allow-empty", "-m", "initial"]);
	await writeFile(join(main, ".git", "info", "exclude"), "/.worktrees/\n");
	async function add(branch, path = join(main, ".worktrees", branch)) {
		await runGit(main, ["worktree", "add", "--quiet", "-b", branch, path]);
		return path;
	}
	return { root, main, add };
}
function harness(cwd, options = {}) {
	let command;
	const events = new Map();
	const notifications = [];
	const confirmations = [];
	const switches = [];
	initialize({
		on: (name, callback) => events.set(name, callback),
		registerCommand(name, definition) { assert.equal(name, "rmworktree"); command = definition; },
		exec: (_command, args, { cwd }) => git(cwd, args),
	});
	const ctx = {
		cwd, mode: options.mode ?? "tui", hasUI: options.hasUI ?? true,
		waitForIdle: async () => {},
		sessionManager: { getSessionFile: () => undefined },
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			confirm: async (_title, warning) => {
				confirmations.push(warning);
				await options.beforeConfirm?.();
				return options.confirm ?? true;
			},
			custom: async (factory) => new Promise((done) => {
				const theme = { fg: (_color, text) => text, bold: (text) => text };
				const component = factory({ requestRender() {} }, theme, {}, done);
				component.handleInput(options.pick ?? "0");
			}),
		},
		switchSession: async (path, { withSession }) => {
			switches.push(path);
			await options.beforeSwitch?.();
			if (options.cancelSwitch) return { cancelled: true };
			await withSession({ ui: ctx.ui });
			return { cancelled: false };
		},
	};
	events.get("session_start")({}, ctx);
	return { command, events, ctx, notifications, confirmations, switches,
		run: (args = "") => command.handler(args, ctx) };
}

test("explicitly removes another worktree without switching and retains its branch", async (t) => {
	const { main, add } = await fixture(t);
	const current = await add("current");
	const target = await add("feature/login");
	await writeFile(join(target, "untracked.txt"), "local changes");
	const h = harness(current);
	await h.run("feature/login");
	assert.equal(existsSync(target), false);
	assert.equal(existsSync(current), true);
	assert.equal(h.switches.length, 0);
	assert.equal(h.confirmations.length, 1);
	assert.match(h.confirmations[0], /uncommitted, untracked, and ignored/);
	assert.match(h.confirmations[0], /local changes/);
	await runGit(main, ["show-ref", "--verify", "refs/heads/feature/login"]);
});

test("explicit and default current-worktree removal switch to main before deletion", async (t) => {
	const { main, add } = await fixture(t);
	for (const explicit of [false, true]) {
		const name = explicit ? "explicit" : "default";
		const target = await add(name);
		const h = harness(target, { beforeSwitch: () => assert.equal(existsSync(target), true) });
		await h.run(explicit ? name : "");
		assert.equal(h.switches.length, 1);
		assert.ok(h.switches[0].startsWith(join(main, ".git")));
		assert.equal(existsSync(target), false);
		assert.match(h.notifications.at(-1).text, /Moved to/);
	}
});

test("confirmation and session-switch cancellation never remove the worktree", async (t) => {
	const { add } = await fixture(t);
	const target = await add("keep");
	for (const options of [{ confirm: false }, { cancelSwitch: true }, { hasUI: false, mode: "print" }]) {
		const h = harness(target, options);
		await h.run("keep");
		assert.equal(existsSync(target), true);
	}
});

test("outside worktrees cannot be removed explicitly or by default; main and unknown names fail closed", async (t) => {
	const { root, main, add } = await fixture(t);
	const outside = await add("outside", join(root, "outside"));
	const inside = await add("inside");
	for (const [cwd, target] of [[main, outside], [inside, "outside"], [outside, ""], [inside, main], [inside, "ins"], [inside, "--list"]]) {
		const h = harness(cwd);
		await h.run(target);
		assert.equal(h.notifications.at(-1).level, "error");
		assert.equal(h.confirmations.length, 0);
		assert.equal(h.switches.length, 0);
		assert.equal(existsSync(outside), true);
		assert.equal(existsSync(inside), true);
	}
});

test("main picker excludes outside worktrees and can be cancelled", async (t) => {
	const { root, main, add } = await fixture(t);
	const outside = await add("outside", join(root, "outside"));
	const inside = await add("inside");
	const cancel = harness(main, { pick: "cancel" });
	await cancel.run();
	assert.deepEqual(selections.at(-1).map((item) => item.value), [inside]);
	assert.equal(cancel.confirmations.length, 0);
	const h = harness(main);
	await h.run();
	assert.equal(existsSync(inside), false);
	assert.equal(existsSync(outside), true);
	assert.equal(h.switches.length, 0);
});

test("autocomplete reads fresh Git registrations and follows session cwd", async (t) => {
	const { root, main, add } = await fixture(t);
	const h = harness(main);
	assert.equal(h.command.getArgumentCompletions(""), null);
	const target = await add("feature/login");
	await add("outside", join(root, "outside"));
	assert.equal(h.command.getArgumentCompletions("feat")[0].value, "feature/login");
	assert.equal(h.command.getArgumentCompletions("").length, 1);
	await runGit(main, ["worktree", "remove", target]);
	assert.equal(h.command.getArgumentCompletions(""), null);
	h.events.get("session_start")({}, { cwd: root });
	assert.equal(h.command.getArgumentCompletions(""), null);
	h.events.get("session_shutdown")();
	assert.equal(h.command.getArgumentCompletions(""), null);
});

test("locked and detached managed worktrees remain removable after confirmation", async (t) => {
	const { main, add } = await fixture(t);
	const locked = await add("locked");
	await runGit(main, ["worktree", "lock", locked]);
	const h = harness(main);
	await h.run("locked");
	assert.equal(existsSync(locked), false);
	await runGit(main, ["show-ref", "--verify", "refs/heads/locked"]);

	const detached = join(main, ".worktrees", "detached");
	await runGit(main, ["worktree", "add", "--quiet", "--detach", detached]);
	await h.run("detached");
	assert.equal(existsSync(detached), false);
	assert.match(h.confirmations.at(-1), /detached HEAD/);
});

test("quoted paths work from main, and explicit targets work with RPC confirmation", async (t) => {
	const { main, add } = await fixture(t);
	const target = await add("topic", join(main, ".worktrees", "with spaces"));
	const h = harness(main, { mode: "rpc" });
	await h.run(`"${target}"`);
	assert.equal(existsSync(target), false);
	assert.equal(h.switches.length, 0);
});

test("revalidates stale registrations after confirmation", async (t) => {
	const { main, add } = await fixture(t);
	const target = await add("stale");
	const moved = join(main, ".worktrees", "moved");
	const h = harness(main, { beforeConfirm: () => runGit(main, ["worktree", "move", target, moved]) });
	await h.run("stale");
	assert.equal(existsSync(moved), true);
	assert.equal(h.notifications.at(-1).level, "error");
	assert.match(h.notifications.at(-1).text, /no longer a linked worktree/);
});

test("rechecks canonical containment immediately before removal", async (t) => {
	const { root, main, add } = await fixture(t);
	const target = await add("escape");
	const moved = join(root, "moved");
	const h = harness(main, { beforeConfirm: async () => {
		await rename(target, moved);
		await symlink(moved, target);
	} });
	await h.run("escape");
	assert.equal(existsSync(moved), true);
	assert.equal(existsSync(target), true);
	assert.equal(h.notifications.at(-1).level, "error");
	assert.match(h.notifications.at(-1).text, /only removes/);
});
