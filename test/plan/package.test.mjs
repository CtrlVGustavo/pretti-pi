import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("package discovery and reload register one plan command and no plan template", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-plan-package-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager: SettingsManager.inMemory({ packages: [root] }),
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
	});
	for (let reload = 0; reload < 2; reload++) {
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		const commands = extensions.flatMap((extension) => [...extension.commands.values()]).filter((command) => command.name === "plan");
		assert.equal(commands.length, 1);
		assert.equal(typeof commands[0].getArgumentCompletions, "function");
		assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "plan"), false);
		const notices = [];
		await commands[0].handler("--help", { mode: "tui", ui: { notify: (text) => notices.push(text) } });
		assert.match(notices[0], /\/plan --todo --all/);
	}
});
