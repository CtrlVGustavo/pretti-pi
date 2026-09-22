# Todo command

`/todo` manages `<ctx.cwd>/TODO.md`. It never searches parent directories, reads todo state from session history, or starts a model turn. Interactive output is a durable, display-only session entry; the file remains authoritative. RPC mode uses notifications. Print and JSON modes are not supported.

## Commands

| Command | Action |
| --- | --- |
| `/todo` | List unchecked tasks. |
| `/todo --unchecked` | List unchecked tasks. |
| `/todo --all` | List every task, in file order. |
| `/todo <text>` | Append one unchecked task and print its slug. Quotes are unnecessary and are treated as literal text. |
| `/todo --check <slug>` | Check an exact, case-sensitive slug. An already checked task is a no-op. |
| `/todo --cleardone` | Remove checked task lines. |
| `/todo -- <text>` | Add text beginning with `--`. |

Unknown flags, conflicting flags, extra flag arguments, missing check slugs, multiline task text, and reserved `<!-- todo:... -->` metadata in new task text are rejected before touching the file.

Missing files are created with a `# TODO` heading. Listing prints only `TODO.md is empty.` Adding creates the task immediately. Checking in a missing file reports that it is empty and the slug was not found. Clearing a missing file reports no checked items to remove.

## Slugs and completion

```markdown
- [ ] Fix login redirect <!-- todo:fix-login-redirect -->
- [x] Add docs <!-- todo:add-docs -->
```

New slugs use at most **three distinct keywords from the task text**, in their original order. Generation is a deterministic local heuristic, not semantic summarization: normalize accents and lowercase ASCII words, skip a small English filler list (including `a`, `the`, `to`, `for`, `please`, and `kindly`), remove repeated words, and take the first three remaining words. Words are joined with hyphens; text with no remaining usable words falls back to `todo`. Generated bases retain the 80-character cap.

Examples:
- `Fix the login redirect after logout` → `fix-login-redirect`
- `Add support for keyboard navigation` → `add-support-keyboard`
- `Please update the installation documentation` → `update-installation-documentation`

Collisions receive numeric suffixes (`-2`, `-3`, …), which do not count toward the three-word limit. Both checked and unchecked tasks currently in the file reserve their slugs. Removed slugs can be reused.

Existing tasks without metadata receive persistent slug comments on first successful use, including listing. Explicit slugs are reserved before missing ones are generated. Existing stored slugs, including older slugs longer than three words, are preserved and remain valid references. Manually editing task text does not change stored slugs. Duplicate or malformed slug metadata is an error: repair the file manually rather than allowing an ambiguous check or silent renaming. A failed slug lookup and an already checked lookup do not annotate other tasks.

Flag completion suggests `--all`, `--unchecked`, `--check`, and `--cleardone`. After `--check `, completion suggests unchecked slugs with task descriptions and filters by the typed prefix. It reads the current file each time, so manual edits and checks are reflected without reload. Completion never creates or writes the file; untagged tasks use the same provisional slugs that command execution will persist. If the file changes between completion and execution, the command operates on the current file.

## Markdown preservation

This is a line-based task list, not a full Markdown document editor:

- Recognizes `-`, `*`, `+`, and numbered list markers followed by `[ ]`, `[x]`, or `[X]`, including indented task lines.
- Ignores task examples inside backtick and tilde code fences. Adding is refused when the file ends inside an unclosed fence.
- Preserves headings, notes, task ordering, indentation, and existing line endings. New tasks use the file's first line-ending style, or LF for an empty file.
- Appends tasks at the end of the file. Each added task is a single line.
- Checking changes only the selected checkbox, apart from annotating any missing slugs.
- **Clearing removes only checked checkbox lines**, not their following notes, continuation lines, or unchecked child tasks. This intentionally avoids deleting unrelated content. It does not renumber ordered lists or reindent children.
- Indented task lines are treated as tasks, not Markdown indented code. Use fenced blocks for examples. Blockquoted tasks and multiline task bodies are not interpreted as complete Markdown structures.

Files must be regular UTF-8 files up to 2 MiB. Read, write, and metadata failures are reported without replacing the file with an empty list. Terminal control characters from file contents are stripped from display output.

The complete read-modify-write window uses Pi's shared per-file mutation queue, coordinating with built-in edit/write tools in the same process. An additional reread catches external changes before writing, but this is not a cross-process lock; avoid simultaneous writes from separate Pi processes or editors.

## Development

```sh
npm run test:todo
npm run typecheck:todo
```

The package's existing `./extensions` discovery loads `todo/index.ts`; no extra registration is needed. Reload Pi after updating the extension.
