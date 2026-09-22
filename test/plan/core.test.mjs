import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_HELP, PLAN_INSTRUCTIONS, buildPlanPrompt, parsePlanCommand, planCompletions } from "../../extensions/plan/core.ts";
import { parseTodoDocument } from "../../extensions/todo/core.ts";

const source = `# TODO
- [ ] Fix login redirect <!-- todo:fix-login-redirect -->
  Notes not included.
  - [ ] Update docs <!-- todo:update-docs -->
- [x] Done task <!-- todo:done-task -->
- [X] Also done <!-- todo:also-done -->
`;
const build = (args, text = source) => buildPlanPrompt(parsePlanCommand(args), text);

test("planning instructions remain verbatim and requests preserve literal text", () => {
	assert.equal(PLAN_INSTRUCTIONS, "Let's create a plan, no need to implement. I will review and request edits to the plan, ask questions, or ask to implement.");
	for (const request of ['Add a "new feature" with  spaces', "Line one\n\nLine two\twith tabs", "Discuss --todo and $ARGUMENTS", "/review is a command"]) {
		assert.deepEqual(parsePlanCommand(request), { kind: "request", text: request });
		assert.equal(build(request), `${PLAN_INSTRUCTIONS}\n\n${request}`);
	}
	assert.equal(build("  A request  "), `${PLAN_INSTRUCTIONS}\n\nA request`);
	assert.equal(build("-- --todo should support priorities"), `${PLAN_INSTRUCTIONS}\n\n--todo should support priorities`);
	assert.equal(build("-- --help"), `${PLAN_INSTRUCTIONS}\n\n--help`);
});

test("parse todo selectors and keep optional extra instructions literal", () => {
	assert.deepEqual(parsePlanCommand("--todo fix-login-redirect"), { kind: "todo", slug: "fix-login-redirect", extraText: "" });
	assert.deepEqual(parsePlanCommand("  --todo\tfix-login-redirect\nFocus on tests\nKeep  spaces  "), {
		kind: "todo", slug: "fix-login-redirect", extraText: "Focus on tests\nKeep  spaces",
	});
	assert.deepEqual(parsePlanCommand("--todo --all"), { kind: "all", extraText: "" });
	for (const selector of ["fix-login-redirect", "--all"]) {
		assert.equal(parsePlanCommand(`--todo ${selector} --help --all literal`).extraText, "--help --all literal");
	}
});

test("empty commands and invalid flags or slugs provide actionable errors", () => {
	for (const args of ["", "  \n\t"]) assert.throws(() => parsePlanCommand(args), /Provide a request.*\/plan --todo <slug>.*\/plan --todo --all/);
	for (const args of ["--todo", "--todo \t\n"]) assert.throws(() => parsePlanCommand(args), /Provide a todo slug.*\/plan --todo --all/);
	assert.throws(() => parsePlanCommand("--"), /Provide a request after \/plan --/);
	for (const args of ["--bad", "--all", "--help extra", "--todo=fix", "--todo --help", "--todo #fix", "--todo FIX", "--todo a_b", "--todo a--b", "--todo ../fix"]) {
		assert.throws(() => parsePlanCommand(args), /\/plan --help/);
	}
});

test("help explains every flag without being a planning prompt", () => {
	assert.deepEqual(parsePlanCommand(" --help "), { kind: "help" });
	for (const usage of ["/plan <request>", "/plan --todo <slug> [extra text]", "/plan --todo --all [extra text]", "/plan -- <request>", "/plan --help"]) {
		assert.ok(PLAN_HELP.includes(usage));
	}
	assert.match(PLAN_HELP, /every unchecked task/);
	assert.match(PLAN_HELP, /must follow --todo/);
	assert.match(PLAN_HELP, /even if it starts with a flag/);
});

test("single todo includes only slug and task text, plus optional extra text", () => {
	const expected = `${PLAN_INSTRUCTIONS}\n\nTodo: fix-login-redirect\nFix login redirect`;
	assert.equal(build("--todo fix-login-redirect"), expected);
	assert.equal(build("--todo fix-login-redirect Focus on tests\nKeep it simple"), `${expected}\n\nAdditional instructions:\nFocus on tests\nKeep it simple`);
	assert.equal(build("--todo done-task"), `${PLAN_INSTRUCTIONS}\n\nTodo: done-task\nDone task`);
});

test("--all includes only unchecked items in file order and appends extra text once", () => {
	const expected = `${PLAN_INSTRUCTIONS}\n\nTodo: fix-login-redirect\nFix login redirect\n\nTodo: update-docs\nUpdate docs`;
	assert.equal(build("--todo --all"), expected);
	assert.equal(build("--todo --all Group related work"), `${expected}\n\nAdditional instructions:\nGroup related work`);
	for (const empty of ["", "# TODO\n", "- [x] Done\n- [X] Done too\n"]) {
		assert.throws(() => build("--todo --all", empty), /No unchecked todo items/);
	}
});

test("missing files, missing exact slugs, and malformed metadata fail", () => {
	for (const args of ["--todo missing", "--todo --all"]) assert.throws(() => build(args, null), /TODO.md was not found/);
	assert.throws(() => build("--todo fix"), /No item found for slug: fix/);
	for (const invalid of ["- [ ] A <!-- todo:same -->\n- [x] B <!-- todo:same -->", "- [ ] A <!-- todo:BAD -->"]) {
		assert.throws(() => build("--todo --all", invalid), /Duplicate todo slug|Invalid todo slug metadata/);
	}
});

test("provisional slugs match /todo parsing, preserve explicit slugs, and ignore fenced examples", () => {
	const text = "\ufeff# TODO\r\n```md\r\n- [ ] Example\r\n```\r\n- [ ] Please fix the login redirect\r\n- [x] Existing <!-- todo:fix-login-redirect -->\r\n- [ ] Renamed <!-- todo:older-long-slug-still-valid -->\r\n";
	const { items } = parseTodoDocument(text);
	assert.deepEqual(items.map((item) => item.slug), ["fix-login-redirect-2", "fix-login-redirect", "older-long-slug-still-valid"]);
	assert.equal(build("--todo fix-login-redirect-2", text), `${PLAN_INSTRUCTIONS}\n\nTodo: fix-login-redirect-2\nPlease fix the login redirect`);
	assert.match(build("--todo --all", text), /Todo: older-long-slug-still-valid\nRenamed/);
	assert.doesNotMatch(build("--todo --all", text), /Example|Existing/);
});

test("completion offers flags and only unchecked slugs with descriptions", () => {
	assert.deepEqual(planCompletions(null, "").map((item) => item.value), ["--todo ", "--help", "-- "]);
	assert.equal(planCompletions(null, "--h")[0].value, "--help");
	assert.deepEqual(planCompletions(source, "--todo ").map((item) => item.value), ["--todo fix-login-redirect", "--todo update-docs", "--todo --all"]);
	assert.deepEqual(planCompletions(source, "  --todo\tfi").map((item) => item.value), ["--todo fix-login-redirect"]);
	assert.equal(planCompletions(source, "--todo fi")[0].description, "Fix login redirect");
	assert.equal(planCompletions(source, "--todo --a")[0].value, "--todo --all");
	assert.deepEqual(planCompletions(null, "--todo ").map((item) => item.value), ["--todo --all"]);
	for (const prefix of ["--todo done", "--todo also", "--todo nope", "--todo fix-login-redirect ", "--todo fix-login-redirect extra", "--todo --all ", "--todo --all extra", "A request", "-- --todo", "--help ", "--all"]) {
		assert.equal(planCompletions(source, prefix), null, prefix);
	}
});

test("file-sourced terminal controls are stripped from task prompts and completion descriptions", () => {
	const text = "- [ ] Task\x1b[2J\x07 <!-- todo:task -->\n";
	assert.equal(planCompletions(text, "--todo t")[0].description, "Task[2J");
	assert.equal(build("--todo task", text), `${PLAN_INSTRUCTIONS}\n\nTodo: task\nTask[2J`);
});
