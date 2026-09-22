import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, visibleWidth } from "@earendil-works/pi-tui";
import { EMPTY_TODO, MAX_FILE_BYTES, TODO_ENTRY_TYPE } from "../../extensions/todo/core.ts";
import todoExtension from "../../extensions/todo/index.ts";

async function setup(t) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-todo-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const commands = new Map(), events = new Map(), renderers = new Map();
	const entries = [], notifications = [];
	const ctx = { cwd, mode: "tui", ui: { notify: (text, level) => notifications.push({ text, level }) } };
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		// Any accidental assistant invocation/context injection is a test failure.
		sendMessage: () => assert.fail("must not send messages to the model"),
		sendUserMessage: () => assert.fail("must not start an assistant turn"),
	};
	const initialize = () => { todoExtension(pi); events.get("session_start")({}, ctx); };
	initialize();
	const command = (args = "") => commands.get("todo").handler(args, ctx);
	const complete = (prefix = "") => commands.get("todo").getArgumentCompletions(prefix);
	return { cwd, path: join(cwd, "TODO.md"), ctx, entries, notifications, events, commands, renderers, initialize, command, complete };
}

test("missing file is created on first listing with just an empty notice", async (t) => {
	const f = await setup(t);
	await f.command();
	assert.equal(await readFile(f.path, "utf8"), EMPTY_TODO);
	assert.deepEqual(f.entries, [{ customType: TODO_ENTRY_TYPE, data: { output: "TODO.md is empty.", error: undefined } }]);
	assert.equal(f.notifications.length, 0);
});

test("add, list, check, all, cleardone persist through reload and manual edits", async (t) => {
	const f = await setup(t);
	await f.command("Fix login redirect");
	await f.command("Add docs");
	assert.match(f.entries.at(-1).data.output, /Added add-docs/);
	await f.command("--check fix-login-redirect");
	assert.match(await readFile(f.path, "utf8"), /\[x\] Fix login redirect/);
	await f.command();
	assert.doesNotMatch(f.entries.at(-1).data.output, /fix-login-redirect/);
	await f.command("--all");
	assert.match(f.entries.at(-1).data.output, /\[x\] fix-login-redirect/);
	f.events.get("session_shutdown")();
	f.initialize();
	await f.command("--cleardone");
	assert.equal(f.entries.at(-1).data.output, "Removed 1 checked item.");
	assert.doesNotMatch(await readFile(f.path, "utf8"), /fix-login/);
	await writeFile(f.path, "- [ ] Manual task\n");
	await f.command();
	assert.match(f.entries.at(-1).data.output, /manual-task/);
	assert.equal(await readFile(f.path, "utf8"), "- [ ] Manual task <!-- todo:manual-task -->\n");
});

test("completion reads fresh contents, never creates or annotates TODO.md, and excludes checked items", async (t) => {
	const f = await setup(t);
	assert.equal(await f.complete("--check "), null);
	await assert.rejects(stat(f.path), { code: "ENOENT" });
	const source = "- [ ] Existing\n- [x] Done\n";
	await writeFile(f.path, source);
	assert.deepEqual((await f.complete("--check ex")).map((item) => item.value), ["--check existing"]);
	assert.equal(await readFile(f.path, "utf8"), source);
	await f.command("--check existing");
	assert.equal(await f.complete("--check "), null);
	await writeFile(f.path, "- [ ] New <!-- todo:new -->\n");
	assert.equal((await f.complete("--check "))[0].value, "--check new");
	await f.command("--check new");
	await f.command("--cleardone");
	assert.equal(await f.complete("--check "), null);
});

test("keyword slugs persist consistently through completion, commands, and reload", async (t) => {
	const f = await setup(t);
	const text = "Please update the installation documentation for Linux";
	const source = `- [ ] ${text}\n`;
	await writeFile(f.path, source);
	assert.equal((await f.complete("--check update-"))[0].value, "--check update-installation-documentation");
	assert.equal(await readFile(f.path, "utf8"), source);
	await f.command();
	assert.equal(await readFile(f.path, "utf8"), `- [ ] ${text} <!-- todo:update-installation-documentation -->\n`);
	await f.command("Update installation documentation for macOS");
	f.events.get("session_shutdown")();
	f.initialize();
	assert.deepEqual((await f.complete("--check update-")).map((item) => item.value), [
		"--check update-installation-documentation", "--check update-installation-documentation-2",
	]);
	await f.command("--check update-installation-documentation-2");
	assert.match(await readFile(f.path, "utf8"), /\[x\] Update installation documentation for macOS/);
	assert.equal(f.notifications.length, 0);
});

test("real Pi autocomplete inserts the whole --check argument and does not execute it", async (t) => {
	const f = await setup(t);
	await f.command("Fix login redirect");
	await f.command("Finish tests");
	const before = await readFile(f.path, "utf8");
	const provider = new CombinedAutocompleteProvider([{ name: "todo", ...f.commands.get("todo") }], f.cwd);
	for (const input of ["/todo --check ", "/todo --check fi", "/todo --check fix-log"]) {
		const suggestions = await provider.getSuggestions([input], 0, input.length, {});
		assert.ok(suggestions?.items.length);
		const item = suggestions.items[0];
		const result = provider.applyCompletion([input], 0, input.length, item, suggestions.prefix);
		assert.equal(result.lines[0], `/todo ${item.value}`);
		assert.equal(result.lines[0], "/todo --check fix-login-redirect");
	}
	const input = "/todo --chec";
	const flags = await provider.getSuggestions([input], 0, input.length, {});
	assert.equal(provider.applyCompletion([input], 0, input.length, flags.items[0], flags.prefix).lines[0], "/todo --check ");
	assert.equal(await readFile(f.path, "utf8"), before);
});

test("invalid commands have no filesystem side effects", async (t) => {
	const f = await setup(t);
	for (const args of ["--bad", "--check", "--cleardone x", "--all --unchecked"]) await f.command(args);
	await assert.rejects(stat(f.path), { code: "ENOENT" });
	assert.equal(f.entries.length, 0);
	assert.equal(f.notifications.length, 4);
	assert.ok(f.notifications.every((notice) => notice.level === "error"));
});

test("missing-file check and cleardone create an empty file and report accurately", async (t) => {
	const f = await setup(t);
	await f.command("--check missing");
	assert.equal(await readFile(f.path, "utf8"), EMPTY_TODO);
	assert.equal(f.entries.at(-1).data.error, true);
	assert.match(f.entries.at(-1).data.output, /TODO.md is empty.*No item found/);
	await rm(f.path);
	await f.command("--cleardone");
	assert.equal(await readFile(f.path, "utf8"), EMPTY_TODO);
	assert.equal(f.entries.at(-1).data.output, "No checked items to remove.");
});

test("unknown slugs and duplicate metadata do not change existing files", async (t) => {
	const f = await setup(t);
	await writeFile(f.path, "- [ ] Legacy\n");
	await f.command("--check missing");
	assert.equal(await readFile(f.path, "utf8"), "- [ ] Legacy\n");
	const source = "- [ ] One <!-- todo:same -->\n- [x] Two <!-- todo:same -->\n";
	await writeFile(f.path, source);
	for (const args of ["--check same", "--cleardone", "New"]) await f.command(args);
	assert.equal(await readFile(f.path, "utf8"), source);
	assert.match(f.notifications.at(-1).text, /Duplicate todo slug/);
	assert.equal(await f.complete("--check "), null);
});

test("parallel additions share Pi's mutation queue and receive distinct persistent slugs", async (t) => {
	const f = await setup(t);
	await Promise.all(Array.from({ length: 12 }, () => f.command("Same task")));
	const source = await readFile(f.path, "utf8");
	const slugs = Array.from(source.matchAll(/<!-- todo:(.*?) -->/g), (match) => match[1]);
	assert.equal(slugs.length, 12);
	assert.equal(new Set(slugs).size, 12);
	assert.equal(f.notifications.length, 0);
	// Also coordinate with other users of the exported queue, not just /todo calls.
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	let entered;
	const enteredPromise = new Promise((resolve) => { entered = resolve; });
	const otherWriter = withFileMutationQueue(f.path, async () => {
		entered();
		await gate;
		await writeFile(f.path, source + "- [ ] External <!-- todo:external -->\n");
	});
	await enteredPromise;
	const todo = f.command("Another");
	release();
	await Promise.all([otherWriter, todo]);
	assert.match(await readFile(f.path, "utf8"), /todo:external/);
	assert.match(await readFile(f.path, "utf8"), /todo:another/);
});

test("non-files, invalid UTF-8, and oversized files fail safely", async (t) => {
	const f = await setup(t);
	await mkdir(f.path);
	await f.command("New");
	assert.match(f.notifications.at(-1).text, /regular file/);
	await rm(f.path, { recursive: true });
	const invalid = Buffer.from([0xff, 0xfe, 0]);
	await writeFile(f.path, invalid);
	await f.command("New");
	assert.equal(f.notifications.at(-1).level, "error");
	assert.deepEqual(await readFile(f.path), invalid);
	await writeFile(f.path, "a".repeat(MAX_FILE_BYTES + 1));
	await f.command("--cleardone");
	assert.match(f.notifications.at(-1).text, /2 MiB/);
	assert.equal((await stat(f.path)).size, MAX_FILE_BYTES + 1);
});

test("symlinked files are updated without replacing the symlink", async (t) => {
	const f = await setup(t);
	const target = join(f.cwd, "tasks.md");
	await writeFile(target, "- [ ] Fix <!-- todo:fix -->\n");
	await symlink(target, f.path);
	await f.command("--check fix");
	assert.equal(await readFile(target, "utf8"), "- [x] Fix <!-- todo:fix -->\n");
	await f.command("--cleardone");
	assert.equal(await readFile(target, "utf8"), "");
});

test("session changes retarget completion and each cwd gets its own TODO.md", async (t) => {
	const f = await setup(t);
	await f.command("Original");
	f.events.get("session_shutdown")();
	assert.equal(await f.complete("--check "), null);
	const child = join(f.cwd, "child");
	await mkdir(child);
	f.ctx.cwd = child;
	f.initialize();
	assert.equal(await f.complete("--check "), null);
	await f.command("Child");
	assert.equal((await f.complete("--check "))[0].value, "--check child");
	assert.match(await readFile(f.path, "utf8"), /todo:original/);
	assert.doesNotMatch(await readFile(f.path, "utf8"), /todo:child/);
});

test("RPC uses notifications, unsupported modes do not mutate files", async (t) => {
	const f = await setup(t);
	f.ctx.mode = "rpc";
	await f.command("RPC task");
	assert.equal(f.entries.length, 0);
	assert.match(f.notifications.at(-1).text, /Added rpc-task/);
	assert.equal(await f.complete("--check "), null);
	for (const mode of ["json", "print"]) {
		f.ctx.mode = mode;
		await assert.rejects(f.command("Wrong"), /TUI or RPC/);
	}
	assert.doesNotMatch(await readFile(f.path, "utf8"), /Wrong/);
});

test("inline renderer is width safe and strips terminal controls", async (t) => {
	const f = await setup(t);
	const render = f.renderers.get(TODO_ENTRY_TYPE);
	const component = render({ data: { output: "TODO.md\n[ ] slug — 長い task\x1b[2J with a long description" } }, {}, { fg: (_color, value) => value });
	for (const width of [5, 20, 80]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(lines.every((line) => !line.includes("\x1b")));
	}
});
