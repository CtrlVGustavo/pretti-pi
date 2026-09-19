import { realpath } from "node:fs/promises";
import { getLanguageFromPath, highlightCode, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CARD_TYPE, boundedDiff, createCard, isCodeCard, locateCard, parseCodeCommand, readSnapshot, safeText, uniqueCardSlug,
	type CodeCard,
} from "./core.ts";
import { openInNeovim, type EditorExit, type EditorTarget } from "./neovim.ts";

const EDIT_TYPE = "pretti-code-edit";

function message(error: unknown): string {
	return safeText(error instanceof Error ? error.message : String(error));
}

function oneLine(text: string): string {
	return safeText(text).replace(/\n/g, " ");
}

function cardReference(card: CodeCard): string {
	return card.slug ?? card.id;
}

function cardDescription(card: CodeCard): string {
	return `${oneLine(card.label)}:${card.line}${card.title ? ` · ${oneLine(card.title)}` : ""}`;
}

export function cardCompletions(cards: readonly CodeCard[], prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	if (query.startsWith("-") && "--last".startsWith(query)) {
		return [{ value: "--last", label: "--last", description: "Open the most recent code card" }];
	}
	const items = cards.toReversed().flatMap((card) => {
		const references = query ? [card.slug, card.id] : [cardReference(card)];
		return references.filter((value): value is string => !!value && value.startsWith(query.replace(/^#/, ""))
			&& (!query.startsWith("#") || value === card.id))
			.map((value) => ({ value, label: value, description: cardDescription(card) }));
	});
	return items.length ? items : null;
}

export function renderCard(card: CodeCard, theme: Theme, highlighter = highlightCode): Component {
	// Persist only plain text. The bounded snapshot is colored on demand, never re-read from disk.
	const plain = card.preview.map((item) => safeText(item.text));
	let highlighted: string[] | undefined;
	const highlight = () => {
		const language = getLanguageFromPath(card.path);
		if (!language) return plain;
		try {
			const lines = highlighter(plain.join("\n"), language);
			if (lines.length !== plain.length) return plain;
			// Reapply styles crossing newlines (e.g. block comments) after the gutter's color reset.
			// A width above the longest source line preserves the original line layout.
			const colored = wrapTextWithAnsi(lines.join("\n"), Math.max(1, ...plain.map(visibleWidth)) + 1);
			return colored.length === plain.length ? colored : plain;
		} catch {
			return plain;
		}
	};
	return {
		render(width) {
			const title = `${cardReference(card)}${card.slug ? ` · ${card.id}` : ""} · ${oneLine(card.label)}:${card.line}`;
			if (width < 4) return [truncateToWidth(title, Math.max(0, width), "")];
			const codeLines = highlighted ??= highlight();
			const inner = width - 4;
			const row = (text: string) => {
				const value = truncateToWidth(text, inner, "…");
				return theme.fg("border", "│ ") + value + " ".repeat(Math.max(0, inner - visibleWidth(value))) + theme.fg("border", " │");
			};
			return [
				theme.fg("border", `┌${"─".repeat(width - 2)}┐`),
				row(theme.fg("accent", title)),
				...(card.title ? [row(oneLine(card.title))] : []),
				...card.preview.map((item, index) => row(
					theme.fg(item.line === card.line ? "accent" : "dim", `${item.line === card.line ? "›" : " "}${String(item.line).padStart(4)} `)
					+ codeLines[index],
				)),
				row(theme.fg("muted", `/code ${cardReference(card)}  ·  Edit in Neovim`)),
				row(theme.fg("dim", "Preview snapshot · opens current file · :wq saves and returns")),
				theme.fg("border", `└${"─".repeat(width - 2)}┘`),
			];
		},
		invalidate() { highlighted = undefined; },
	};
}

function cardsInBranch(ctx: ExtensionContext): CodeCard[] {
	return ctx.sessionManager.getBranch().flatMap((entry) =>
		entry.type === "custom" && entry.customType === CARD_TYPE && isCodeCard(entry.data) ? [entry.data] : []);
}

interface Dependencies {
	openEditor: (ctx: ExtensionContext, target: EditorTarget) => Promise<EditorExit>;
}

/** Injectable terminal handoff keeps command/session tests independent of a real TTY. */
export function createCodeCardsExtension({ openEditor = openInNeovim }: Partial<Dependencies> = {}) {
	return function codeCardsExtension(pi: ExtensionAPI) {
		let opening = false;
		let generation = 0;
		let completionContext: ExtensionContext | undefined;
		pi.on("session_start", (_event, ctx) => { completionContext = ctx; });
		pi.on("session_shutdown", () => { generation++; completionContext = undefined; });
		pi.on("session_tree", (_event, ctx) => { generation++; completionContext = ctx; });

		const persistCard = (card: CodeCard, ctx: ExtensionContext) => {
			card.slug = uniqueCardSlug(card.slug ?? `code-${card.id}`, cardsInBranch(ctx));
			pi.appendEntry(CARD_TYPE, card);
		};

		pi.registerEntryRenderer<CodeCard>(CARD_TYPE, (entry, _options, theme) =>
			isCodeCard(entry.data) ? renderCard(entry.data, theme) : new Text("Invalid code card", 0, 0));
		pi.registerMessageRenderer<{ summary: string; diff?: string }>(EDIT_TYPE, (entry, options, theme) => {
			const summary = entry.details?.summary ?? "Neovim edit";
			const diff = options.expanded ? entry.details?.diff : undefined;
			return new Text(theme.fg("accent", summary) + (diff ? `\n${diff}` : ""), 0, 0);
		});

		pi.registerTool({
			name: "show_code_card",
			label: "Code card",
			description: "Show a persistent, syntax-highlighted source-code preview the user can open in Neovim with /code slug or /code id (no # needed). Supply a short descriptive slug such as index-hash-detect; the returned slug may have a uniqueness suffix. Does not launch an editor, modify files, or wait for editing. Requires interactive TUI mode. Preview is limited to 12 lines of 240 characters; files to 2 MiB UTF-8. Line/column are 1-based (column is a Neovim byte column). Optional anchorText must match uniquely and determines the target line.",
			promptSnippet: "Show code the user can open and edit in Neovim from chat",
			promptGuidelines: [
				"Use show_code_card when the user wants to inspect or manually edit a specific file or code segment. The user must activate the card; show_code_card does not open Neovim or mean they have edited anything.",
				"When calling show_code_card, supply a short, meaningful lowercase hyphenated slug describing the snippet (for example index-hash-detect). Use the returned slug or bare ID in /code commands; do not prefix IDs with #.",
			],
			parameters: Type.Object({
				path: Type.String({ minLength: 1 }),
				slug: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Short descriptive words for /code, e.g. index-hash-detect. Normalized and made unique in this branch; defaults to title or filename and line." })),
				line: Type.Optional(Type.Integer({ minimum: 1 })),
				column: Type.Optional(Type.Integer({ minimum: 1 })),
				endLine: Type.Optional(Type.Integer({ minimum: 1 })),
				anchorText: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
				title: Type.Optional(Type.String({ maxLength: 200 })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				if (ctx.mode !== "tui") throw new Error("Code cards require Pi's interactive TUI. No editor was opened.");
				const current = generation;
				signal?.throwIfAborted();
				const card = await createCard(ctx.cwd, params);
				signal?.throwIfAborted();
				if (current !== generation) throw new Error("The session changed before the card could be created.");
				persistCard(card, ctx);
				return {
					content: [{ type: "text", text: `Code card ${card.slug} (${card.id}): ${oneLine(card.label)}:${card.line}. The user can run /code ${card.slug} or /code ${card.id} to edit in Neovim after Pi is idle. No file changes have been made.` }],
					details: { cardId: card.id, slug: card.slug },
				};
			},
		});

		pi.registerCommand("code", {
			description: "Edit in Neovim: /code slug, /code id, /code path[:line[:column]], /code --last, or /code for a card picker",
			getArgumentCompletions: (prefix) => completionContext?.mode === "tui"
				? cardCompletions(cardsInBranch(completionContext), prefix) : null,
			handler: async (args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/code requires Pi's interactive TUI.", "error");
					return;
				}
				if (opening || !ctx.isIdle()) {
					ctx.ui.notify("Wait for Pi and any current code-card interaction to finish before opening Neovim.", "warning");
					return;
				}
				opening = true;
				const current = generation;
				const active = () => current === generation;
				try {
					const cards = cardsInBranch(ctx);
					const command = parseCodeCommand(args, cards);
					let card: CodeCard | undefined;
					if (command.kind === "file") {
						card = await createCard(ctx.cwd, command.request);
						if (!active()) return;
						persistCard(card, ctx);
					} else {
						if (command.kind === "card") {
							card = cards.find((item) => item.id === command.id);
							if (!card) throw new Error(`Card ${command.id} is not in the current conversation branch.`);
						} else if (command.kind === "last") {
							card = cards.at(-1);
						} else if (cards.length) {
							const latestFirst = cards.toReversed();
							const choices = latestFirst.map((item) => `${cardReference(item)}${item.slug ? ` · ${item.id}` : ""} · ${cardDescription(item)}`);
							const choice = await ctx.ui.select("Edit a code card in Neovim", choices);
							if (!choice || !active()) return;
							card = latestFirst[choices.indexOf(choice)];
						}
						if (!card) throw new Error("No code cards yet. Use /code path/to/file.ts:42, or ask Pi to show a code card.");
					}

					if (await realpath(ctx.cwd) !== card.cwd) throw new Error("This card belongs to a different working directory. Create a new card here instead.");
					if (await realpath(card.path) !== card.realPath) throw new Error("The card's symlink target changed. Create a new card before editing.");
					const before = await readSnapshot(card.path);
					if (!active()) return;
					const location = locateCard(card, before);
					if (location.stale) {
						const confirmed = await ctx.ui.confirm("Code card location changed",
							`The original code is missing or ambiguous in ${oneLine(card.label)}. Open the current file at line ${location.line} instead? No old content will be restored.`);
						if (!confirmed || !active()) return;
					}
					// A picker/confirmation can yield to another extension that starts a turn.
					if (!ctx.isIdle()) throw new Error("Pi started working. Open the card again after it finishes.");
					const exit = await openEditor(ctx, { path: card.path, cwd: card.cwd, line: location.line, column: card.column });
					if (!active()) return;
					if (exit.error || exit.status !== 0) {
						ctx.ui.notify(exit.error ?? `Neovim exited ${exit.signal ? `with signal ${exit.signal}` : `with code ${exit.status}`}. Any writes already saved remain on disk.`, "warning");
					}

					let summary: string;
					let diff: string | undefined;
					try {
						const after = await readSnapshot(card.path);
						if (!active()) return;
						if (before.hash === after.hash) {
							ctx.ui.notify(`Back from Neovim: ${oneLine(card.label)} is unchanged.`, "info");
							return;
						}
						summary = `File changed during Neovim: ${oneLine(card.label)} · reopen with /code ${cardReference(card)}`;
						diff = boundedDiff(card.label, before.text, after.text);
					} catch (error) {
						if (!active()) return;
						summary = `Back from Neovim; could not verify ${oneLine(card.label)}: ${message(error)}. The file may have changed or been deleted; inspect it before continuing.`;
					}
					pi.sendMessage({
						customType: EDIT_TYPE,
						content: `${summary}\nFile: ${JSON.stringify(card.path)}\n${diff ?? ""}\nOnly the opened file was checked; other files edited in Neovim are not tracked by this notification.`,
						display: true, details: { summary, diff },
					}, { triggerTurn: false });
				} catch (error) {
					if (active()) ctx.ui.notify(message(error), "error");
				} finally {
					opening = false;
				}
			},
		});
	};
}

export default createCodeCardsExtension();
