import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createCard, safeText } from "../../extensions/code-cards/core.ts";
import { renderCard } from "../../extensions/code-cards/index.ts";

const plainTheme = { fg: (_color, text) => text };

async function fixture(t, source, filename = "source.ts") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-card-render-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, filename);
	await writeFile(path, source);
	return { path, card: await createCard(cwd, { path, slug: "index-hash-detect" }) };
}

test("supported previews use syntax colors without changing persisted text or source layout", async (t) => {
	initTheme("dark", false);
	const source = 'const value = "hello";\n// a comment\n';
	const { card, path } = await fixture(t, source);
	const snapshot = JSON.stringify(card);
	const component = renderCard(card, plainTheme);
	// Rendering must use the snapshot, not the live file.
	await writeFile(path, "different file contents\n");
	const lines = component.render(120);
	assert.match(lines.join("\n"), /\x1b\[[0-9;]+mconst/);
	assert.match(lines.join("\n"), /\x1b\[[0-9;]+m"hello"/);
	const plain = lines.map(stripTerminalSequences).join("\n");
	assert.match(plain, /›\s+1 const value = "hello";/);
	assert.match(plain, /\/code index-hash-detect/);
	assert.ok(plain.includes(card.id));
	assert.ok(!plain.includes(`#${card.id}`));
	assert.ok(!plain.includes("different file contents"));
	assert.equal(JSON.stringify(card), snapshot);
});

test("highlighting the whole snippet preserves multiline comment styles after each gutter", async (t) => {
	initTheme("dark", false);
	const source = '/* comment\n * second line\n\n */\nconst value = 42;\n';
	const { card } = await fixture(t, source);
	const lines = renderCard(card, plainTheme).render(120);
	const first = lines.find((line) => line.includes("/* comment"));
	const second = lines.find((line) => line.includes("* second line"));
	const color = first.match(/(\x1b\[[0-9;]+m)\/\* comment/)[1];
	assert.ok(second.includes(`${color} * second line`));
	const visible = lines.map(stripTerminalSequences);
	assert.match(visible[4], /\s+3\s+│$/); // Empty source line is retained.
	assert.match(visible[6], /\s+5 const value = 42;/);
});

test("theme invalidation refreshes syntax colors, while resizing reuses the cached snapshot", async (t) => {
	initTheme("dark", false);
	t.after(() => initTheme("dark", false));
	const { card } = await fixture(t, 'const value = "hello";');
	let calls = 0;
	const component = renderCard(card, plainTheme, (code, lang) => {
		calls++;
		return highlightCode(code, lang);
	});
	const dark = component.render(100);
	component.render(30);
	assert.equal(calls, 1);
	initTheme("light", false);
	component.invalidate();
	const light = component.render(100);
	assert.equal(calls, 2);
	assert.notDeepEqual(light, dark);
	assert.deepEqual(light.map(stripTerminalSequences), dark.map(stripTerminalSequences));
});

test("unknown languages and highlighter failures retain readable plain previews", async (t) => {
	const { card } = await fixture(t, "some text", "source.unknown-language");
	let called = false;
	const neverHighlight = () => { called = true; return []; };
	assert.match(renderCard(card, plainTheme, neverHighlight).render(100).join("\n"), /some text/);
	assert.equal(called, false);
	const known = { ...card, path: card.path + ".ts" };
	for (const highlighter of [() => { throw new Error("highlight failed"); }, () => []]) {
		const output = renderCard(known, plainTheme, highlighter).render(100).join("\n");
		assert.match(output, /some text/);
		assert.ok(!output.includes("\x1b"));
	}
});

test("highlighting escapes source controls first and respects terminal widths, Unicode, and tabs", async (t) => {
	initTheme("dark", false);
	const source = '\tconst text = "中文👩‍💻' + "x".repeat(400) + '";\n//\x1b[2J\x1b]8;;https://bad\x07bad\u202e';
	const { card } = await fixture(t, source);
	card.title = "bad\x1b[2J\nnext";
	const component = renderCard(card, plainTheme, (code, language) => {
		assert.equal(code, card.preview.map((item) => safeText(item.text)).join("\n"));
		assert.ok(!code.includes("\x1b"));
		return highlightCode(code, language);
	});
	for (const width of [0, 1, 3, 4, 5, 10, 20, 80, 200]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
		// Only highlighter-generated SGR codes may remain, not raw controls from the source.
		assert.ok(lines.every((line) => !line.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b")));
		assert.ok(lines.every((line) => !line.includes("\u202e") && !line.includes("\x07")));
	}
	assert.match(component.render(200).map(stripTerminalSequences).join("\n"), /\\u001b\[2J/);
});

test("legacy cards display and link to bare IDs", async (t) => {
	const { card } = await fixture(t, "old card");
	delete card.slug;
	const output = renderCard(card, plainTheme).render(100).map(stripTerminalSequences).join("\n");
	assert.ok(output.includes(`/code ${card.id}`));
	assert.ok(!output.includes(`#${card.id}`));
});
