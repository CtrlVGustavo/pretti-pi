import assert from "node:assert/strict";
import { test } from "node:test";
import { neovimArgs, openInNeovim, runNeovim } from "../../extensions/code-cards/neovim.ts";

const target = { path: '/tmp/-file " $(touch marker).ts', cwd: "/tmp", line: 42, column: 3 };

test("Neovim receives literal argv, not a shell command", () => {
	assert.deepEqual(neovimArgs(target), ["+call cursor(42,3)", "+normal! zz", "--", target.path]);
	assert.throws(() => neovimArgs({ ...target, line: "1)|quit" }));
	const calls = [];
	const tui = { stop: () => calls.push("stop"), start: () => calls.push("start"), requestRender: (force) => calls.push(["render", force]) };
	const exit = runNeovim(tui, target, {
		write: (text) => calls.push(["write", text]),
		spawn: (command, args, options) => {
			assert.equal(command, "nvim");
			assert.deepEqual(args, neovimArgs(target));
			assert.equal(options.stdio, "inherit");
			assert.equal(options.shell, false);
			assert.equal(options.cwd, target.cwd);
			calls.push("spawn");
			return { status: 0, signal: null };
		},
	});
	assert.equal(exit.status, 0);
	assert.equal(calls[0], "stop");
	assert.ok(calls.indexOf("spawn") < calls.indexOf("start"));
	assert.deepEqual(calls.at(-1), ["render", true]);
});

test("terminal is restored for missing nvim, thrown spawn errors, nonzero exits, and signals", () => {
	const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
	for (const result of [{ status: null, signal: null, error: missing }, new Error("spawn threw"), { status: 1, signal: null }, { status: null, signal: "SIGTERM" }]) {
		let starts = 0;
		let renders = 0;
		const exit = runNeovim({ stop() {}, start() { starts++; }, requestRender() { renders++; } }, target, {
			write() {}, spawn() { if (result instanceof Error) throw result; return result; },
		});
		assert.equal(starts, 1);
		assert.equal(renders, 1);
		if (result.error === missing) assert.match(exit.error, /not found/);
		if (result instanceof Error) assert.match(exit.error, /spawn threw/);
	}
});

test("non-TUI launch is rejected before terminal access", async () => {
	await assert.rejects(openInNeovim({ mode: "rpc", ui: { custom() { assert.fail("must not access TUI"); } } }, target), /interactive TUI/);
});
