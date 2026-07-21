# Files tab and Markdown editor

The Files tab provides a repository/workspace file tree and a safe text-editing surface for Markdown-like files. It is intentionally simpler than a full IDE.

## Supported editing flow

Files ending in `.md`, `.mdx`, `.markdown`, or `.txt` can be opened in a plain source editor with an Edit/Preview toggle. Preview uses GitHub-flavored Markdown rendering consistent with chat rendering.

Changes are not autosaved. Use **Save** explicitly.

## Safety behavior

- Files loaded in truncated form are read-only.
- Editing and saving a truncated file are blocked in both the client store and UI.
- Unsaved changes are guarded when closing, refreshing, or switching files.
- A save error leaves the editor state visible so the user can copy or retry the content.
- Manual Refresh deliberately reloads server content; resolve or preserve unsaved work first.
- Server-side path validation and authentication remain authoritative even if the UI shows a file.

The truncation rule prevents a partial preview from overwriting the full file.

## Expected workflow

1. Open the Files tab.
2. Select a supported text file.
3. Confirm whether the file is complete or marked truncated/read-only.
4. Choose Edit.
5. Make the change.
6. Use Preview to inspect rendered Markdown when useful.
7. Save explicitly.
8. Confirm the success state before switching files.

## What the Files tab is not

- not a multi-file transactional editor;
- not a replacement for Git review;
- not a binary-file editor;
- not a way to bypass workspace/path restrictions;
- not an autosaving collaborative document surface.

For substantial code changes, use the normal repository workflow and inspect the Git diff.

## Troubleshooting

| Symptom | Likely explanation |
|---|---|
| Edit button unavailable | file type unsupported or file loaded truncated |
| Save unavailable | no writable complete source is loaded, or no change exists |
| Warning on file switch | current file has unsaved edits |
| Preview differs from another renderer | GitHub-flavored Markdown and sanitization/rendering differences |
| Save returns an error | server auth/path/write validation or filesystem failure |
| File changed outside the UI | use Refresh after preserving local edits |

Maintainers should start from `client/src/store/filesStore.ts`, `client/src/components/Files/MarkdownEditor.tsx`, `client/src/components/Files/FilesTab.tsx`, and the `/api/files/*` server routes.