import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const configUrl = new URL("../../extensions/openai-web-search/config.ts", import.meta.url).href;

function run(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "OPENAI_API_KEY"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv });
}

test("config path precedence and parsing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-openai-config-"));
	const agentDir = join(root, "agent");
	const xdgDir = join(root, "xdg");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ openaiSearchModel: "agent-model" }));
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({ openaiSearchModel: "xdg-model" }));
	const child = run(`
		const { getConfigDir, getConfigPath, loadConfig } = await import(${JSON.stringify(configUrl)});
		console.log(JSON.stringify({ dir: getConfigDir(), path: getConfigPath(), config: loadConfig() }));
	`, { PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: xdgDir, HOME: join(root, "home") });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: agentDir,
		path: join(agentDir, "web-search.json"),
		config: { openaiSearchModel: "agent-model" },
	});
});

test("malformed and non-object config fails loudly", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-openai-config-invalid-"));
	for (const [content, pattern] of [["{", "Failed to parse"], ["[]", "expected a JSON object"]]) {
		await writeFile(join(root, "web-search.json"), content);
		const child = run(`
			const { loadConfig } = await import(${JSON.stringify(configUrl)});
			try { loadConfig(); console.log("ok"); } catch (error) { console.log(error.message); }
		`, { PI_CODING_AGENT_DIR: root, HOME: root });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, new RegExp(pattern));
	}
});
