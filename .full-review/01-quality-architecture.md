# Phase 1: Code Quality & Architecture Review

## Code Quality Findings

### High

1. **Command injection via admin shell args** (`agentbox:382`) -- `${args[*]}` interpolated into `bash -c` string without escaping. Shell metacharacters in user args are interpreted. The non-shell path already uses `printf '%q'` escaping; admin shell should too.

2. **`date -d` not portable to macOS** (`agentbox:112`) -- GNU-only flag. On macOS, the 48-hour rebuild check silently becomes a no-op (always returns 0, meaning every invocation rebuilds). The `|| echo 0` fallback masks the failure.

### Medium

3. **Claude Code updated via curl-pipe-bash on every container start** (`entrypoint.sh:63`) -- Adds startup latency, security surface, and is redundant with the 48-hour image rebuild cycle.

4. **Path traversal regex too permissive** (`agentbox:165`) -- `[[ "$path" =~ \.\. ]]` matches legitimate dir names like `my..project`. Should match actual traversal segments: `(^|/)\.\.(/|$)`.

5. **`build_mount_opts()` is 76 lines** (`agentbox:295-370`) -- Largest function post-refactoring. Handles project mounts, git, SSH, caches, history, tool config, and direnv. Could extract `mount_cache_dirs()` and `mount_tool_config()`.

6. **`main()` is 119 lines** (`agentbox:610-728`) -- Argument parsing alone is 60+ lines. Could extract `parse_args()`.

### Low

7. **`readlink -f` not available on stock macOS** (`agentbox:18`) -- Same GNU coreutils dependency as `date -d`. Script fails immediately on macOS without coreutils.

8. **`eval $(resize)` in entrypoint** (`entrypoint.sh:69`) -- Minor risk from eval on external command output. Could use `stty size` directly.

9. **Hostname can contain invalid chars** (`agentbox:511`) -- `PROJECT_NAME` from `basename` may contain spaces, parens, etc. Docker will reject invalid hostnames with an unhelpful error.

10. **`xargs` for whitespace trimming without `--` guard** (`agentbox:445`) -- Special chars in AGENTBOX_EXTRA_HOSTS entries could be mangled.

11. **Hardcoded version label `1.0.0`** (`agentbox:143`) -- Used only for prune filter. Could be renamed to `agentbox.managed=true` for clarity.

12. **Missing extra hosts format validation** (`agentbox:428-451`) -- Malformed entries passed directly to `--add-host`, causing unhelpful docker errors.

13. **`entrypoint.sh` uses `set -e` without `set -o pipefail`** (`entrypoint.sh:4`) -- Inconsistent with main script's `set -euo pipefail`.

14. **Python venv creation lacks error handling** (`entrypoint.sh:22-28`) -- `uv venv` failure kills entire entrypoint under `set -e`.

## Architecture Findings

### High

1. **Two competing update mechanisms** (`entrypoint.sh:63`, `Dockerfile:237`) -- Build-time install + 48-hour rebuild provides known-good versions. Runtime curl-pipe-bash adds non-deterministic updates, network latency, and supply chain attack surface on every startup.

2. **README cache path docs stale after project_id refactor** -- README references `<container-name>` in cache paths, but code now uses `project_id` (stable 12-char hash). Documentation mismatch will confuse filesystem inspection.

### Medium

3. **Entrypoint scope creep** (`entrypoint.sh`) -- DEVELOPMENT_NOTES says "Minimal - only sets PATH and creates Python venvs." Actual implementation has 11 distinct responsibilities.

4. **Symlink prefix comparison missing trailing slash** (`agentbox:266`) -- `"$target" != "$dir_realpath"*` would incorrectly match `/home/agent/.clauderc` as inside `/home/agent/.claude`. Needs `"$dir_realpath/"*`.

5. **SSH keys mounted read-write** (`agentbox:314`) -- Container can modify host SSH keys. Could split: keys read-only, `known_hosts` read-write.

6. **Growing Dockerfile contradicts simplicity philosophy** -- Adding Go, Rust, Lua, C/C++ grows the ~2GB image further. Design tension worth documenting as explicit choice.

### Low

7. **Missing `--version` CLI flag** -- Hardcoded `agentbox.version=1.0.0` label exists but no CLI flag to query it.

8. **Admin mode docs stale** (`DEVELOPMENT_NOTES.md`) -- Says admin mode doesn't grant sudo, but Dockerfile line 81 grants passwordless sudo. It actually works.

## Critical Issues for Phase 2 Context

- **Supply chain risk**: curl-pipe-bash on every container startup (`entrypoint.sh:63`) -- security review should assess this
- **Command injection**: Admin shell args not escaped (`agentbox:382`) -- security review should assess blast radius
- **SSH read-write mount**: Container has write access to SSH keys -- security review should assess
- **No startup performance budget**: Runtime update adds 2-5s latency per invocation -- performance review should assess
