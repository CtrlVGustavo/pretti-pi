import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenAIWebSearchConfig {
	openaiApiKey?: unknown;
	openaiResponsesUrl?: unknown;
	openaiSearchModel?: unknown;
}

export function getConfigDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getConfigPath(): string {
	return join(getConfigDir(), "web-search.json");
}

export function loadConfig(): OpenAIWebSearchConfig {
	const path = getConfigPath();
	if (!existsSync(path)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${path}: expected a JSON object`);
	}
	return parsed as OpenAIWebSearchConfig;
}
