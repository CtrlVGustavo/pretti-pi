import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { CARD_TYPE } from "../../extensions/code-cards/core.ts";
import { createCodeCardsExtension } from "../../extensions/code-cards/index.ts";

async function setup(t, open) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-card-extension-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "source file.ts");
	await writeFile(path, "first\nconst timeout = 1000;\nlast\n");
	const tools = new Map(), commands = new Map(), events = new Map();
	const entries = [], messages = [], notifications = [], launches = [], confirmations = [];
	const ctx = {
		cwd, mode: "tui", isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			select: async (_title, items) => items[0],
			confirm: async (...args) => { confirmations.push(args); return true; },
		},
	};
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, handler) => events.set(name, handler),
		registerEntryRenderer() {}, registerMessageRenderer() {},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message, options) => messages.push({ ...message, options }),
	};
	const initialize = (start = true) => {
		createCodeCardsExtension({ openEditor: async (context, target) => {
			launches.push(target);
			return await open?.(context, target) ?? { status: 0, signal: null };
		} })(pi);
		if (start) events.get("session_start")({ reason: "startup" }, ctx);
	};
	initialize();
	const show = (params = {}) => tools.get("show_code_card").execute("tool-id", { path, line: 2, ...params }, undefined, undefined, ctx);
	const command = (args) => commands.get("code").handler(args, ctx);
	const complete = (prefix = "") => commands.get("code").getArgumentCompletions(prefix);
	return { cwd, path, ctx, entries, messages, notifications, launches, confirmations, tools, commands, events, initialize, show, command, complete };
}

test("tool persists a card without opening nvim; command edits and reports without triggering a turn", async (t) => {
	const f = await setup(t, async (_ctx, target) => { await writeFile(target.path, "first\nconst timeout = 5000;\nlast\n"); });
	const result = await f.show();
	assert.equal(f.launches.length, 0);
	assert.equal(f.entries[0].customType, CARD_TYPE);
	assert.match(result.content[0].text, /No file changes/);
	assert.equal(result.details.slug, "source-file-2");
	assert.ok(result.content[0].text.includes(`/code ${result.details.cardId}`));
	assert.ok(!result.content[0].text.includes(`#${result.details.cardId}`));
	await f.command(result.details.cardId);
	assert.equal(f.launches[0].line, 2);
	assert.equal(f.launches[0].path, f.path);
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].options.triggerTurn, false);
	assert.match(f.messages[0].content, /-const timeout = 1000;/);
	assert.match(f.messages[0].content, /\+const timeout = 5000;/);
	assert.match(await readFile(f.path, "utf8"), /5000/);
});

test("direct file invocation, picker, and --last open current files; unchanged exit sends no model message", async (t) => {
	const f = await setup(t);
	await f.command('"source file.ts":2:4');
	assert.equal(f.entries.length, 1);
	assert.equal(f.launches[0].column, 4);
	await f.command("");
	await f.command("--last");
	assert.equal(f.launches.length, 3);
	assert.equal(f.messages.length, 0);
	assert.match(f.notifications.at(-1).text, /unchanged/);
});

test("cards survive extension reload, but only active-branch cards are selectable", async (t) => {
	const f = await setup(t);
	const result = await f.show();
	f.events.get("session_shutdown")();
	f.initialize();
	await f.command(`#${result.details.cardId}`);
	assert.equal(f.launches.length, 1);
	f.entries.length = 0;
	await f.command(`#${result.details.cardId}`);
	assert.equal(f.launches.length, 1);
	assert.match(f.notifications.at(-1).text, /current conversation branch/);
});

test("changed file anchors relocate, missing anchors require confirmation, cancellation writes nothing", async (t) => {
	const f = await setup(t);
	await f.show();
	await writeFile(f.path, "new\nfirst\nconst timeout = 1000;\nlast\n");
	await f.command("--last");
	assert.equal(f.launches[0].line, 3);
	assert.equal(f.confirmations.length, 0);
	await writeFile(f.path, "different\n");
	f.ctx.ui.confirm = async () => false;
	await f.command("--last");
	assert.equal(f.launches.length, 1);
	assert.equal(await readFile(f.path, "utf8"), "different\n");
});

test("busy, non-TUI, invalid paths, and empty picker never launch", async (t) => {
	const f = await setup(t);
	await f.command("");
	assert.match(f.notifications.at(-1).text, /No code cards/);
	await f.command("missing.ts");
	assert.equal(f.notifications.at(-1).level, "error");
	f.ctx.isIdle = () => false;
	await f.command("source file.ts");
	assert.match(f.notifications.at(-1).text, /Wait for Pi/);
	f.ctx.mode = "rpc";
	await f.command("source file.ts");
	await assert.rejects(f.show(), /interactive TUI/);
	assert.equal(f.launches.length, 0);
});

test("cancelled tool calls do not create cards", async (t) => {
	const f = await setup(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(f.tools.get("show_code_card").execute("id", { path: f.path }, controller.signal, undefined, f.ctx));
	assert.equal(f.entries.length, 0);
});

test("picker cancellation and session replacement during selection do not launch", async (t) => {
	const f = await setup(t);
	await f.show();
	f.ctx.ui.select = async () => undefined;
	await f.command("");
	f.ctx.ui.select = async (_title, items) => { f.events.get("session_shutdown")(); return items[0]; };
	await f.command("");
	assert.equal(f.launches.length, 0);
});

test("agent starting while the picker is open blocks handoff", async (t) => {
	const f = await setup(t);
	await f.show();
	f.ctx.ui.select = async (_title, items) => { f.ctx.isIdle = () => false; return items[0]; };
	await f.command("");
	assert.equal(f.launches.length, 0);
	assert.match(f.notifications.at(-1).text, /Pi started working/);
});

test("different working directories and retargeted symlinks are refused", async (t) => {
	const f = await setup(t);
	const alias = join(f.cwd, "alias.ts");
	await symlink(f.path, alias);
	await f.show({ path: alias });
	const other = join(f.cwd, "other.ts");
	await writeFile(other, "other\n");
	await rm(alias);
	await symlink(other, alias);
	await f.command("--last");
	assert.match(f.notifications.at(-1).text, /symlink target changed/);
	f.ctx.cwd = tmpdir();
	await f.command("--last");
	assert.match(f.notifications.at(-1).text, /different working directory/);
	assert.equal(f.launches.length, 0);
});

test("nonzero exit still reports saved changes; deleted files report uncertainty", async (t) => {
	const f = await setup(t, async (_ctx, target) => {
		await writeFile(target.path, "saved despite exit\n");
		return { status: 1, signal: null };
	});
	await f.command('"source file.ts":2');
	assert.match(f.messages[0].content, /saved despite exit/);
	assert.ok(f.notifications.some((item) => /code 1/.test(item.text)));
	const g = await setup(t, async (_ctx, target) => { await rm(target.path); });
	await g.command('"source file.ts":2');
	assert.match(g.messages[0].content, /could not verify/);
});

test("slugs and bare IDs open the same card; legacy #id remains supported", async (t) => {
	const f = await setup(t);
	const { details } = await f.show({ slug: "Index Hash Detect", title: "Detect changes" });
	assert.equal(details.slug, "index-hash-detect");
	assert.equal(f.entries[0].data.slug, details.slug);
	for (const reference of [details.slug, details.cardId, details.cardId.toUpperCase(), `#${details.cardId}`]) {
		await f.command(reference);
		assert.equal(f.launches.at(-1).path, f.path);
	}
	assert.equal(f.launches.length, 4);
	assert.equal(f.entries.length, 1);
	assert.equal(f.messages.length, 0);
	await f.command("index-hash");
	await f.command("unknown-card-name");
	await f.command("00000000");
	assert.equal(f.launches.length, 4);
	assert.match(f.notifications.at(-1).text, /current conversation branch/);
});

test("slug collisions are resolved at persistence even for parallel tool calls", async (t) => {
	const f = await setup(t);
	const results = await Promise.all(Array.from({ length: 3 }, () => f.show({ slug: "detect-changes" })));
	assert.deepEqual(results.map((result) => result.details.slug).sort(), ["detect-changes", "detect-changes-2", "detect-changes-3"]);
	assert.deepEqual(f.complete().map((item) => item.value), f.entries.toReversed().map((entry) => entry.data.slug));
	for (const result of results) {
		assert.ok(result.content[0].text.includes(`/code ${result.details.slug}`));
	}
	// Fallback slugs follow the same collision rules.
	const titled = await f.show({ title: "Detect changes" });
	assert.equal(titled.details.slug, "detect-changes-4");
	await f.command('"source file.ts":2');
	await f.command('"source file.ts":2');
	assert.equal(f.entries.at(-2).data.slug, "source-file-2");
	assert.equal(f.entries.at(-1).data.slug, "source-file-2-2");
});

test("exact references take precedence over filenames; explicit paths still work", async (t) => {
	const f = await setup(t);
	const { details } = await f.show({ slug: "index-hash-detect" });
	for (const name of [details.slug, details.cardId]) {
		const path = join(f.cwd, name);
		await writeFile(path, "literal file\n");
		await f.command(name);
		assert.equal(f.launches.at(-1).path, f.path);
		await f.command(`./${name}`);
		assert.equal(f.launches.at(-1).path, path);
	}
	await f.command('"index-hash-detect"');
	assert.equal(f.launches.at(-1).path, join(f.cwd, details.slug));
});

test("completion lists newest slugs and legacy IDs, filters both, and never launches or writes", async (t) => {
	const f = await setup(t);
	assert.equal(f.complete(), null);
	const first = await f.show({ slug: "index-hash-detect", title: "Detect changes\x1b[2J\nnow" });
	const second = await f.show({ slug: "neovim-handoff" });
	const old = await f.show();
	delete f.entries.at(-1).data.slug;
	const before = JSON.stringify(f.entries);
	assert.deepEqual(f.complete().map((item) => item.value), [old.details.cardId, second.details.slug, first.details.slug]);
	assert.deepEqual(f.complete("index-").map((item) => item.value), [first.details.slug]);
	assert.equal(f.complete("index-")[0].description, "source file.ts:2 · Detect changes\\u001b[2J now");
	assert.ok(f.complete(first.details.cardId.slice(0, 3).toUpperCase()).some((item) => item.value === first.details.cardId));
	assert.ok(f.complete(`#${first.details.cardId.slice(0, 3)}`).some((item) => item.value === first.details.cardId));
	assert.deepEqual(f.complete("--").map((item) => item.value), ["--last"]);
	for (const query of ["unknown-card", "./source", '"source', "source file.ts", "--unknown"]) {
		assert.equal(f.complete(query), null);
	}
	assert.equal(f.launches.length, 0);
	assert.equal(f.messages.length, 0);
	assert.equal(JSON.stringify(f.entries), before);
	assert.equal(await readFile(f.path, "utf8"), "first\nconst timeout = 1000;\nlast\n");
});

test("completion tracks reload/resume, new cards, tree navigation, and session shutdown", async (t) => {
	const f = await setup(t);
	await f.show({ slug: "original-card" });
	f.events.get("session_shutdown")();
	assert.equal(f.complete(), null);
	// Round-trip persisted entries, not an in-memory slug cache.
	f.entries.splice(0, f.entries.length, ...JSON.parse(JSON.stringify(f.entries)));
	f.initialize(false);
	assert.equal(f.complete(), null);
	f.events.get("session_start")({ reason: "resume" }, f.ctx);
	assert.equal(f.complete()[0].value, "original-card");
	await f.command("original-card");
	assert.equal(f.launches.length, 1);
	await f.show({ slug: "latest-card" });
	assert.equal(f.complete()[0].value, "latest-card");
	const branch = f.entries.slice();
	f.entries.pop();
	f.events.get("session_tree")({}, f.ctx);
	assert.deepEqual(f.complete().map((item) => item.value), ["original-card"]);
	await f.command("latest-card");
	assert.equal(f.launches.length, 1);
	// Slugs from abandoned branches don't reserve names on this branch.
	const replacement = await f.show({ slug: "latest-card" });
	assert.equal(replacement.details.slug, "latest-card");
	f.entries.splice(0, f.entries.length, ...branch);
	f.events.get("session_tree")({}, f.ctx);
	assert.equal(f.complete()[0].value, "latest-card");
	assert.equal(f.complete()[0].description, "source file.ts:2");
	f.events.get("session_shutdown")();
	f.events.get("session_start")({ reason: "new" }, { ...f.ctx, sessionManager: { getBranch: () => [] } });
	assert.equal(f.complete(), null);
});

test("legacy and malformed restored cards are handled safely by lookup and completion", async (t) => {
	const f = await setup(t);
	const result = await f.show();
	delete f.entries[0].data.slug;
	f.entries.push({ type: "custom", customType: CARD_TYPE, data: { ...f.entries[0].data, id: "abcdef01", slug: "bad\x1b[2J" } });
	assert.deepEqual(f.complete().map((item) => item.value), [result.details.cardId]);
	await f.command(result.details.cardId);
	await f.command(`#${result.details.cardId}`);
	assert.equal(f.launches.length, 2);
	f.ctx.mode = "rpc";
	assert.equal(f.complete(), null);
});

test("Pi's autocomplete provider fills slugs and bare IDs while preserving forced file completion", async (t) => {
	const f = await setup(t);
	const { details } = await f.show({ slug: "index-hash-detect" });
	const provider = new CombinedAutocompleteProvider([{ name: "code", ...f.commands.get("code") }], f.cwd);
	for (const input of ["/code ", "/code index-", `/code ${details.cardId.slice(0, 3)}`]) {
		const suggestions = await provider.getSuggestions([input], 0, input.length, {});
		assert.ok(suggestions?.items.length);
		const item = suggestions.items[0];
		const completed = provider.applyCompletion([input], 0, input.length, item, suggestions.prefix);
		assert.equal(completed.lines[0], `/code ${item.value}`);
		assert.ok(!item.value.startsWith("#"));
	}
	const input = "/code ./source";
	const files = await provider.getSuggestions([input], 0, input.length, { force: true });
	assert.ok(files?.items.some((item) => item.value.includes("source file.ts")));
	assert.equal(f.launches.length, 0);
});

test("picker and edit notifications use readable references without # prefixes", async (t) => {
	const f = await setup(t, async (_ctx, target) => { await writeFile(target.path, "edited\n"); });
	const { details } = await f.show({ slug: "index-hash-detect" });
	f.ctx.ui.select = async (_title, choices) => {
		assert.ok(choices[0].startsWith("index-hash-detect · "));
		assert.ok(!choices[0].includes(`#${details.cardId}`));
		return choices[0];
	};
	await f.command("");
	assert.match(f.messages[0].content, /reopen with \/code index-hash-detect/);
});

test("failed handoff releases the interaction lock so the next attempt works", async (t) => {
	let count = 0;
	const f = await setup(t, async () => { if (++count === 1) throw new Error("missing nvim"); });
	await f.command('"source file.ts":2');
	assert.match(f.notifications.at(-1).text, /missing nvim/);
	await f.command("--last");
	assert.equal(f.launches.length, 2);
});
