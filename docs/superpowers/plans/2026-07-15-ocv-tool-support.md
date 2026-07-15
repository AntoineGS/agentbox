# ocv (opencode-vim) Tool Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ocv` (opencode-vim) as a third selectable agentic tool in AgentBox, with the same integrations Claude Code and OpenCode receive.

**Architecture:** `ocv` is a keyboard-first, self-contained fork of opencode (npm package `@leohenon/ocv`, command `ocv`) that reads opencode's config/auth directories. It is installed in the image via npm, selected with `--tool ocv` / `AGENTBOX_TOOL=ocv`, mounts opencode's config dirs for persistence, launches automatically, and appears in the startup banner and docs.

**Tech Stack:** Bash script (`agentbox`), Debian-based Dockerfile, `entrypoint.sh`, Markdown docs. No automated test framework exists in this repo — verification is `bash -n` syntax checks, logic inspection, and a real `docker`/`podman` build + run.

## Global Constraints

- Bash 4.0+ features are allowed (the script already requires it).
- Tool names are lowercase and simple: the new tool is `ocv`.
- Comments are used sparingly; prefer expressive code over comments (per CLAUDE.md).
- `ocv` shares opencode's config (`~/.config/opencode`) and data/auth (`~/.local/share/opencode`) directories — do NOT create a separate `~/.config/ocv`.
- `ocv` launches with no skip-permissions flag (matches how `opencode` launches).
- Existing valid tool values: `claude` (default), `opencode`. After this plan: `claude`, `opencode`, `ocv`.

---

### Task 1: Wire `ocv` into the `agentbox` script

Adds `ocv` to tool validation, the config-mount block, the launch-command builder, and the help text. Verifiable without Docker.

**Files:**
- Modify: `agentbox` (validation ~line 745; config mount ~line 379; tool command ~line 435; help text ~lines 585, 603)

**Interfaces:**
- Consumes: the existing `$tool` variable (values `claude` / `opencode`, now also `ocv`) and the `mounts_ref` / `cmd_ref` nameref arrays.
- Produces: `--tool ocv` accepted as valid; `tool_cmd="ocv"` when selected; opencode config dirs mounted for `ocv`; help text listing `ocv`.

- [ ] **Step 1: Extend tool validation to accept `ocv`**

In `agentbox`, find (around line 744):

```bash
    # Validate tool selection
    if [[ "$tool" != "claude" && "$tool" != "opencode" ]]; then
        log_error "Invalid tool: $tool (must be 'claude' or 'opencode')"
        exit 1
    fi
```

Replace with:

```bash
    # Validate tool selection
    if [[ "$tool" != "claude" && "$tool" != "opencode" && "$tool" != "ocv" ]]; then
        log_error "Invalid tool: $tool (must be 'claude', 'opencode', or 'ocv')"
        exit 1
    fi
```

- [ ] **Step 2: Mount opencode config dirs for `ocv` too**

In `agentbox`, find (around line 379):

```bash
    if [[ "$tool" == "opencode" ]]; then
        local opencode_config_dir="${HOME}/.config/opencode"
        local opencode_auth_dir="${HOME}/.local/share/opencode"
        mkdir -p "$opencode_config_dir" "$opencode_auth_dir"

        mounts_ref+=(
            -v "${opencode_config_dir}:/home/agent/.config/opencode"
            -v "${opencode_auth_dir}:/home/agent/.local/share/opencode"
        )
        log_info "OpenCode configuration and auth mounted"
    else
```

Replace the first line and log line so the block also matches `ocv`:

```bash
    if [[ "$tool" == "opencode" || "$tool" == "ocv" ]]; then
        local opencode_config_dir="${HOME}/.config/opencode"
        local opencode_auth_dir="${HOME}/.local/share/opencode"
        mkdir -p "$opencode_config_dir" "$opencode_auth_dir"

        mounts_ref+=(
            -v "${opencode_config_dir}:/home/agent/.config/opencode"
            -v "${opencode_auth_dir}:/home/agent/.local/share/opencode"
        )
        log_info "OpenCode/ocv configuration and auth mounted"
    else
```

- [ ] **Step 3: Add the `ocv` launch command**

In `agentbox`, find (around line 434):

```bash
    local tool_cmd
    if [[ "$tool" == "opencode" ]]; then
        tool_cmd="opencode"
    else
        tool_cmd="claude --dangerously-skip-permissions"
    fi
```

Replace with:

```bash
    local tool_cmd
    if [[ "$tool" == "opencode" ]]; then
        tool_cmd="opencode"
    elif [[ "$tool" == "ocv" ]]; then
        tool_cmd="ocv"
    else
        tool_cmd="claude --dangerously-skip-permissions"
    fi
```

- [ ] **Step 4: Update help text**

In `agentbox`, find (around line 585):

```bash
    --tool TOOL             Choose tool: claude (default) or opencode
```

Replace with:

```bash
    --tool TOOL             Choose tool: claude (default), opencode, or ocv
```

Then find (around line 603):

```bash
    agentbox --tool opencode            # Start OpenCode instead of Claude
```

Add a line immediately after it:

```bash
    agentbox --tool opencode            # Start OpenCode instead of Claude
    agentbox --tool ocv                 # Start opencode-vim (ocv) instead of Claude
```

- [ ] **Step 5: Syntax-check the script**

Run: `bash -n agentbox`
Expected: no output, exit code 0 (no syntax errors).

- [ ] **Step 6: Verify validation logic accepts `ocv` and rejects garbage**

Run:

```bash
tool=ocv;    [[ "$tool" != "claude" && "$tool" != "opencode" && "$tool" != "ocv" ]] && echo REJECTED || echo ACCEPTED
tool=bogus;  [[ "$tool" != "claude" && "$tool" != "opencode" && "$tool" != "ocv" ]] && echo REJECTED || echo ACCEPTED
```

Expected output:

```
ACCEPTED
REJECTED
```

- [ ] **Step 7: Confirm all four edits landed**

Run: `grep -n "ocv" agentbox`
Expected: matches in the validation line, the mount condition, the `tool_cmd="ocv"` line, and the two help-text lines.

- [ ] **Step 8: Commit**

```bash
git add agentbox
git commit -m "feat: wire ocv tool into agentbox script (validation, mounts, launch, help)"
```

---

### Task 2: Install `ocv` in the image and show it in the startup banner

Adds the Dockerfile install/verify block and the `entrypoint.sh` banner branch. This task's deliverable is a working image, so it is verified by a real build + run.

**Files:**
- Modify: `Dockerfile` (after the Claude install block, ~lines 236-238)
- Modify: `entrypoint.sh` (startup banner, ~lines 76-80)

**Interfaces:**
- Consumes: `$NVM_DIR` (ENV set at Dockerfile line 104) for npm; `$TOOL` env var (set by `agentbox` to `ocv`) in the banner.
- Produces: an `ocv` binary on PATH in the image; a banner line reporting `ocv --version` when `TOOL=ocv`.

- [ ] **Step 1: Add the `ocv` install + verification block to the Dockerfile**

In `Dockerfile`, find (around line 236):

```dockerfile
ARG BUILD_TIMESTAMP=unknown
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    zsh -i -c 'which claude && claude --version'
```

Add a new block immediately after it (keeps `ocv` in the `BUILD_TIMESTAMP` cache-busted zone so it refreshes on rebuild, staying in sync with upstream):

```dockerfile
ARG BUILD_TIMESTAMP=unknown
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    zsh -i -c 'which claude && claude --version'

# Install opencode-vim (ocv), a keyboard-first opencode fork.
RUN bash -c "source \"$NVM_DIR/nvm.sh\" && npm install -g @leohenon/ocv" && \
    zsh -i -c 'which ocv && ocv --version'
```

Contingency (only if the build fails at `ocv --version` because npm global install is unusable): replace the `RUN` above with the official curl installer and add its bin dir to PATH —

```dockerfile
RUN curl -fsSL https://raw.githubusercontent.com/leohenon/opencode-vim/ocv/install.sh | sh && \
    echo 'export PATH="$HOME/.ocv/bin:$PATH"' >> ~/.bashrc && \
    echo 'export PATH="$HOME/.ocv/bin:$PATH"' >> ~/.zshrc && \
    zsh -i -c 'which ocv && ocv --version'
```

and, in `entrypoint.sh`, change the top PATH export from
`export PATH="$HOME/.local/bin:$PATH"` to
`export PATH="$HOME/.local/bin:$HOME/.ocv/bin:$PATH"`.
Prefer the npm approach; use this only if npm fails.

- [ ] **Step 2: Add the `ocv` branch to the startup banner**

In `entrypoint.sh`, find (around line 76):

```bash
    if [ "$TOOL" = "opencode" ]; then
        echo "🤖 OpenCode: $(opencode --version 2>/dev/null || echo 'not found - check installation')"
    else
        echo "🤖 Claude CLI: $(claude --version 2>/dev/null || echo 'not found - check installation')"
    fi
```

Replace with:

```bash
    if [ "$TOOL" = "opencode" ]; then
        echo "🤖 OpenCode: $(opencode --version 2>/dev/null || echo 'not found - check installation')"
    elif [ "$TOOL" = "ocv" ]; then
        echo "🤖 ocv: $(ocv --version 2>/dev/null || echo 'not found - check installation')"
    else
        echo "🤖 Claude CLI: $(claude --version 2>/dev/null || echo 'not found - check installation')"
    fi
```

- [ ] **Step 3: Syntax-check entrypoint.sh**

Run: `bash -n entrypoint.sh`
Expected: no output, exit code 0.

- [ ] **Step 4: Build the image (installs and verifies ocv)**

Run: `./agentbox --tool ocv --rebuild shell true`

This forces a rebuild, then runs `true` in a shell and exits. The build runs the Dockerfile `RUN ... ocv --version` verification, so a broken install fails the build here.
Expected: build completes with `Image built successfully!`; during build, `which ocv` prints a path and `ocv --version` prints a version. The container then starts and exits cleanly.

- [ ] **Step 5: Verify `ocv` is installed and on PATH via the tool**

Run: `./agentbox --tool ocv shell ocv --version`

`shell <args>` execs the args directly in the container (which sources nvm, putting the npm global bin on PATH), so this runs `ocv --version` inside the image.
Expected: prints an ocv version string (not "command not found"). The interactive banner line `🤖 ocv: <version>` is exercised separately by running `./agentbox --tool ocv` in a real terminal.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile entrypoint.sh
git commit -m "feat: install ocv (opencode-vim) in image and add banner support"
```

---

### Task 3: Document `ocv` in the README

Adds `ocv` to the user-facing docs, matching the concise documentation style (per CLAUDE.md: maximum meaning, minimum words; don't replicate standard tool docs).

**Files:**
- Modify: `README.md` (CLI Agent Support ~line 40; Helpful Commands ~line 57; Languages and Tools ~line 110; Tool Authentication ~line 192)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: user-facing mention of `ocv` as a `--tool` value and note that it shares opencode auth.

- [ ] **Step 1: Add `ocv` to the CLI Agent Support list**

In `README.md`, find (around line 40):

```markdown
- opencode: built-in
```

Replace with:

```markdown
- opencode: built-in
- opencode-vim (`ocv`): built-in
```

- [ ] **Step 2: Add a Helpful Commands example**

In `README.md`, find (around line 56):

```markdown
# Use OpenCode instead of Claude
agentbox --tool opencode
```

Replace with:

```markdown
# Use OpenCode instead of Claude
agentbox --tool opencode

# Use opencode-vim (ocv) instead of Claude
agentbox --tool ocv
```

- [ ] **Step 3: Add `ocv` to the Languages and Tools list**

In `README.md`, find (around line 110):

```markdown
- **OpenCode**: Pre-installed as an alternative AI coding tool
```

Replace with:

```markdown
- **OpenCode**: Pre-installed as an alternative AI coding tool
- **opencode-vim (`ocv`)**: Pre-installed keyboard-first opencode fork; shares OpenCode's config and auth
```

- [ ] **Step 4: Note the shared auth under Tool Authentication**

In `README.md`, find (around line 190):

```markdown
**OpenCode**:
- Config: `~/.config/opencode` mounted at `/home/agent/.config/opencode`
- Auth: `~/.local/share/opencode` mounted at `/home/agent/.local/share/opencode`
```

Replace with:

```markdown
**OpenCode** (and **`ocv`**, which reuses these directories):
- Config: `~/.config/opencode` mounted at `/home/agent/.config/opencode`
- Auth: `~/.local/share/opencode` mounted at `/home/agent/.local/share/opencode`
```

- [ ] **Step 5: Verify the edits landed**

Run: `grep -n "ocv" README.md`
Expected: matches in the CLI Agent Support list, Helpful Commands, Languages and Tools, and Tool Authentication sections.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document ocv (opencode-vim) tool option"
```

---

## Verification (whole feature)

After all tasks:
- `./agentbox --tool ocv` builds (if needed) and launches the ocv TUI.
- `./agentbox --tool bogus` still errors with the updated message listing `claude`, `opencode`, `ocv`.
- The startup banner shows `🤖 ocv: <version>` under `--tool ocv`.
- opencode/ocv auth persists across runs via the shared `~/.config/opencode` + `~/.local/share/opencode` mounts.

## Notes / Out of scope

- The pre-existing bug that `--tool opencode` fails because opencode is no longer installed in the Dockerfile is NOT addressed here. `ocv` is self-contained and does not need the opencode binary. Fix opencode's install separately if desired.
