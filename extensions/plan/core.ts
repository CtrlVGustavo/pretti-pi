import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isTodoSlug, parseTodoDocument, safeText } from "../todo/core.ts";

export const PLAN_INSTRUCTIONS = "Let's create a plan, no need to implement. I will review and request edits to the plan, ask questions, or ask to implement.";
export const USAGE = "Usage: /plan <request> | /plan --todo <slug> [extra text] | /plan --todo --all [extra text] | /plan -- <request> | /plan --help";
export const PLAN_HELP = `Create a reviewable plan without implementing it.

/plan <request>
  Plan a free-form request. Spaces and newlines need no quotes.

/plan --todo <slug> [extra text]
  Include the task with this exact, case-sensitive slug from the current directory's TODO.md.
  Autocomplete suggests unchecked tasks only; an explicitly typed checked slug is also accepted.
  Optional extra text is appended as additional instructions.

/plan --todo --all [extra text]
  --all selects every unchecked task in file order. It must follow --todo.
  Optional extra text applies to the entire plan.

/plan -- <request>
  -- treats the remaining text literally, even if it starts with a flag.
  Example: /plan -- --todo should support priorities

/plan --help
  Show this help without starting an assistant turn.

A request, slug, or --todo --all is required. Text after a slug or --all is literal, not more flags.
TODO.md is never modified. Plans are sent immediately when idle or queued as follow-ups when busy.
These are planning instructions, not an enforced read-only mode.`;

export type PlanCommand =
	| { kind: "help" }
	| { kind: "request"; text: string }
	| { kind: "todo"; slug: string; extraText: string }
	| { kind: "all"; extraText: string };

export function parsePlanCommand(args: string): PlanCommand {
	const value = args.trim();
	if (!value) throw new Error("Provide a request or use /plan --todo <slug> or /plan --todo --all. See /plan --help.");
	const [, first, rest = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value)!;
	if (first === "--help" && !rest) return { kind: "help" };
	if (first === "--") {
		if (!rest) throw new Error("Provide a request after /plan --. See /plan --help.");
		return { kind: "request", text: rest };
	}
	if (first === "--todo") {
		if (!rest) throw new Error("Provide a todo slug or use /plan --todo --all. See /plan --help.");
		const [, slug, extraText = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)!;
		if (slug === "--all") return { kind: "all", extraText };
		if (!isTodoSlug(slug)) throw new Error(`Invalid todo slug. Use an exact lowercase, hyphen-separated slug or /plan --todo --all. See /plan --help.`);
		return { kind: "todo", slug, extraText };
	}
	if (first.startsWith("--")) throw new Error(`${USAGE}\nSee /plan --help for flag explanations.`);
	return { kind: "request", text: value };
}

export function buildPlanPrompt(command: Exclude<PlanCommand, { kind: "help" }>, source: string | null = null): string {
	if (command.kind === "request") return `${PLAN_INSTRUCTIONS}\n\n${command.text}`;
	if (source === null) throw new Error("TODO.md was not found in the current directory. Add tasks with /todo <text> or use /plan <request>.");
	const { items } = parseTodoDocument(source);
	const selected = command.kind === "all" ? items.filter((item) => !item.done) : items.filter((item) => item.slug === command.slug);
	if (!selected.length) {
		throw new Error(command.kind === "all" ? "No unchecked todo items in TODO.md." : `No item found for slug: ${command.slug}. Use /todo to list unchecked tasks.`);
	}
	const tasks = selected.map((item) => `Todo: ${item.slug}\n${safeText(item.text)}`).join("\n\n");
	const extra = command.extraText ? `\n\nAdditional instructions:\n${command.extraText}` : "";
	return `${PLAN_INSTRUCTIONS}\n\n${tasks}${extra}`;
}

/** Only complete the selector, never the free-form text that follows it. */
export function todoSelectorPrefix(prefix: string): string | null {
	return /^--todo[ \t]+([^\s]*)$/.exec(prefix.trimStart())?.[1] ?? null;
}

export function planCompletions(source: string | null, prefix: string): AutocompleteItem[] | null {
	const selector = todoSelectorPrefix(prefix);
	let suggestions: AutocompleteItem[];
	if (selector !== null) {
		suggestions = source === null ? [] : parseTodoDocument(source).items
			.filter((item) => !item.done && item.slug.startsWith(selector))
			.map((item) => ({ value: `--todo ${item.slug}`, label: item.slug, description: safeText(item.text) }));
		if ("--all".startsWith(selector)) suggestions.push({ value: "--todo --all", label: "--all", description: "Plan all unchecked tasks" });
	} else {
		suggestions = [
			{ value: "--todo ", label: "--todo", description: "Plan a todo slug or --all unchecked tasks" },
			{ value: "--help", label: "--help", description: "Show usage and flag explanations" },
			{ value: "-- ", label: "--", description: "Treat the remaining request as literal text" },
		].filter((item) => item.label.startsWith(prefix.trimStart()));
	}
	return suggestions.length ? suggestions : null;
}
