import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchWithOpenAI } from "./openai-search.ts";
import type { SearchResponse } from "./types.ts";

const MAX_QUERIES = 8;

function normalizeQueries(query: unknown, queries: unknown): string[] {
	const source = Array.isArray(queries) && queries.length > 0 ? queries : [query];
	const normalized: string[] = [];
	for (const value of source) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
	}
	return normalized.slice(0, MAX_QUERIES);
}

function escapeMarkdownLabel(text: string): string {
	return text.replace(/([\\\[\]])/g, "\\$1");
}

function formatResponse(query: string, response: SearchResponse, showQueryHeading: boolean): string {
	const lines: string[] = [];
	if (showQueryHeading) lines.push(`## Query: ${query}`, "");
	if (response.answer) lines.push(response.answer, "");
	lines.push("### Sources");
	if (response.results.length === 0) {
		lines.push("No sources returned.");
	} else {
		for (const [index, result] of response.results.entries()) {
			lines.push(`${index + 1}. [${escapeMarkdownLabel(result.title)}](${result.url})`);
			if (result.snippet) lines.push(`   ${result.snippet}`);
		}
	}
	return lines.join("\n").trim();
}

export default function piOpenAIWebSearchExtension(pi: ExtensionAPI): void {
	const temporaryOutputs = new Set<string>();

	pi.on("session_shutdown", async () => {
		await Promise.all([...temporaryOutputs].map(async path => {
			try { await rm(path, { force: true }); } catch { /* Best-effort temporary-file cleanup. */ }
		}));
		temporaryOutputs.clear();
	});

	pi.registerTool({
		name: "web_search",
		label: "OpenAI Web Search",
		description: "Search the web with OpenAI's Responses API web_search tool. Uses Pi Codex/OpenAI authentication when available, otherwise OPENAI_API_KEY or ~/.pi/web-search.json. Returns a synthesized answer and source citations. Supports one query or a sequential batch of up to eight queries. Output is limited to 50 KB or 2,000 lines; truncated output is saved to a temporary file.",
		promptSnippet: "Search the web through OpenAI and return a cited answer.",
		promptGuidelines: [
			"Use web_search when current external information or online sources are needed.",
			"Use web_search queries for a small set of meaningfully different research angles instead of repetitive wording.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "One search query. Used when queries is omitted or empty." })),
			queries: Type.Optional(Type.Array(Type.String(), {
				minItems: 1,
				maxItems: MAX_QUERIES,
				description: "Up to eight search queries, run sequentially. Takes precedence over query when non-empty.",
			})),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Preferred number of distinct sources per query." })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"] as const, { description: "Prefer results from this recent period." })),
			domainFilter: Type.Optional(Type.Array(Type.String(), {
				maxItems: 100,
				description: "Allowed domains; prefix a domain with - to block it.",
			})),
		}, { additionalProperties: false }),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const queries = normalizeQueries(params.query, params.queries);
			if (queries.length === 0) throw new Error("web_search requires a non-empty query or queries entry");

			const successes: Array<{ query: string; response: SearchResponse }> = [];
			const failures: Array<{ query: string; error: string }> = [];
			for (const [index, query] of queries.entries()) {
				if (signal?.aborted) throw new Error("OpenAI web search aborted");
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${index + 1}/${queries.length}: ${query}` }],
					details: { phase: "searching", current: index + 1, total: queries.length, query },
				});
				try {
					const response = await searchWithOpenAI(query, {
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						signal,
					}, ctx);
					successes.push({ query, response });
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
					failures.push({ query, error: error instanceof Error ? error.message : String(error) });
				}
			}

			if (successes.length === 0) {
				throw new Error(`OpenAI web search failed:\n${failures.map(item => `- ${item.query}: ${item.error}`).join("\n")}`);
			}

			const sections = successes.map(item => formatResponse(item.query, item.response, queries.length > 1));
			if (failures.length > 0) {
				sections.push(`## Failed queries\n\n${failures.map(item => `- ${item.query}: ${item.error}`).join("\n")}`);
			}
			const output = sections.join("\n\n---\n\n");
			const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let text = truncation.content;
			let fullOutputPath: string | undefined;
			if (truncation.truncated) {
				fullOutputPath = join(tmpdir(), `openai-web-search-${randomUUID()}.md`);
				await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
				temporaryOutputs.add(fullOutputPath);
				text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					queries,
					successfulQueries: successes.length,
					failedQueries: failures.length,
					totalSources: successes.reduce((total, item) => total + item.response.results.length, 0),
					failures: failures.length > 0 ? failures : undefined,
					truncated: truncation.truncated,
					fullOutputPath,
				},
			};
		},
	});
}
