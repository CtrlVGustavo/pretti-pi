import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../../extensions/openai-web-search/openai-search.ts", import.meta.url).href;

function run(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("OpenAI request requires web_search and maps filters and citations", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-search-"));
	const child = run(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ output: [
				{ type: "web_search_call", action: { sources: [
					{ title: "Duplicate", url: "https://openai.com/docs?utm_source=openai" },
					{ title: "Blog", url: "https://openai.com/blog?utm_source=openai" }
				] } },
				{ type: "message", content: [{ type: "output_text", text: "Cited answer", annotations: [{
					type: "url_citation", start_index: 0, end_index: 5,
					url: "https://openai.com/docs?utm_source=openai", title: "Docs"
				}] }] }
			] }), { status: 200 });
		};
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		const result = await searchWithOpenAI("latest docs", {
			numResults: 3,
			recencyFilter: "month",
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
		});
		console.log(JSON.stringify({ captured, result }));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout);
	assert.equal(captured.url, "https://api.openai.com/v1/responses");
	assert.equal(captured.headers.Authorization, "Bearer sk-test");
	assert.equal(captured.body.tool_choice, "required");
	assert.deepEqual(captured.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(captured.body.tools, [{
		type: "web_search",
		filters: { allowed_domains: ["openai.com"], blocked_domains: ["reddit.com"] },
	}]);
	assert.match(captured.body.instructions, /past month/);
	assert.match(captured.body.instructions, /3 distinct sources/);
	assert.equal(result.answer, "Cited answer");
	assert.deepEqual(result.results.map(item => item.url), ["https://openai.com/docs", "https://openai.com/blog"]);
});

test("configured endpoint must use HTTPS", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-insecure-endpoint-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiResponsesUrl: "http://gateway.example/v1/responses",
	}));
	const child = run(`
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		try { await searchWithOpenAI("insecure"); } catch (error) { console.log(error.message); }
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /must use HTTPS/);
});

test("configured endpoint, model, and command credential are resolved per request", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-gateway-"));
	const marker = join(home, "count");
	const resolver = join(home, "key.sh");
	await writeFile(resolver, `#!/bin/sh\ncount=0\n[ ! -f "$1" ] || count=$(cat "$1")\ncount=$((count+1))\nprintf '%s' "$count" > "$1"\nprintf 'key-%s\\n' "$count"\n`, { mode: 0o700 });
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		openaiApiKey: `!${resolver} ${marker}`,
		openaiResponsesUrl: "https://gateway.example/v1/responses",
		openaiSearchModel: "gateway-search-model",
	}));
	const child = run(`
		import { existsSync } from "node:fs";
		const requests = [];
		globalThis.fetch = async (url, init) => {
			requests.push({ url: String(url), auth: init.headers.Authorization, model: JSON.parse(init.body).model });
			return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 });
		};
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		const lazy = !existsSync(${JSON.stringify(marker)});
		await searchWithOpenAI("one");
		await searchWithOpenAI("two");
		console.log(JSON.stringify({ lazy, requests }));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "stale-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.lazy, true);
	assert.deepEqual(output.requests, [
		{ url: "https://gateway.example/v1/responses", auth: "Bearer key-1", model: "gateway-search-model" },
		{ url: "https://gateway.example/v1/responses", auth: "Bearer key-2", model: "gateway-search-model" },
	]);
});

test("Pi Codex auth uses the Codex endpoint, account header, and preferred model", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-codex-"));
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url");
	const token = `header.${payload}.signature`;
	const child = run(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "codex answer" }] }] }), { status: 200 });
		};
		const models = [
			{ provider: "openai-codex", id: "gpt-5.9" },
			{ provider: "openai-codex", id: "gpt-5.10-pro" },
			{ provider: "openai-codex", id: "gpt-5.10" },
		];
		const ctx = { modelRegistry: {
			getAll: () => models,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: ${JSON.stringify(token)}, headers: { "X-Pi": "yes" } }),
		} };
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		await searchWithOpenAI("codex", {}, ctx);
		console.log(JSON.stringify(captured));
	`, { HOME: home, PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const captured = JSON.parse(child.stdout);
	assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(captured.headers["chatgpt-account-id"], "acct-123");
	assert.equal(captured.headers.originator, "pi");
	assert.equal(captured.headers["X-Pi"], "yes");
	assert.equal(captured.body.model, "gpt-5.10");
});

test("SSE output is parsed", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-sse-"));
	const child = run(`
		globalThis.fetch = async () => new Response([
			'data: ' + JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "streamed answer" }] } }),
			'data: ' + JSON.stringify({ type: "response.completed", response: { output: [] } }),
			'data: [DONE]',
		].join('\\n\\n'), { status: 200, headers: { "content-type": "text/event-stream" } });
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		console.log(JSON.stringify(await searchWithOpenAI("stream")));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: "sk-test" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout).answer, "streamed answer");
});

test("provider errors redact the credential and empty responses fail", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-openai-errors-"));
	const secret = "SECRET_MUST_NOT_ESCAPE";
	const child = run(`
		const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
		const messages = [];
		globalThis.fetch = async () => new Response("provider echoed ${secret}", { status: 400 });
		try { await searchWithOpenAI("error"); } catch (error) { messages.push(error.message); }
		globalThis.fetch = async () => new Response(JSON.stringify({ output: [] }), { status: 200 });
		try { await searchWithOpenAI("empty"); } catch (error) { messages.push(error.message); }
		console.log(JSON.stringify(messages));
	`, { HOME: home, PI_CODING_AGENT_DIR: home, OPENAI_API_KEY: secret });
	assert.equal(child.status, 0, child.stderr);
	const messages = JSON.parse(child.stdout);
	assert.match(messages[0], /\[redacted\]/);
	assert.equal(messages[0].includes(secret), false);
	assert.match(messages[1], /no answer or sources/);
});
