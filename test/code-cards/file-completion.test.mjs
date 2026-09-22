import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { fileCompletions, createFileAutocompleteProvider } from "../../extensions/code-cards/file-completion.ts";
import { parseCodeCommand, quoteFilePath, prepareFileTarget, resolveFilePath } from "../../extensions/code-cards/core.ts";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
async function fixture(t, git = true) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-code-files-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	if (git) await exec("git", ["init", "-q", cwd]);
	const put = async (path, text = "first\nsecond\n") => {
		await mkdir(dirname(join(cwd, path)), { recursive: true });
		await writeFile(join(cwd, path), text);
	};
	return { cwd, put };
}

test("--file bypasses all card references and accepts positions, home, and absolute paths", () => {
	const cards = [{ id: "abcdef01", slug: "source-file" }];
	for (const path of ["source-file", "abcdef01", "#abcdef01", "--last", "--file", "/tmp/source.ts", "~/source.ts"]) {
		assert.deepEqual(parseCodeCommand(`--file ${path}:2:3`, cards), { kind: "file", request: { path, line: 2, column: 3 } });
		assert.equal(parseCodeCommand(`--file ${path}`, cards).kind, "file");
	}
	assert.equal(parseCodeCommand("source-file", cards).kind, "card");
	for (const input of ["--file", "--file   ", '--file ""', '--file "unfinished', "--file file:0", "--file file:1:0", "--file file\0"]) {
		assert.throws(() => parseCodeCommand(input));
	}
	assert.throws(() => parseCodeCommand("--file"), /fuzzy-search/);
	assert.equal(resolveFilePath("/tmp", "~/source.ts"), join(homedir(), "source.ts"));
});

test("completion path quoting round-trips spaces, quotes, backslashes, colons, and shell metacharacters", () => {
	for (const path of ["src/some file.ts", 'both\'"quotes.ts', String.raw`back\slash.ts`, 'a"b.ts', "file:42", "$(touch marker);file.ts", "-option", "name 'quoted'.ts"]) {
		assert.deepEqual(parseCodeCommand(`--file ${quoteFilePath(path)}:2:3`).request, { path, line: 2, column: 3 });
	}
	assert.equal(parseCodeCommand(`--file ${quoteFilePath("@source.ts")}`).request.path, "./@source.ts");
});

test("Git discovery includes tracked/untracked/hidden files, honors nested ignores, and fuzzy-matches full relative paths", async (t) => {
	const { cwd, put } = await fixture(t);
	await put(".gitignore", "ignored/\n*.log\n");
	await put("src/.gitignore", "secret.ts\n");
	await put("src/index.ts");
	await put("src/secret.ts");
	await put("ignored/hidden.ts");
	await put("tracked.log");
	await put("untracked.log");
	await put("other/index.ts");
	await put(".hidden.ts");
	await exec("git", ["add", "-f", "tracked.log", "src/index.ts"], { cwd });
	const all = await fileCompletions(cwd, "", signal());
	const labels = all.map((item) => item.label);
	for (const name of ["src/index.ts", "other/index.ts", ".hidden.ts", "tracked.log"]) assert.ok(labels.includes(name), name);
	for (const name of ["src/secret.ts", "ignored/hidden.ts", "untracked.log"]) assert.ok(!labels.includes(name), name);
	assert.ok(!labels.some((name) => name.startsWith(".git/")));
	for (const query of ["sidx", "SRCIDX", "src/idx", "./src/idx"]) {
		const items = await fileCompletions(cwd, query, signal());
		assert.equal(items[0].label, "src/index.ts", query);
	}
	assert.deepEqual(await fileCompletions(cwd, "no-such-file-xyz", signal()), []);
	// Git output is scoped to cwd, not the repository root.
	assert.ok((await fileCompletions(join(cwd, "src"), "idx", signal())).some((item) => item.label === "index.ts"));
});

test("completion values open literal files, preserve line/column, and skip deleted/non-file entries", async (t) => {
	const { cwd, put } = await fixture(t);
	const names = ["src/my file.ts", 'src/both\'"quotes.ts', "src/name:42", "@file.ts", "~/literal.ts", "--last"];
	for (const name of [...names, "gone.ts"]) await put(name);
	await put("unsafe\x1b.ts");
	await exec("git", ["add", "."], { cwd });
	await rm(join(cwd, "gone.ts"));
	await symlink(join(cwd, "src"), join(cwd, "dir-link"));
	await symlink(join(cwd, "missing"), join(cwd, "broken-link"));
	const items = await fileCompletions(cwd, "", signal());
	assert.equal(items.length, names.length);
	for (const item of items) {
		const command = parseCodeCommand(item.value);
		const file = await prepareFileTarget(cwd, command.request);
		assert.equal(file.path, join(cwd, item.label));
		assert.ok(!("id" in file));
		assert.ok(!("preview" in file));
	}
	const positioned = await fileCompletions(cwd, '"src/my file.ts":2:3', signal());
	assert.equal(positioned[0].value, '--file "src/my file.ts":2:3');
	assert.equal((await prepareFileTarget(cwd, parseCodeCommand(positioned[0].value).request)).line, 2);
	assert.ok((await fileCompletions(cwd, '"src/my fi', signal())).some((item) => item.label === "src/my file.ts"));
	assert.equal((await fileCompletions(cwd, "./~/literal", signal()))[0].label, "~/literal.ts");
});

test("non-Git fallback skips metadata/dependencies and does not follow directory symlinks", async (t) => {
	const { cwd, put } = await fixture(t, false);
	await put("source.ts");
	await put("nested/other.ts");
	await put("node_modules/dependency.ts");
	await put(".worktrees/branch/source.ts");
	await symlink(cwd, join(cwd, "loop"));
	assert.deepEqual((await fileCompletions(cwd, "", signal())).map((item) => item.label).sort(), ["nested/other.ts", "source.ts"]);
});

test("results are capped and requests can be cancelled before or during discovery", async (t) => {
	const { cwd, put } = await fixture(t);
	for (let i = 0; i < 30; i++) await put(`file-${i}.ts`);
	assert.equal((await fileCompletions(cwd, "", signal())).length, 20);
	const controller = new AbortController();
	const pending = fileCompletions(cwd, "", controller.signal);
	controller.abort();
	assert.deepEqual(await pending, []);
	assert.deepEqual(await fileCompletions(cwd, "", controller.signal), []);
});

test("external absolute, home-relative, and parent paths browse one directory at a time", async (t) => {
	const { cwd, put } = await fixture(t);
	await put("external dir/nested/source file.ts");
	await put("external dir/first.ts");
	for (const base of [cwd, `~/${relative(homedir(), cwd)}`, `../${cwd.split("/").at(-1)}`]) {
		const items = await fileCompletions(cwd, `${base}/external dir/fst`, signal());
		assert.equal(items[0].label, `${base}/external dir/first.ts`);
		const target = await prepareFileTarget(cwd, parseCodeCommand(items[0].value).request);
		assert.equal(target.path, join(cwd, "external dir/first.ts"));
	}
	const folders = await fileCompletions(cwd, `${cwd}/external dir/nest`, signal());
	assert.equal(folders[0].label, `${cwd}/external dir/nested/`);
});

test("provider handles natural and forced completion, quote continuation, and delegates other input", async (t) => {
	const { cwd, put } = await fixture(t);
	await put("src/my file.ts");
	let delegated = 0;
	const base = new CombinedAutocompleteProvider([], cwd);
	const current = {
		getSuggestions: async () => { delegated++; return null; },
		applyCompletion: (...args) => base.applyCompletion(...args),
		shouldTriggerFileCompletion: () => false,
		triggerCharacters: ["#"],
	};
	const lifetime = new AbortController();
	const provider = createFileAutocompleteProvider(current, () => ({ cwd, signal: lifetime.signal }));
	assert.deepEqual(provider.triggerCharacters, ["#"]);
	for (const force of [false, true]) {
		const input = "/code --file smf";
		const suggestions = await provider.getSuggestions([input], 0, input.length, { force, signal: signal() });
		assert.equal(suggestions.items[0].label, "src/my file.ts");
		assert.equal(provider.applyCompletion([input], 0, input.length, suggestions.items[0], suggestions.prefix).lines[0], '/code --file "src/my file.ts"');
	}
	// Complete inside an already-closed quote without duplicating its closing quote.
	const input = '/code --file "src/my fi":2';
	const cursor = input.indexOf('":2');
	const suggestions = await provider.getSuggestions([input], 0, cursor, { signal: signal() });
	const result = provider.applyCompletion([input], 0, cursor, suggestions.items[0], suggestions.prefix);
	assert.equal(result.lines[0], '/code --file "src/my file.ts":2');
	assert.equal(provider.shouldTriggerFileCompletion([input], 0, cursor), true);
	// A directory completion keeps the cursor inside quotes so its next component completes correctly.
	await put("external dir/nested/source.ts");
	const directoryInput = `/code --file ${cwd}/external dir/nest`;
	const directories = await provider.getSuggestions([directoryInput], 0, directoryInput.length, { signal: signal() });
	const directoryResult = provider.applyCompletion([directoryInput], 0, directoryInput.length, directories.items[0], directories.prefix);
	assert.equal(directoryResult.lines[0][directoryResult.cursorCol], '"');
	const nested = await provider.getSuggestions(directoryResult.lines, 0, directoryResult.cursorCol, { signal: signal() });
	const nestedResult = provider.applyCompletion(directoryResult.lines, 0, directoryResult.cursorCol, nested.items[0], nested.prefix);
	assert.equal(parseCodeCommand(nestedResult.lines[0].slice(6)).request.path, join(cwd, "external dir/nested/source.ts"));
	for (const other of ["/code card", "/code --last", "/other --file ", "/code ./src", "/code --filename "]) {
		await provider.getSuggestions([other], 0, other.length, { signal: signal() });
		assert.equal(provider.shouldTriggerFileCompletion([other], 0, other.length), false);
	}
	assert.equal(delegated, 5);
	lifetime.abort();
	assert.equal(await provider.getSuggestions(["/code --file "], 0, 13, { signal: signal() }), null);
});
