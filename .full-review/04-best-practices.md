# Phase 4: Best Practices & Standards

## Framework & Language Findings

### High

1. **Command injection in admin shell** (`agentbox:382`) -- `${args[*]}` in `bash -c` string. Fix: use `"$@"` passthrough: `cmd_ref=(bash -c "echo '...' && exec \"\$@\"" -- "${args[@]}")`.

2. **Duplicate Java + Gradle installs (~500MB waste)** -- apt installs `default-jdk` + `gradle`, then SDKMAN installs Java 21 + Gradle again. Remove apt packages, keep SDKMAN.

3. **curl-pipe-bash on every container startup** (`entrypoint.sh:63`) -- Redundant with build-time install and 48-hour rebuild.

### Medium

4. **`local var=$(cmd)` masks exit codes** -- Used on 14 lines. `local` always returns 0. Should split: `local var; var=$(cmd)`. The script already does this correctly in some places (lines 59, 220, 258), making the inconsistency visible.

5. **oh-my-zsh install overwrites prior `.zshrc` appends** -- Lines 91, 99-100, 105 append cargo env and GOPATH to `.zshrc` BEFORE oh-my-zsh install (line 165) which replaces `.zshrc`. Those entries are lost. Only partially compensated by re-adds on lines 167-170.

6. **Missing `.dockerignore`** -- Build context includes `.git/`, `media/`, `.full-review/`, docs, LICENSE. Inflates every build context transfer.

7. **Unpinned base image** (`debian:trixie`) -- Rolling release, builds not reproducible. Should pin to digest or dated tag.

8. **`sha256sum` unavailable on macOS** (`agentbox:70,78`) -- Should fall back to `shasum -a 256`.

9. **`date -d` and `readlink -f` GNU-only** -- Already flagged. macOS incompatible without coreutils.

10. **22 scattered rc file appends** -- Spread across 8+ RUN layers. Could be a single COPY of a profile fragment, avoiding the oh-my-zsh overwrite issue.

11. **19 RUN layers could be consolidated** -- Related installations could be grouped for smaller image and clearer dependency ordering.

### Low

12. **Bash version check says 4.0 but namerefs need 4.3** (`agentbox:7`) -- `local -n` used on 13 lines. Should check for 4.3+.

13. **`echo | xargs` trimming can mangle special chars** (`agentbox:445`) -- Should use parameter expansion.

14. **`xxd` dependency for random suffix** (`agentbox:83`) -- Not guaranteed on all hosts. Could use `printf '%04x%04x' $RANDOM $RANDOM` instead.

15. **`$RUNTIME` used unquoted as command** -- Harmless in practice (guarded by `check_runtime`), but ShellCheck would flag it.

16. **`apt-get clean` redundant with BuildKit cache mount** (`Dockerfile:50`) -- Harmless but unnecessary.

17. **Missing trailing newline in Dockerfile** -- POSIX requires text files to end with newline.

## CI/CD & DevOps Findings

### Critical

1. **No build/test CI pipeline** -- Two GitHub Actions workflows are Claude Code review bots only. No ShellCheck, no hadolint, no `docker build` verification, no smoke tests. Broken code can merge to main uncaught.

2. **Non-reproducible builds** -- 10+ unpinned curl-pipe-bash installs, unpinned base image, latest-version API calls. Two builds an hour apart produce different images.

### High

3. **No versioning or release process** -- No git tags, no changelog, no release artifacts. Hardcoded `agentbox.version=1.0.0` never incremented. No `--version` flag.

4. **SSH keys mounted read-write** -- Already flagged across phases.

5. **curl-pipe-bash on every container start** -- Already flagged across phases.

### Medium

6. **No debug/verbose mode** -- No `--debug` flag. When docker run fails, user sees only Docker's error without knowing what arguments were passed.

7. **Entrypoint swallows errors silently** -- `2>/dev/null` and `|| true` on line 63 hide all failures. No indication when Claude Code update fails.

8. **No distribution mechanism** -- Install is manual git clone + chmod. No Homebrew tap, no install script, no pre-built images.

9. **No self-update mechanism** -- Users must manually `git pull`.

10. **48-hour rebuild status unclear** -- Commit `a4729e6` removed it, but working tree re-adds it. Intentional or accidental revert?

11. **`.env` files loaded unfiltered** -- Already flagged.

### Low

12. **No `.dockerignore`** -- Already flagged.
13. **Image prune has no rollback** -- Previous image pruned immediately. Could keep `agentbox:previous` tag.
14. **No container HEALTHCHECK** -- Low priority for interactive use.
15. **NOPASSWD sudo** -- Documented and intentional for the use case.
