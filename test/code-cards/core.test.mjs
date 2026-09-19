import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	MAX_DIFF_BYTES, MAX_FILE_BYTES, MAX_SLUG_LENGTH, boundedDiff, createCard, isCodeCard, locateCard,
	parseCodeCommand, readSnapshot, safeText, uniqueCardSlug,
} from "../../extensions/code-cards/core.ts";
import { renderCard } from "../../extensions/code-cards/index.ts";

async function fixture(t, content = "one\ntwo\nthree\nfour\n") {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cards-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "source.ts");
	await writeFile(path, content);
	return { cwd, path };
}

test("command parsing: picker, IDs, latest, lines, quotes, and literal spaces", () => {
	assert.deepEqual(parseCodeCommand(""), { kind: "picker" });
	assert.deepEqual(parseCodeCommand("--last"), { kind: "last" });
	for (const id of ["abcdef01", "ABCDEF01", "#abcdef01"]) {
		assert.deepEqual(parseCodeCommand(id), { kind: "card", id: "abcdef01" });
	}
	for (const value of ["src/some file.ts:42:3", '"src/some file.ts":42:3', "'src/some file.ts':42:3"]) {
		assert.deepEqual(parseCodeCommand(value), { kind: "file", request: { path: "src/some file.ts", line: 42, column: 3 } });
	}
	assert.equal(parseCodeCommand("file.ts:42").request.column, 1);
	assert.equal(parseCodeCommand("$(touch marker);file.ts").request.path, "$(touch marker);file.ts");
	for (const value of ['"unfinished', '"file" junk', "file:0", "file:1:0", "file:999999999999999999999", "file\0"]) {
		assert.throws(() => parseCodeCommand(value));
	}
});

test("cards preview a bounded range and store an exact byte hash without modifying the file", async (t) => {
	const { cwd, path } = await fixture(t, "\ufeffone\r\ntwo\r\nthree\r\n");
	const before = await readSnapshot(path);
	const card = await createCard(cwd, { path: "@source.ts", line: 2, title: "Edit this" });
	assert.ok(isCodeCard(card));
	assert.equal(card.hash, before.hash);
	assert.equal(card.preview[1].text, "two");
	assert.equal(card.anchor, "two\nthree");
	assert.equal((await readSnapshot(path)).text, "\ufeffone\r\ntwo\r\nthree\r\n");
	assert.deepEqual(locateCard(card, before), { line: 2, stale: false });
});

test("anchor resolution follows moved code and marks absent/ambiguous anchors stale", async (t) => {
	const { cwd, path } = await fixture(t);
	const card = await createCard(cwd, { path, line: 2 });
	await writeFile(path, "new\nheader\none\ntwo\nthree\nfour\n");
	assert.deepEqual(locateCard(card, await readSnapshot(path)), { line: 4, stale: false });
	await writeFile(path, "two\nthree\nfour\ntwo\nthree\nfour\n");
	assert.equal(locateCard(card, await readSnapshot(path)).stale, true);
	await writeFile(path, "changed\n");
	assert.deepEqual(locateCard(card, await readSnapshot(path)), { line: 1, stale: true });
});

test("explicit unique anchor overrides line; invalid ranges and ambiguous anchors fail", async (t) => {
	const { cwd, path } = await fixture(t, "one\ntwo\none\n");
	assert.equal((await createCard(cwd, { path, anchorText: "two" })).line, 2);
	for (const request of [{ line: 0 }, { line: 4 }, { line: 2, endLine: 1 }, { endLine: 9 }, { anchorText: "one" }, { anchorText: "missing" }, { anchorText: " " }]) {
		await assert.rejects(createCard(cwd, { path, ...request }));
	}
});

test("empty files work; directories, binary, invalid UTF-8, and oversized files are refused", async (t) => {
	const { cwd, path } = await fixture(t, "");
	assert.equal((await createCard(cwd, { path })).line, 1);
	const directory = join(cwd, "directory");
	await mkdir(directory);
	await assert.rejects(readSnapshot(directory), /regular file/);
	for (const [content, pattern] of [[Buffer.from([0]), /Binary/], [Buffer.from([0xff]), /UTF-8/], [Buffer.alloc(MAX_FILE_BYTES + 1, 65), /2 MiB/]]) {
		await writeFile(path, content);
		await assert.rejects(readSnapshot(path), pattern);
	}
});

test("symlink cards remember the original physical target", async (t) => {
	const { cwd, path } = await fixture(t);
	await symlink(path, join(cwd, "alias.ts"));
	const card = await createCard(cwd, { path: "alias.ts" });
	assert.equal(card.path, join(cwd, "alias.ts"));
	assert.equal(card.realPath, path);
});

test("restored card validation rejects malformed process targets", async (t) => {
	const { cwd, path } = await fixture(t);
	const card = await createCard(cwd, { path });
	const { slug: _slug, ...legacy } = card;
	assert.ok(isCodeCard(legacy));
	for (const bad of [null, {}, { ...card, line: -1 }, { ...card, path: "relative" }, { ...card, path: "/bad\0" }, { ...card, preview: [null] }, { ...card, version: 2 },
		...[null, 1, "", "Uppercase", "bad\x1b", "bad/path", "--last", "bad--slug", "abcdef01", "x".repeat(MAX_SLUG_LENGTH + 1)].map((slug) => ({ ...card, slug }))]) {
		assert.equal(isCodeCard(bad), false);
	}
});

test("previews and renders are bounded and terminal control characters are inert", async (t) => {
	const { cwd, path } = await fixture(t, Array.from({ length: 100 }, (_, i) => `${i} 中文 ${"x".repeat(500)}`).join("\n"));
	const card = await createCard(cwd, { path, line: 20, endLine: 90, title: "bad\x1b[2J\nnext" });
	assert.equal(card.preview.length, 12);
	assert.ok(card.preview.every((row) => row.text.length <= 241));
	const component = renderCard(card, { fg: (_color, text) => text });
	for (const width of [0, 1, 3, 4, 20, 80, 200]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
		assert.ok(lines.every((line) => !line.replace(/\x1b\[0m/g, "").includes("\x1b")));
	}
	assert.equal(safeText("a\x1bb"), "a\\u001bb");
});

test("slug generation normalizes meaningful words and falls back to title or filename/line", async (t) => {
	const { cwd, path } = await fixture(t);
	for (const [request, slug] of [
		[{ slug: "  Index / Hásh DETECT! " }, "index-hash-detect"],
		[{ slug: "custom-slug", title: "Different title" }, "custom-slug"],
		[{ title: "Detect file changes" }, "detect-file-changes"],
		[{ slug: "🎉", title: "Detect file changes" }, "detect-file-changes"],
		[{ slug: "🎉", title: "🎉" }, "source-2"],
		[{}, "source-2"],
		[{ slug: "ABCDEF01" }, "code-abcdef01"],
		[{ slug: "--last" }, "last"],
		[{ slug: "x".repeat(200) }, "x".repeat(MAX_SLUG_LENGTH)],
		[{ slug: "a".repeat(63) + "-more" }, "a".repeat(63)],
	]) {
		const card = await createCard(cwd, { path, line: 2, ...request });
		assert.equal(card.slug, slug);
		assert.ok(isCodeCard(card));
	}
});

test("slug collisions get bounded numeric suffixes without renaming existing cards", () => {
	const cards = [{ id: "abcdef01", slug: "index-hash-detect" }, { id: "abcdef02", slug: "index-hash-detect-2" }];
	assert.equal(uniqueCardSlug("index-hash-detect", cards), "index-hash-detect-3");
	assert.equal(uniqueCardSlug("different", cards), "different");
	const long = "x".repeat(MAX_SLUG_LENGTH);
	assert.equal(uniqueCardSlug(long, [{ id: "abcdef03", slug: long }]), "x".repeat(MAX_SLUG_LENGTH - 2) + "-2");
	assert.equal(cards[0].slug, "index-hash-detect");
});

test("slug lookup is exact; explicit paths disambiguate filenames and references", () => {
	const cards = [{ id: "abcdef01", slug: "index-hash-detect" }];
	assert.deepEqual(parseCodeCommand("index-hash-detect", cards), { kind: "card", id: "abcdef01" });
	for (const input of ["./index-hash-detect", '"index-hash-detect"', "index-hash-detect:2", "index-hash", "unknown-slug", "./abcdef01", '"abcdef01"']) {
		assert.equal(parseCodeCommand(input, cards).kind, "file");
	}
});

test("diffs include final-newline and CRLF changes and cap output", () => {
	assert.match(boundedDiff("file", "old\n", "new\n"), /-old\n\+new/);
	assert.match(boundedDiff("file", "same", "same\n"), /No newline/);
	assert.match(boundedDiff("file", "same\r\n", "same\n"), /\\u000d/);
	const huge = boundedDiff("file", Array.from({ length: 1000 }, (_, i) => `old${i}`).join("\n"), Array.from({ length: 1000 }, (_, i) => `new${i}`).join("\n"));
	assert.ok(Buffer.byteLength(huge) <= MAX_DIFF_BYTES);
	assert.match(huge, /truncated|computation limit/);
	const longLine = boundedDiff("file", "old", "x".repeat(100000));
	assert.ok(Buffer.byteLength(longLine) <= MAX_DIFF_BYTES);
	assert.match(longLine, /truncated/);
});
