Copies gitignored files such as `.env` into new git worktrees. Add `symlink <path>` to share a live file or directory, such as `node_modules`, with new worktrees. Put `.worktreeinclude` at the root of your main checkout.

```gitignore
# .worktreeinclude
.env
.env.*
config/secrets.json
symlink node_modules
```

Plain lines and `copy <pattern>` use gitignore syntax. Links take one literal relative path, with no wildcards. Both modes require gitignored source paths, leave tracked and existing destinations alone, and stay within the main checkout. Copies use copy-on-write cloning on filesystems that support it, such as APFS and btrfs. Directory links on Windows use junctions; file links need Windows symbolic-link support. Failed links are skipped rather than copied.
Ignore linked directories by name without a trailing slash, such as `node_modules`, so Git also ignores the link in the new worktree.

Requires Paseo 0.10.3 or later and `git` on the daemon's `PATH`. Files are only copied locally on the daemon machine, from the main checkout into the new worktree.

The copy runs when the workspace is created and does not block agent startup. An agent that reads these files immediately may start before the copy finishes. If that matters, use a `worktree.setup` step in `paseo.json` instead.
