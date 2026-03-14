# Phase 3: Testing & Documentation Review

## Test Coverage Findings

### Critical

1. **No test infrastructure exists** -- Zero test files, no framework, no CI test pipeline. DEVELOPMENT_NOTES acknowledges "Basic functionality verified" manually only. For a security-critical tool managing containers, SSH keys, and running `--dangerously-skip-permissions`, this is a significant gap.

2. **Input validation functions untested** -- `validate_dir_path()` and its 6 helper predicates (`has_path_traversal`, `is_absolute_path`, `is_critical_system_dir`, `is_system_dir`, `is_duplicate_dir`, `expand_tilde`) are the primary defense against path traversal and have zero test coverage.

3. **Command injection in admin shell mode untested** -- The `${args[*]}` injection in `build_container_cmd()` line 382 has no regression test. The non-admin path's `printf '%q'` escaping also untested.

### High

4. **Container runtime detection untested** -- `detect_runtime()` and `check_runtime()` are critical path functions with Docker-preferred-over-Podman logic and no tests.

5. **Hash-based rebuild detection untested** -- `needs_rebuild()` with the `date -d` GNU portability bug has no test to catch cross-platform failures.

6. **Port validation weak and untested** -- `build_port_args()` accepts port 0, port 99999, any integer. No range validation.

7. **Argument parsing (16 cases) untested** -- The `main()` while/case loop handles `-h`, `--rebuild`, `-p`, `--add-dir`, `--tool`, `--ignore-dot-env`, `shell`, `ssh-init`, and catch-all, all without tests.

### Medium

8. **`.env` file loading and extra hosts parsing untested** -- `build_env_file_args()` and `build_extra_host_args()` handle security-sensitive env loading with no coverage.

9. **Symlink target mounting untested** -- `mount_symlink_targets()` adds dynamic bind mounts with no tests for edge cases (broken symlinks, recursive, internal targets).

10. **Entrypoint untested** -- 11 responsibilities including `sudo mkdir`, SSH permission fixing, and curl-pipe-bash, all without tests.

11. **Concurrent session safety untested** -- Shared `~/.claude`, cache dirs, and SSH mounts across concurrent containers never stress-tested.

12. **No ShellCheck/static analysis in CI** -- No linting for any Bash scripts.

### Low

13. **`parallel-claude.sh` untested** -- Uses destructive `git branch -D` in cleanup with no tests.

### Recommendations

- Adopt bats-core with bats-assert/bats-support
- Target ~80-95 tests: 40-50 unit, 15-20 integration, 10-15 security, 5-10 E2E
- Extract functions into sourceable library for testability (avoid triggering `main()` on source)
- Add ShellCheck to CI
- Add CI workflow running tests on push/PR

## Documentation Findings

### Critical

1. **OpenCode listed as "pre-installed" but removed from Dockerfile** -- README lines 40, 110 claim OpenCode is built-in. The Dockerfile no longer installs it. Users running `agentbox --tool opencode` will get a runtime error.

2. **README cache paths use wrong identifier** -- README shows `~/.cache/agentbox/agentbox-<hash>/` but code uses `~/.cache/agentbox/<project_id>/` (bare 12-char hash, no `agentbox-` prefix).

### High

3. **DEVELOPMENT_NOTES: admin mode claim wrong** (line 155) -- Says `--admin` doesn't grant sudo. Dockerfile line 81 grants passwordless sudo. It works.

4. **DEVELOPMENT_NOTES: "multi-stage build" claim wrong** (line 29) -- Single `FROM debian:trixie`, no multi-stage.

5. **DEVELOPMENT_NOTES: entrypoint described as "minimal"** (line 30) -- Has 11 responsibilities including curl-pipe-bash, SDK sourcing, SSH permissions, etc.

6. **DEVELOPMENT_NOTES: function list stale** (lines 134-143) -- Lists 9 functions, missing 13+ new functions from refactoring. `mount_additional_dirs` description wrong (says "intuitive folder names" but code uses full host paths).

### Medium

7. **Languages list incomplete** -- README lists Python/Node/Java/Shell. Uncommitted Dockerfile adds Rust, Go, Lua, C/C++.

8. **`date -d` macOS portability undocumented** -- 48-hour rebuild silently fails on macOS. No mention in known limitations.

9. **`.env` security implications undocumented** -- All `.env` variables exposed to container processes. `--ignore-dot-env` flag not mentioned in README.

10. **`--ignore-dot-env` flag missing from README** -- Documented in `--help` but not in README.

11. **Symlink target mounting undocumented** -- Non-obvious feature that dynamically adds bind mounts for `~/.claude` symlinks.

12. **Container naming pattern stale** -- DEVELOPMENT_NOTES says `agentbox-<hash>`, code now uses `agentbox-<hash>-<random>` for concurrent sessions.

### Low

13. **`readlink -f` macOS portability undocumented**
14. **HOST_HOME symlink purpose undocumented**
15. **Mount points list incomplete** -- Missing `/tmp/host_direnv_allow`, `/tmp/host_gitconfig`, symlink target mounts
16. **Claude Code auto-update on startup undocumented**
17. **`parallel-claude.sh` undocumented**
18. **UID/GID description internally inconsistent** -- Claims UID/GID matching minimizes issues, then says ZSH history has UID mismatch
