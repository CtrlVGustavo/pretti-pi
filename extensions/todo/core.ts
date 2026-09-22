import { readFile, stat } from "node:fs/promises";

export const TODO_ENTRY_TYPE = "pretti-todo-output";
export const EMPTY_TODO = "# TODO\n\n";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const USAGE = "Usage: /todo [--all | --unchecked | --cleardone | --check <slug> | <text> | -- <text>]";

export type TodoCommand =
	| { kind: "list"; all: boolean }
	| { kind: "add"; text: string }
	| { kind: "check"; slug: string }
	| { kind: "cleardone" };

export interface TodoItem {
	line: number;
	checkbox: number;
	done: boolean;
	text: string;
	slug: string;
}

interface Line { text: string; ending: string }
export interface TodoDocument { bom: string; lines: Line[]; items: TodoItem[]; newline: string; openFence: boolean }
export interface TodoResult { content: string; output: string; error?: boolean }

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A small English filler list, not semantic summarization; keep task-specific verbs and nouns.
const SLUG_FILLER_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "for", "from",
	"in", "into", "is", "it", "kindly", "of", "on", "or", "please", "that", "the",
	"these", "this", "those", "to", "was", "were", "with",
]);
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;

/** File text is untrusted terminal input; never render its escape sequences. */
export function safeText(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}

export function parseTodoCommand(args: string): TodoCommand {
	const value = args.trim();
	if (!value || value === "--unchecked") return { kind: "list", all: false };
	if (value === "--all") return { kind: "list", all: true };
	if (value === "--cleardone") return { kind: "cleardone" };
	const check = /^--check\s+(\S+)$/.exec(value);
	if (check && SLUG.test(check[1])) return { kind: "check", slug: check[1] };
	const literal = /^--\s+([\s\S]+)$/.exec(value);
	if (!literal && value.startsWith("--")) throw new Error(USAGE);
	const text = (literal?.[1] ?? value).trim();
	if (!text || CONTROLS.test(text)) throw new Error(`Todo text must be a non-empty single line. ${USAGE}`);
	if (/<!--\s*todo:/i.test(text)) throw new Error("Todo text cannot contain reserved <!-- todo:... --> metadata.");
	return { kind: "add", text };
}

export function uniqueSlug(text: string, used: ReadonlySet<string>): string {
	const words = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const keywords = [...new Set(words.filter((word) => !SLUG_FILLER_WORDS.has(word)))].slice(0, 3);
	const base = keywords.join("-").slice(0, 80).replace(/-$/, "") || "todo";
	let slug = base;
	for (let suffix = 2; used.has(slug); suffix++) slug = `${base}-${suffix}`;
	return slug;
}

/** Line-based task lists: retain all non-task lines verbatim, including code fences. */
export function parseTodoDocument(source: string): TodoDocument {
	const bom = source.startsWith("\ufeff") ? "\ufeff" : "";
	const lines: Line[] = Array.from(source.slice(bom.length).matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g))
		.filter((match) => match[0].length > 0)
		.map((match) => ({ text: match[1], ending: match[2] }));
	const items: TodoItem[] = [];
	const used = new Set<string>();
	let fence: { char: string; length: number } | undefined;
	for (const [line, record] of lines.entries()) {
		const fenceMatch = /^[\uFEFF \t]*(`{3,}|~{3,})(.*)$/.exec(record.text);
		if (fence) {
			if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = undefined;
			continue;
		}
		if (fenceMatch && (fenceMatch[1][0] !== "`" || !fenceMatch[2].includes("`"))) {
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
			continue;
		}
		const task = /^(\uFEFF?[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+)(.*)$/.exec(record.text);
		if (!task) continue;
		const metadata = /[ \t]*<!--\s*todo:([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->[ \t]*$/.exec(task[4]);
		const markers = task[4].match(/<!--\s*todo:/gi) ?? [];
		if (markers.length && (!metadata || markers.length !== 1)) throw new Error(`Invalid todo slug metadata on line ${line + 1}.`);
		const slug = metadata?.[1] ?? "";
		if (slug && used.has(slug)) throw new Error(`Duplicate todo slug: ${slug}. Fix TODO.md before continuing.`);
		if (slug) used.add(slug);
		items.push({ line, checkbox: task[1].length, done: task[2] !== " ", text: task[4].slice(0, metadata?.index).trim(), slug });
	}
	// Reserve every explicit slug first, including those later in the file.
	for (const item of items) {
		if (item.slug) continue;
		item.slug = uniqueSlug(item.text, used);
		used.add(item.slug);
		const record = lines[item.line];
		const trailing = /[ \t]*$/.exec(record.text)![0];
		record.text = record.text.slice(0, record.text.length - trailing.length) + ` <!-- todo:${item.slug} -->` + trailing;
	}
	return { bom, lines, items, newline: lines.find((line) => line.ending)?.ending ?? "\n", openFence: !!fence };
}

function serialize(lines: Line[]): string {
	return lines.map((line) => line.text + line.ending).join("");
}

export function transformTodo(source: string, command: TodoCommand): TodoResult {
	const document = parseTodoDocument(source);
	const { items, lines, newline } = document;
	let output: string;
	switch (command.kind) {
		case "list": {
			const selected = items.filter((item) => command.all || !item.done);
			output = !items.length ? "TODO.md is empty." : !selected.length ? "No unchecked items."
				: `TODO.md${command.all ? " — all items" : " — unchecked items"}\n` + selected.map((item) =>
					`[${item.done ? "x" : " "}] ${item.slug} — ${item.text}`).join("\n");
			break;
		}
		case "add": {
			if (document.openFence) throw new Error("TODO.md has an unclosed code fence. Close it before adding an item.");
			const slug = uniqueSlug(command.text, new Set(items.map((item) => item.slug)));
			const last = lines.at(-1);
			if (last && !last.ending) last.ending = newline;
			lines.push({ text: `- [ ] ${command.text} <!-- todo:${slug} -->`, ending: newline });
			output = `Added ${slug} — ${command.text}`;
			break;
		}
		case "check": {
			const item = items.find((item) => item.slug === command.slug);
			if (!item) return { content: source, output: `${items.length ? "" : "TODO.md is empty. "}No item found for slug: ${command.slug}.`, error: true };
			if (item.done) return { content: source, output: `Already checked: ${item.slug}.` };
			const record = lines[item.line];
			record.text = record.text.slice(0, item.checkbox) + "x" + record.text.slice(item.checkbox + 1);
			output = `Checked ${item.slug} — ${item.text}`;
			break;
		}
		case "cleardone": {
			const removed = new Set(items.filter((item) => item.done).map((item) => item.line));
			return {
				content: document.bom + serialize(lines.filter((_line, index) => !removed.has(index))),
				output: removed.size ? `Removed ${removed.size} checked item${removed.size === 1 ? "" : "s"}.` : "No checked items to remove.",
			};
		}
	}
	return { content: document.bom + serialize(lines), output };
}

/** Return null only for a missing file, not for permissions or invalid contents. */
export async function readTodoFile(path: string): Promise<string | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error("TODO.md must be a regular file.");
		if (info.size > MAX_FILE_BYTES) throw new Error("TODO.md exceeds the 2 MiB size limit.");
		const data = await readFile(path);
		if (data.length > MAX_FILE_BYTES) throw new Error("TODO.md exceeds the 2 MiB size limit.");
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function todoCompletions(source: string | null, prefix: string) {
	const value = prefix.trimStart();
	const check = /^--check[ \t]+([^\s]*)$/.exec(value);
	if (check) {
		if (source === null) return null;
		const suggestions = parseTodoDocument(source).items
			.filter((item) => !item.done && item.slug.startsWith(check[1]))
			.map((item) => ({ value: `--check ${item.slug}`, label: item.slug, description: safeText(item.text) }));
		return suggestions.length ? suggestions : null;
	}
	const flags = ["--all", "--unchecked", "--check", "--cleardone"];
	const suggestions = flags.filter((flag) => flag.startsWith(value))
		.map((flag) => ({ value: flag === "--check" ? `${flag} ` : flag, label: flag }));
	return suggestions.length ? suggestions : null;
}
