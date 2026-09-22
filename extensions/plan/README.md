# Plan command

`/plan` sends the original planning instructions followed by a request or tasks from `<ctx.cwd>/TODO.md`. It submits the expanded prompt as one user message; it does not leave a draft in the editor. When the agent is busy, it queues a follow-up rather than interrupting the current work.

## Usage and flags

| Command | Action |
| --- | --- |
| `/plan <request>` | Ask for a reviewable plan without implementation. Spaces and newlines need no quotes. |
| `/plan --todo <slug> [extra text]` | Include the exact, case-sensitive task slug and its task text, followed by optional additional instructions. |
| `/plan --todo --all [extra text]` | Include **all unchecked tasks**, in file order. `--all` is only valid after `--todo`; optional extra text applies to the whole plan. |
| `/plan -- <request>` | Treat the remaining request literally, even when it begins with a flag. |
| `/plan --help` | Explain usage and every flag locally, without starting an assistant turn or reading TODO.md. |

Examples:

```text
/plan Add a settings screen.
/plan --todo fix-login-redirect
/plan --todo fix-login-redirect Focus on regression tests.
/plan --todo --all Group related tasks into milestones.
/plan -- --todo should support priorities
/plan --help
```

A bare `/plan`, `/plan --todo` without a selector, or `/plan --` without a request produces an actionable error, not a model turn. Unknown flags, invalid slugs, and extra arguments to `--help` are rejected. Everything after a task slug or `--all` is literal additional text, not more flags. Quotes are preserved as text, not interpreted as shell quoting.

Interactive TUI and RPC modes are supported; help and errors use UI notifications. Print and JSON modes are not supported. Autocomplete is TUI-only.

## Prompt format

The planning instructions are unchanged:

```text
Let's create a plan, no need to implement. I will review and request edits to the plan, ask questions, or ask to implement.
```

Plain requests follow these instructions after a blank line. TODO requests add one block per selected task:

```text
Todo: fix-login-redirect
Fix login redirect
```

When provided, extra text is appended once under `Additional instructions:`. Checkbox syntax and hidden slug metadata are omitted. File-sourced terminal controls are stripped.

This is a planning request, **not an enforced read-only mode**: the command does not disable tools or prevent subsequent implementation requests.

## TODO lookup and autocomplete

- Only the current directory's `TODO.md` is used. There is no parent-directory search or session-history fallback.
- The command and completion are read-only: neither creates, annotates, checks, nor otherwise modifies TODO.md.
- Lookup reuses the [todo parser](../todo/README.md), including code-fence handling, existing stable slugs, and provisional slugs for tasks without metadata. Provisional slugs can change after manual file edits; `/todo` persists missing slug comments.
- A single task includes its checkbox-line text, not adjacent notes or child tasks. `--all` includes every unchecked task line independently, including indented tasks.
- An explicitly typed checked task slug is accepted. **Autocomplete and `--all` exclude checked tasks.**
- After `/plan --todo `, autocomplete offers unchecked slugs with descriptions and `--all`. Typed prefixes narrow suggestions; completion stops after the selector when entering additional text.
- Completion reads fresh contents and never executes the command. Execution reads the file again, so edits between completion and submission are reflected.
- Missing files, unknown slugs, no unchecked tasks for `--all`, malformed or duplicate slug metadata, and read failures produce errors without starting an assistant turn. Completion-time errors are silent.
- The shared reader requires a regular UTF-8 file up to 2 MiB. Session changes discard pending reads rather than submitting an old task into a new session.

## Development

```sh
npm run test:plan
npm run typecheck:plan
npm run test:todo
npm run typecheck:todo
```

The package's existing extension discovery loads `plan/index.ts`. The old `prompts/plan.md` template has been removed to avoid duplicate registration. Use `/reload` after updating the package.
