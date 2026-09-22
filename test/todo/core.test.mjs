import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTodoCommand, parseTodoDocument, safeText, todoCompletions, transformTodo, uniqueSlug } from "../../extensions/todo/core.ts";

const run = (source, args = "") => transformTodo(source, parseTodoCommand(args));

test("command grammar accepts all actions and literal unquoted text", () => {
	for (const args of ["", "  ", "--unchecked"]) assert.deepEqual(parseTodoCommand(args), { kind: "list", all: false });
	assert.deepEqual(parseTodoCommand(" --all "), { kind: "list", all: true });
	assert.deepEqual(parseTodoCommand("--cleardone"), { kind: "cleardone" });
	assert.deepEqual(parseTodoCommand("--check fix-login-2"), { kind: "check", slug: "fix-login-2" });
	assert.deepEqual(parseTodoCommand("Fix login redirect"), { kind: "add", text: "Fix login redirect" });
	assert.deepEqual(parseTodoCommand("-- --all is a literal task"), { kind: "add", text: "--all is a literal task" });
	assert.deepEqual(parseTodoCommand("Fix --all behavior"), { kind: "add", text: "Fix --all behavior" });
});

test("invalid flags, extra arguments, controls, and reserved metadata are rejected", () => {
	for (const args of ["--bad", "--", "--check", "--check a b", "--all --unchecked", "--all text", "--cleardone x", "--check #slug", "--check SLUG", "a\nb", "a\rb", "a\0b", "a\x1b[2J", "x <!-- todo:slug -->"]) {
		assert.throws(() => parseTodoCommand(args), undefined, args);
	}
});

test("slugs normalize, have a fallback, and remain unique against existing suffixed names", () => {
	assert.equal(uniqueSlug("Fix Café!", new Set()), "fix-cafe");
	assert.equal(uniqueSlug("🎉", new Set(["todo", "todo-2"])), "todo-3");
	assert.equal(uniqueSlug("Fix", new Set(["fix", "fix-2", "fix-4"])), "fix-3");
	assert.equal(uniqueSlug("a".repeat(200), new Set()).length, 80);
});

test("existing tasks get stable slugs, reserving explicit slugs before generating any", () => {
	const source = "# TODO\n\n- [ ] Fix\n- [x] Fix <!-- todo:fix -->\n- [ ] Fix\n";
	const first = run(source);
	assert.deepEqual(parseTodoDocument(first.content).items.map((item) => item.slug), ["fix-2", "fix", "fix-3"]);
	assert.equal(run(first.content).content, first.content);
	const edited = first.content.replace("- [ ] Fix <!-- todo:fix-2", "- [ ] Renamed <!-- todo:fix-2");
	assert.match(run(edited, "--check fix-2").content, /\[x\] Renamed <!-- todo:fix-2/);
});

test("list filters checked items and --all keeps file order", () => {
	const source = "- [ ] First\n* [X] Second\n1. [ ] Third\n";
	assert.equal(run(source).output, "TODO.md — unchecked items\n[ ] first — First\n[ ] third — Third");
	assert.equal(run(source, "--unchecked").output, run(source).output);
	assert.equal(run(source, "--all").output, "TODO.md — all items\n[ ] first — First\n[x] second — Second\n[ ] third — Third");
	assert.equal(run("- [x] Done\n").output, "No unchecked items.");
	assert.equal(run("# TODO\n\nNotes only\n").output, "TODO.md is empty.");
});

test("append handles duplicate text, checked collisions, BOM, CRLF, and missing final newline", () => {
	const source = "\ufeff# TODO\r\n\r\n- [x] Fix <!-- todo:fix -->";
	const result = run(source, "Fix");
	assert.equal(result.content, source + "\r\n- [ ] Fix <!-- todo:fix-2 -->\r\n");
	assert.equal(result.output, "Added fix-2 — Fix");
	assert.equal(run("", "New").content, "- [ ] New <!-- todo:new -->\n");
});

test("check only changes the checkbox, preserves formatting, and is idempotent", () => {
	const source = "\ufeff# Tasks\r\n\r\n  + [ ] **Fix** <!-- todo:fix -->  \r\nNotes.\r\n";
	const result = run(source, "--check fix");
	assert.equal(result.content, source.replace("[ ]", "[x]"));
	const again = run(result.content, "--check fix");
	assert.equal(again.content, result.content);
	assert.equal(again.output, "Already checked: fix.");
	assert.equal(run("- [X] Old <!-- todo:old -->", "--check old").content, "- [X] Old <!-- todo:old -->");
});

test("unknown check does not even annotate existing tasks", () => {
	const source = "- [ ] Legacy\n";
	const result = run(source, "--check missing");
	assert.equal(result.content, source);
	assert.equal(result.error, true);
	assert.match(result.output, /No item found/);
	assert.match(run("", "--check missing").output, /TODO.md is empty/);
});

test("duplicate and malformed metadata are refused rather than repaired silently", () => {
	for (const source of [
		"- [ ] One <!-- todo:same -->\n- [x] Two <!-- todo:same -->\n",
		"- [ ] One <!-- todo:BAD -->\n",
		"- [ ] One <!-- todo:first --> <!-- todo:second -->\n",
		"- [ ] One <!-- todo:bad slug -->\n",
	]) {
		assert.throws(() => run(source));
		assert.throws(() => run(source, "--cleardone"));
	}
});

test("fenced examples are ignored, including longer fences, languages, and nested indentation", () => {
	const source = "# TODO\n```md\n- [ ] Example\n~~~\n- [x] Example two\n```\n" +
		"  ~~~~markdown\n  - [x] Nested example\n  ~~~\n  ~~~~\n" +
		"- [ ] Real\n";
	const result = run(source, "--all");
	assert.equal(result.output, "TODO.md — all items\n[ ] real — Real");
	assert.equal(result.content, source.replace("- [ ] Real", "- [ ] Real <!-- todo:real -->"));
	assert.equal(run(result.content, "--cleardone").content, result.content);
	assert.throws(() => run("```md\n- [ ] Example", "New"), /unclosed code fence/);
});

test("cleardone removes checked task lines but preserves notes, headings, and unchecked children", () => {
	const source = "# TODO\r\n\r\n- [x] Parent <!-- todo:parent -->\r\n  Notes to keep.\r\n  - [ ] Child <!-- todo:child -->\r\n\r\n## Later\r\n* [X] Done <!-- todo:done -->";
	const result = run(source, "--cleardone");
	assert.equal(result.content, "# TODO\r\n\r\n  Notes to keep.\r\n  - [ ] Child <!-- todo:child -->\r\n\r\n## Later\r\n");
	assert.equal(result.output, "Removed 2 checked items.");
	assert.equal(run(result.content, "--cleardone").output, "No checked items to remove.");
	assert.equal(run("- [x] Only <!-- todo:only -->\n", "--cleardone").content, "");
	assert.equal(run("\ufeff- [x] Only <!-- todo:only -->\n", "--cleardone").content, "\ufeff");
});

test("autocomplete suggests flags and only unchecked matching slugs, preserving --check", () => {
	const source = "- [ ] Fix\n- [ ] Fix two\n- [x] Fixed\n";
	assert.deepEqual(todoCompletions(null, "--c").map((item) => item.value), ["--check ", "--cleardone"]);
	assert.deepEqual(todoCompletions(source, "--check fi").map((item) => item.value), ["--check fix", "--check fix-two"]);
	assert.equal(todoCompletions(source, "--check fix-t")[0].description, "Fix two");
	for (const prefix of ["--check xyz", "--check fix x", "--check --all", "Add something"]) assert.equal(todoCompletions(source, prefix), null);
	assert.equal(todoCompletions(null, "--check "), null);
});

test("file-sourced terminal control sequences never reach rendered output or suggestions", () => {
	assert.equal(safeText("a\x1b[2J\x9b31m\0b\nnext\tline"), "a[2J31mb\nnext    line");
	assert.equal(todoCompletions("- [ ] A\x1b[2J <!-- todo:a -->\n", "--check ")[0].description, "A[2J");
});
