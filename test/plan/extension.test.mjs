import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { PLAN_HELP, PLAN_INSTRUCTIONS } from "../../extensions/plan/core.ts";
import planExtension from "../../extensions/plan/index.ts";
import { MAX_FILE_BYTES } from "../../extensions/todo/core.ts";

async function setup(t) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-plan-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const commands = new Map(), events = new Map();
	const messages = [], notifications = [];
	const ctx = {
		cwd, mode: "tui", idle: true,
		isIdle: () => ctx.idle,
		ui: { notify: (text, level) => notifications.push({ text, level }) },
	};
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: (content, options) => { messages.push({ content, options }); ctx.idle = false; },
		sendMessage: () => assert.fail("must send the plan as one user message"),
	};
	const initialize = () => { planExtension(pi); events.get("session_start")({}, ctx); };
	initialize();
	const command = (args = "") => commands.get("plan").handler(args, ctx);
	const complete = (prefix = "") => commands.get("plan").getArgumentCompletions(prefix);
	return { cwd, path: join(cwd, "TODO.md"), ctx, pi, commands, events, messages, notifications, initialize, command, complete };
}

test("plain requests send one literal user message immediately, with no TODO file access", async (t) => {
	const f = await setup(t);
	// A non-file at this path would fail any attempted TODO read.
	await mkdir(f.path);
	await f.command('Review "the design"\nPreserve  spaces');
	assert.deepEqual(f.messages, [{
		content: `${PLAN_INSTRUCTIONS}\n\nReview "the design"\nPreserve  spaces`,
		options: { deliverAs: "followUp" },
	}]);
	assert.equal(f.notifications.length, 0);
	assert.ok((await stat(f.path)).isDirectory());
});

test("help explains flags locally without reading TODO.md or starting a turn", async (t) => {
	const f = await setup(t);
	await mkdir(f.path);
	await f.command("--help");
	assert.deepEqual(f.notifications, [{ text: PLAN_HELP, level: "info" }]);
	assert.equal(f.messages.length, 0);
	assert.equal(f.ctx.idle, true);
	await f.command("-- --help");
	assert.equal(f.messages[0].content, `${PLAN_INSTRUCTIONS}\n\n--help`);
});

test("empty commands and invalid arguments error without creating files or invoking the agent", async (t) => {
	const f = await setup(t);
	for (const args of ["", "  ", "--todo", "--todo ", "--", "--todo --", "--todo BAD", "--all", "--bad", "--help extra"]) {
		await f.command(args);
		assert.equal(f.notifications.at(-1).level, "error");
		assert.match(f.notifications.at(-1).text, /\/plan --help/);
	}
	assert.equal(f.messages.length, 0);
	await assert.rejects(stat(f.path), { code: "ENOENT" });
});

test("todo requests and --all never annotate, check, or otherwise change the file", async (t) => {
	const f = await setup(t);
	const source = "\ufeff# TODO\r\n- [ ] Fix login redirect\r\n  Notes not included.\r\n- [x] Done <!-- todo:done -->\r\n- [ ] Update docs <!-- todo:update-docs -->\r\n";
	await writeFile(f.path, source);
	for (const args of ["--todo fix-login-redirect", "--todo fix-login-redirect Focus on tests", "--todo --all", "--todo --all Group tasks", "--todo done"]) {
		f.ctx.idle = true;
		await f.command(args);
		assert.equal(await readFile(f.path, "utf8"), source);
	}
	assert.equal(f.messages.length, 5);
	assert.equal(f.messages[0].content, `${PLAN_INSTRUCTIONS}\n\nTodo: fix-login-redirect\nFix login redirect`);
	assert.equal(f.messages[1].content, `${f.messages[0].content}\n\nAdditional instructions:\nFocus on tests`);
	assert.equal(f.messages[2].content, `${f.messages[0].content}\n\nTodo: update-docs\nUpdate docs`);
	assert.equal(f.messages[3].content, `${f.messages[2].content}\n\nAdditional instructions:\nGroup tasks`);
	assert.equal(f.messages[4].content, `${PLAN_INSTRUCTIONS}\n\nTodo: done\nDone`);
	assert.equal(f.notifications.length, 0);
});

test("busy agents receive a follow-up without waiting or interrupting", async (t) => {
	const f = await setup(t);
	await writeFile(f.path, "- [ ] Task\n");
	for (const args of ["Plan a feature", "--todo task", "--todo --all"]) {
		f.ctx.idle = false;
		await f.command(args);
		assert.deepEqual(f.messages.at(-1).options, { deliverAs: "followUp" });
		assert.deepEqual(f.notifications.at(-1), { text: "Plan queued as a follow-up.", level: "info" });
	}
	assert.equal(f.messages.length, 3);
});

test("missing files, unknown slugs, and no unchecked items produce errors without messages", async (t) => {
	const f = await setup(t);
	for (const args of ["--todo missing", "--todo --all"]) {
		await f.command(args);
		assert.match(f.notifications.at(-1).text, /TODO.md was not found/);
	}
	await assert.rejects(stat(f.path), { code: "ENOENT" });
	for (const source of ["", "# TODO\n", "- [x] Done\n"]) {
		await writeFile(f.path, source);
		await f.command("--todo --all");
		assert.match(f.notifications.at(-1).text, /No unchecked todo items/);
		await f.command("--todo missing");
		assert.match(f.notifications.at(-1).text, /No item found for slug/);
		assert.equal(await readFile(f.path, "utf8"), source);
	}
	assert.equal(f.messages.length, 0);
	assert.ok(f.notifications.every((notice) => notice.level === "error"));
});

test("completion reads fresh contents, excludes checked tasks, and never writes or sends", async (t) => {
	const f = await setup(t);
	assert.deepEqual((await f.complete("--todo ")).map((item) => item.value), ["--todo --all"]);
	await assert.rejects(stat(f.path), { code: "ENOENT" });
	const source = "- [ ] Fix login redirect\n- [x] Done\n- [X] Also done\n";
	await writeFile(f.path, source);
	assert.deepEqual((await f.complete("--todo ")).map((item) => item.value), ["--todo fix-login-redirect", "--todo --all"]);
	assert.equal(await f.complete("--todo done"), null);
	assert.equal(await f.complete("--todo also"), null);
	assert.equal(await f.complete("--todo fix-login-redirect extra"), null);
	assert.equal(await readFile(f.path, "utf8"), source);
	await writeFile(f.path, "- [x] Fix login redirect\n- [ ] New task\n");
	assert.equal(await f.complete("--todo fix"), null);
	assert.equal((await f.complete("--todo new"))[0].value, "--todo new-task");
	assert.equal(f.messages.length, 0);
	assert.equal(f.notifications.length, 0);
});

test("real Pi completion inserts complete arguments without executing the command", async (t) => {
	const f = await setup(t);
	const source = "- [ ] Fix login redirect\n- [x] Finish tests\n";
	await writeFile(f.path, source);
	const provider = new CombinedAutocompleteProvider([{ name: "plan", ...f.commands.get("plan") }], f.cwd);
	for (const [input, expected] of [
		["/plan --t", "/plan --todo "],
		["/plan --h", "/plan --help"],
		["/plan --todo ", "/plan --todo fix-login-redirect"],
		["/plan --todo fi", "/plan --todo fix-login-redirect"],
		["/plan --todo fix-log", "/plan --todo fix-login-redirect"],
		["/plan --todo --a", "/plan --todo --all"],
	]) {
		const suggestions = await provider.getSuggestions([input], 0, input.length, {});
		assert.ok(suggestions?.items.length, input);
		assert.equal(provider.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix).lines[0], expected);
		assert.ok(suggestions.items.every((item) => !item.value.includes("finish-tests")));
	}
	// Completing a selector before existing extra text must preserve that text.
	const input = "/plan --todo fi Focus on tests";
	const cursor = "/plan --todo fi".length;
	const suggestions = await provider.getSuggestions([input], 0, cursor, {});
	assert.equal(provider.applyCompletion([input], 0, cursor, suggestions.items[0], suggestions.prefix).lines[0], "/plan --todo fix-login-redirect Focus on tests");
	assert.equal(await readFile(f.path, "utf8"), source);
	assert.equal(f.messages.length, 0);
	assert.equal(f.notifications.length, 0);
});

test("duplicate or malformed metadata is silent during completion and errors on execution", async (t) => {
	const f = await setup(t);
	for (const source of ["- [ ] A <!-- todo:same -->\n- [x] B <!-- todo:same -->\n", "- [ ] A <!-- todo:BAD -->\n"]) {
		await writeFile(f.path, source);
		const before = f.notifications.length;
		assert.equal(await f.complete("--todo "), null);
		assert.equal(f.notifications.length, before);
		for (const args of ["--todo same", "--todo --all"]) {
			await f.command(args);
			assert.match(f.notifications.at(-1).text, /Duplicate todo slug|Invalid todo slug metadata/);
		}
		assert.equal(await readFile(f.path, "utf8"), source);
	}
	assert.equal(f.messages.length, 0);
});

test("non-files, invalid UTF-8, and oversized files fail without messages or changes", async (t) => {
	const f = await setup(t);
	await mkdir(f.path);
	assert.equal(await f.complete("--todo "), null);
	// Flag completion still works even if TODO.md cannot be read.
	assert.equal((await f.complete("--todo --a"))[0].value, "--todo --all");
	assert.equal((await f.complete("--h"))[0].value, "--help");
	await f.command("--todo --all");
	assert.match(f.notifications.at(-1).text, /regular file/);
	await rm(f.path, { recursive: true });
	for (const source of [Buffer.from([0xff, 0xfe, 0]), Buffer.alloc(MAX_FILE_BYTES + 1, 97)]) {
		await writeFile(f.path, source);
		assert.equal(await f.complete("--todo "), null);
		await f.command("--todo --all");
		assert.equal(f.notifications.at(-1).level, "error");
		assert.deepEqual(await readFile(f.path), source);
	}
	assert.match(f.notifications.at(-1).text, /2 MiB/);
	assert.equal(f.messages.length, 0);
});

test("execution uses current file contents rather than the previous completion snapshot", async (t) => {
	const f = await setup(t);
	await writeFile(f.path, "- [ ] Before <!-- todo:task -->\n");
	assert.match((await f.complete("--todo task"))[0].description, /Before/);
	await writeFile(f.path, "- [ ] After <!-- todo:task -->\n");
	await f.command("--todo task");
	assert.match(f.messages[0].content, /Todo: task\nAfter$/);
	await writeFile(f.path, "");
	await f.command("--todo task");
	assert.equal(f.messages.length, 1);
	assert.match(f.notifications.at(-1).text, /No item found/);
});

test("symlinked TODO files are readable without modification", async (t) => {
	const f = await setup(t);
	const target = join(f.cwd, "tasks.md");
	const source = "- [ ] Symlink task\n";
	await writeFile(target, source);
	await symlink(target, f.path);
	await f.command("--todo symlink-task");
	assert.equal(f.messages.length, 1);
	assert.equal(await readFile(target, "utf8"), source);
});

test("session switches discard in-flight reads and retarget completion without parent search", async (t) => {
	const f = await setup(t);
	await writeFile(f.path, "- [ ] Original\n");
	const completion = f.complete("--todo ");
	const command = f.command("--todo original");
	// Both operations are now awaiting disk I/O. Shutdown invalidates their generation.
	f.events.get("session_shutdown")();
	assert.equal(await f.complete("--todo "), null);
	const child = join(f.cwd, "child");
	await mkdir(child);
	f.ctx.cwd = child;
	f.initialize();
	assert.equal(await completion, null);
	await command;
	assert.equal(f.messages.length, 0);
	assert.equal(f.notifications.length, 0);
	assert.deepEqual((await f.complete("--todo ")).map((item) => item.value), ["--todo --all"]);
	await f.command("--todo original");
	assert.match(f.notifications.at(-1).text, /TODO.md was not found/);
	await writeFile(join(child, "TODO.md"), "- [ ] Child task\n");
	assert.equal((await f.complete("--todo child"))[0].value, "--todo child-task");
	await f.command("--todo child-task");
	assert.match(f.messages[0].content, /Child task$/);
	assert.equal(await readFile(f.path, "utf8"), "- [ ] Original\n");
});

test("RPC supports planning, help, and errors; completion is TUI-only", async (t) => {
	const f = await setup(t);
	f.ctx.mode = "rpc";
	await f.command("--help");
	assert.equal(f.notifications.at(-1).text, PLAN_HELP);
	await f.command();
	assert.equal(f.notifications.at(-1).level, "error");
	await writeFile(f.path, "- [ ] RPC task\n");
	await f.command("--todo --all");
	assert.match(f.messages[0].content, /RPC task$/);
	assert.equal(await f.complete("--todo "), null);
	for (const mode of ["print", "json"]) {
		f.ctx.mode = mode;
		await assert.rejects(f.command("A request"), /TUI or RPC/);
	}
	assert.equal(f.messages.length, 1);
});

test("send failures are reported without leaking terminal controls", async (t) => {
	const f = await setup(t);
	f.pi.sendUserMessage = () => { throw new Error("Delivery failed\x1b[2J"); };
	await f.command("A request");
	assert.deepEqual(f.notifications, [{ text: "Delivery failed[2J", level: "error" }]);
});
