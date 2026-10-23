# paseo-worktreeinclude

A [Paseo](https://paseo.sh) plugin that copies gitignored files listed in `.worktreeinclude` into new git worktrees. Add `symlink <path>` to share a live file or directory instead.

When a workspace is created in a linked git worktree, the plugin reads `.worktreeinclude` from the main checkout. Plain lines and `copy <pattern>` use gitignore syntax and copy matching files that are also gitignored. `symlink <path>` takes a literal relative path to one gitignored file or directory; wildcards are not supported for links. Tracked files are never touched, and existing destinations are not overwritten. Links point to the live source, so edits in either checkout affect the same file. Copies use copy-on-write cloning (APFS, btrfs) when available.

Link paths must stay inside the main checkout. Invalid, missing, tracked, and non-ignored paths are skipped. Directory links on Windows use junctions; file links require Windows symbolic-link support. A link that cannot be created is skipped rather than copied.
For a linked directory, ignore its name without a trailing slash (`node_modules`, not `node_modules/`) so Git also ignores the link in the new worktree.

```gitignore
# .worktreeinclude
.env
.env.*
config/secrets.json
symlink node_modules
```

## Install

Requires Paseo 0.10.3 or later.

```bash
paseo plugin install npm:@cprecioso/paseo-worktreeinclude
```

Or from GitHub:

```bash
paseo plugin install github:cprecioso/paseo-worktreeinclude
```

## Caveat

The copy runs on Paseo's `workspace.created` event, which does not block agent startup. An agent that reads these files immediately may race the copy. If that matters, use a `worktree.setup` step in `paseo.json` instead.
