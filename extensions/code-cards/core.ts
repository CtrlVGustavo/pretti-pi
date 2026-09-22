import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";

export const CARD_TYPE = "pretti-code-card";
export const OPEN_TYPE = "pretti-code-open";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_BYTES = 16 * 1024;
export const MAX_DIFF_LINES = 200;
export const MAX_SLUG_LENGTH = 64;

export interface CodeCard {
	version: 1;
	id: string;
	/** Absent on cards created before readable references were introduced. */
	slug?: string;
	cwd: string;
	path: string;
	realPath: string;
	label: string;
	title: string;
	line: number;
	column: number;
	endLine: number;
	hash: string;
	anchor: string;
	preview: { line: number; text: string }[];
}

export interface Snapshot {
	text: string;
	hash: string;
}

export interface CardRequest {
	path: string;
	slug?: string;
	line?: number;
	column?: number;
	endLine?: number;
	anchorText?: string;
	title?: string;
}

export type CodeCommand = { kind: "picker" | "last" } | { kind: "card"; id: string } | { kind: "file"; request: CardRequest };

export type CodeOpen = { version: 1; kind: "card"; id: string }
	| ({ version: 1; kind: "file" } & Pick<CodeCard, "cwd" | "path" | "realPath" | "line" | "column">);

/** Open history stores only references/positions, never another preview or file contents. */
export function isCodeOpen(value: unknown): value is CodeOpen {
	if (!value || typeof value !== "object") return false;
	const item = value as CodeOpen;
	if (item.version !== 1) return false;
	if (item.kind === "card") return typeof item.id === "string" && /^[a-f0-9]{8}$/.test(item.id);
	return item.kind === "file"
		&& [item.cwd, item.path, item.realPath].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))
		&& positiveInteger(item.line) && positiveInteger(item.column);
}

export function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/** No shell parsing: the entire argument is a path, with optional quotes and :line:column. */
export function parseCodeCommand(args: string, cards: readonly CodeCard[] = []): CodeCommand {
	let input = args.trim();
	if (!input) return { kind: "picker" };
	const fileMode = /^--file(?:\s|$)/.test(input);
	if (fileMode) {
		input = input.slice(6).trim();
		if (!input) throw new Error("Use /code --file <path>[:line[:column]]. Type a query after --file to fuzzy-search files.");
	} else {
		if (input === "--last") return { kind: "last" };
		// Keep legacy #id links working, but all new UI uses bare IDs.
		if (/^#?[a-f0-9]{8}$/i.test(input)) return { kind: "card", id: input.replace(/^#/, "").toLowerCase() };
		const card = cards.find((item) => item.slug === input);
		if (card) return { kind: "card", id: card.id };
	}
	// Explicit paths (./name, quoted paths, or name:line) bypass slug lookup.
	let path: string;
	let suffix: string;
	if (input.startsWith('"') || input.startsWith("'")) {
		const quote = input[0];
		let end = 1;
		path = "";
		for (; end < input.length && input[end] !== quote; end++) {
			// Double quotes allow escaped quotes/backslashes; single quotes stay literal.
			if (quote === '"' && input[end] === "\\" && /["\\]/.test(input[end + 1] ?? "")) end++;
			path += input[end];
		}
		if (end === input.length) throw new Error("Unclosed path quote. Use /code \"path with spaces.ts\":42");
		suffix = input.slice(end + 1);
		if (suffix && !/^:\d+(?::\d+)?$/.test(suffix)) throw new Error("Expected :line or :line:column after the path.");
	} else {
		const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(input);
		path = match ? match[1] : input;
		suffix = match ? input.slice(path.length) : "";
	}
	const [, rawLine, rawColumn] = suffix.split(":");
	const line = rawLine === undefined ? 1 : Number(rawLine);
	const column = rawColumn === undefined ? 1 : Number(rawColumn);
	if (!path || path.includes("\0") || !positiveInteger(line) || !positiveInteger(column)) {
		throw new Error("Use /code <path>[:line[:column]] with positive line and column numbers.");
	}
	return { kind: "file", request: { path, line, column } };
}

/** Round-trippable command argument, not shell escaping. */
export function quoteFilePath(path: string): string {
	const literal = path.startsWith("@") ? `./${path}` : path;
	return /[\s'"\\:]|^~/.test(literal)
		? `"${literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : literal;
}

export function resolveFilePath(cwd: string, path: string): string {
	const withoutAt = path.startsWith("@") ? path.slice(1) : path;
	if (!withoutAt || withoutAt.includes("\0")) throw new Error("A non-empty file path is required.");
	return resolve(cwd, withoutAt.startsWith("~/") ? resolve(homedir(), withoutAt.slice(2)) : withoutAt);
}

/** Bound reads even if the file grows; never wait on a FIFO or read a device. */
export async function readSnapshot(path: string): Promise<Snapshot> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Opening code requires a regular file.");
		if (stat.size > MAX_FILE_BYTES) throw new Error("Opening code supports files up to 2 MiB.");
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw new Error("Opening code supports files up to 2 MiB.");
		const bytes = buffer.subarray(0, length);
		if (bytes.includes(0)) throw new Error("Binary files are not supported.");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new Error("Opening code requires UTF-8 text.");
		}
		return { text, hash: createHash("sha256").update(bytes).digest("hex") };
	} finally {
		await file.close();
	}
}

function normalized(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

export function fileLines(text: string): string[] {
	const lines = normalized(text).split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

/** Display source as inert text, never terminal control sequences. */
export function safeText(text: string): string {
	return text.replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function uniqueAnchorLine(text: string, anchor: string): number | undefined {
	if (!anchor.trim()) return undefined;
	const haystack = normalized(text);
	const index = haystack.indexOf(anchor);
	if (index < 0 || haystack.indexOf(anchor, index + 1) >= 0) return undefined;
	return haystack.slice(0, index).split("\n").length;
}

function normalizeSlug(text: string): string {
	const slug = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
		.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
	// Reserve eight-character hex references for IDs, including future cards.
	return /^[a-f0-9]{8}$/.test(slug) ? `code-${slug}` : slug;
}

/** Run immediately before appendEntry, with no await, so parallel tools cannot reserve the same slug. */
export function uniqueCardSlug(base: string, cards: readonly CodeCard[]): string {
	const used = new Set(cards.flatMap((card) => card.slug ? [card.slug, card.id] : [card.id]));
	let slug = base;
	for (let number = 2; used.has(slug); number++) {
		const suffix = `-${number}`;
		slug = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, "") + suffix;
	}
	return slug;
}

async function prepareFile(cwd: string, requestedPath: string) {
	const canonicalCwd = await realpath(cwd);
	const path = resolveFilePath(canonicalCwd, requestedPath);
	const realPath = await realpath(path);
	const snapshot = await readSnapshot(path);
	return { cwd: canonicalCwd, path, realPath, label: relative(canonicalCwd, path) || path, snapshot };
}

/** Direct opening needs a validated file and position, not a preview or persisted card. */
export async function prepareFileTarget(
	cwd: string, request: Pick<CardRequest, "path" | "line" | "column">, options: { clampLine?: boolean } = {},
) {
	const file = await prepareFile(cwd, request.path);
	let line = request.line ?? 1;
	const column = request.column ?? 1;
	if (!positiveInteger(line) || !positiveInteger(column)) throw new Error("Line and column must be positive integers.");
	const count = fileLines(file.snapshot.text).length;
	if (options.clampLine) line = Math.min(line, count);
	if (line > count) throw new Error(`Line ${line} is beyond the file's ${count} lines.`);
	return { ...file, line, column };
}

export async function createCard(cwd: string, request: CardRequest): Promise<CodeCard> {
	const { cwd: canonicalCwd, path, realPath, label, snapshot } = await prepareFile(cwd, request.path);
	const lines = fileLines(snapshot.text);
	let line = request.line ?? 1;
	const column = request.column ?? 1;
	if (!positiveInteger(line) || !positiveInteger(column)) throw new Error("Line and column must be positive integers.");
	let anchor = request.anchorText === undefined ? undefined : normalized(request.anchorText);
	if (anchor !== undefined) {
		if (!anchor.trim() || anchor.length > 4096) throw new Error("anchorText must contain 1–4096 characters of code.");
		const anchorLine = uniqueAnchorLine(snapshot.text, anchor);
		if (anchorLine === undefined) throw new Error("anchorText must match exactly once in the current file.");
		line = anchorLine;
	}
	if (line > lines.length) throw new Error(`Line ${line} is beyond the file's ${lines.length} lines.`);
	const endLine = request.endLine ?? Math.min(line + 8, lines.length);
	if (!positiveInteger(endLine) || endLine < line || endLine > lines.length) throw new Error("endLine must be within the file and at or after the target line.");
	anchor ??= lines.slice(line - 1, Math.min(line + 2, endLine)).join("\n").slice(0, 4096);
	const previewStart = Math.max(1, line - 2);
	return {
		version: 1, id: randomBytes(4).toString("hex"), cwd: canonicalCwd, path, realPath,
		slug: normalizeSlug(request.slug ?? "") || normalizeSlug(request.title ?? "")
			|| normalizeSlug(`${basename(path, extname(path))}-${line}`),
		label, title: (request.title ?? "").slice(0, 200), line, column, endLine,
		hash: snapshot.hash, anchor,
		preview: lines.slice(previewStart - 1, Math.min(endLine, previewStart + 11)).map((text, index) => ({
			line: previewStart + index, text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
		})),
	};
}

/** Validate restored entries before using them to launch a process. */
export function isCodeCard(value: unknown): value is CodeCard {
	if (!value || typeof value !== "object") return false;
	const c = value as CodeCard;
	return c.version === 1 && typeof c.id === "string" && /^[a-f0-9]{8}$/.test(c.id)
		&& (c.slug === undefined || (typeof c.slug === "string" && c.slug.length <= MAX_SLUG_LENGTH
			&& /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.slug) && !/^[a-f0-9]{8}$/.test(c.slug)))
		&& [c.cwd, c.path, c.realPath].every((path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"))
		&& typeof c.label === "string" && typeof c.title === "string" && c.title.length <= 200
		&& positiveInteger(c.line) && positiveInteger(c.column) && positiveInteger(c.endLine) && c.endLine >= c.line
		&& typeof c.hash === "string" && /^[a-f0-9]{64}$/.test(c.hash)
		&& typeof c.anchor === "string" && c.anchor.length <= 4096
		&& Array.isArray(c.preview) && c.preview.length <= 12
		&& c.preview.every((row) => row && positiveInteger(row.line) && typeof row.text === "string" && row.text.length <= 241);
}

export function locateCard(card: CodeCard, snapshot: Snapshot): { line: number; stale: boolean } {
	if (card.hash === snapshot.hash) return { line: card.line, stale: false };
	const line = uniqueAnchorLine(snapshot.text, card.anchor);
	return line === undefined
		? { line: Math.min(card.line, fileLines(snapshot.text).length), stale: true }
		: { line, stale: false };
}

export function boundedDiff(label: string, before: string, after: string): string {
	const patch = createTwoFilesPatch(label, label, before, after, "before Neovim", "after Neovim", {
		context: 3, timeout: 1000, maxEditLength: 10000,
	});
	if (patch === undefined) return "Diff omitted: computation limit reached. Re-read the file for current contents.";
	const lines = safeText(patch).split("\n");
	const output: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line) + 1;
		if (output.length >= MAX_DIFF_LINES || bytes + size > MAX_DIFF_BYTES - 200) {
			output.push("[Diff truncated at 200 lines / 16 KiB. Re-read the file for complete contents.]");
			break;
		}
		output.push(line);
		bytes += size;
	}
	return output.join("\n");
}
