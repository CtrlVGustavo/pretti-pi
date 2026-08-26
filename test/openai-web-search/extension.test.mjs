import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../../extensions/openai-web-search/index.ts", import.meta.url).href;

function run(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv });
}

test("extension registers only web_search and supports partial batch success", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-extension-"));
	const child = run(`
		let call = 0;
		globalThis.fetch = async () => {
			call += 1;
			if (call === 2) return new Response("temporary failure", { status: 503 });
			return new Response(JSON.stringify({ output: [
				{ type: "web_search_call", action: { sources: [{ title: "Source", url: "https://example.com/source" }] } },
				{ type: "message", content: [{ type: "output_text", text: "Answer " + call }] },
			] }), { status: 200 });
		};
		const tools = [];
		const events = [];
		const { default: initialize } = await import(${JSON.stringify(indexUrl)});
		initialize({
			registerTool(tool) { tools.push(tool); },
			on(name, handler) { events.push({ name, handler }); },
		});
		const ctx = { modelRegistry: { getAll() { throw new Error("unavailable"); } } };
		const result = await tools[0].execute("call", { queries: ["one", "two", "one"] }, undefined, undefined, ctx);
		console.log(JSON.stringify({ names: tools.map(tool => tool.name), events: events.map(event => event.name), result }));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.deepEqual(output.names, ["web_search"]);
	assert.deepEqual(output.events, ["session_shutdown"]);
	assert.equal(output.result.details.successfulQueries, 1);
	assert.equal(output.result.details.failedQueries, 1);
	assert.match(output.result.content[0].text, /Answer 1/);
	assert.match(output.result.content[0].text, /Failed queries/);
});

test("large output is truncated, saved temporarily, and removed on shutdown", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-extension-truncation-"));
	const child = run(`
		import { existsSync } from "node:fs";
		globalThis.fetch = async () => new Response(JSON.stringify({ output: [{
			type: "message",
			content: [{ type: "output_text", text: "x".repeat(70_000) }],
		}] }), { status: 200 });
		const tools = [];
		const events = [];
		const { default: initialize } = await import(${JSON.stringify(indexUrl)});
		initialize({ registerTool(tool) { tools.push(tool); }, on(name, handler) { events.push({ name, handler }); } });
		const ctx = { modelRegistry: { getAll() { throw new Error("unavailable"); } } };
		const result = await tools[0].execute("call", { query: "large" }, undefined, undefined, ctx);
		const path = result.details.fullOutputPath;
		const existed = existsSync(path);
		await events.find(event => event.name === "session_shutdown").handler();
		console.log(JSON.stringify({ truncated: result.details.truncated, existed, removed: !existsSync(path), textLength: result.content[0].text.length }));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.truncated, true);
	assert.equal(output.existed, true);
	assert.equal(output.removed, true);
	assert.ok(output.textLength < 55_000);
});

test("extension rejects an empty query and fails when all searches fail", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-extension-errors-"));
	const child = run(`
		globalThis.fetch = async () => new Response("unavailable", { status: 503 });
		const tools = [];
		const { default: initialize } = await import(${JSON.stringify(indexUrl)});
		initialize({ registerTool(tool) { tools.push(tool); }, on() {} });
		const ctx = { modelRegistry: { getAll() { throw new Error("unavailable"); } } };
		const messages = [];
		for (const params of [{ query: " " }, { query: "fails" }]) {
			try { await tools[0].execute("call", params, undefined, undefined, ctx); }
			catch (error) { messages.push(error.message); }
		}
		console.log(JSON.stringify(messages));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	const messages = JSON.parse(child.stdout);
	assert.match(messages[0], /requires a non-empty query/);
	assert.match(messages[1], /OpenAI web search failed/);
});
