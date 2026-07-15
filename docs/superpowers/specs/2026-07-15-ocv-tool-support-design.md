# Design: Add `ocv` (opencode-vim) tool support to AgentBox

Date: 2026-07-15

## Goal

Add `ocv` (opencode-vim) as a third selectable agentic tool in AgentBox,
alongside `claude` (default) and `opencode`, with the same integrations Claude
Code receives: installed in the image, selectable via `--tool` / `AGENTBOX_TOOL`,
config/auth mounted for persistence, launched automatically, shown in the startup
banner, and documented.

## Background

`ocv` is [opencode-vim](https://github.com/leohenon/opencode-vim), a keyboard-first
fork of opencode (`anomalyco/opencode`) kept in sync with upstream releases. It is a
full, self-contained TUI — not a plugin — distributed as the npm package
`@leohenon/ocv`, launched with the command `ocv`. Because it is a synced opencode
fork and runs itself as `exec -a opencode ocv`, it reads opencode's configuration and
auth directories.

AgentBox already has a canonical process for this in `docs/prompts/add-tool.md`; this
design applies that process to `ocv`.

## Decisions

1. **Install method: npm global.** Add a `RUN` block installing `@leohenon/ocv`
   globally via npm (inside the nvm environment, like the historical node global
   packages). Its bin lands on the nvm global bin directory already in PATH, so no
   PATH edits are needed. Rejected alternative: the `curl install.sh` installer, which
   drops a binary in `~/.ocv/bin` and would require an additional PATH export.

2. **Config/auth: reuse opencode's directories.** ocv shares opencode's config
   (`~/.config/opencode`) and data/auth (`~/.local/share/opencode`). The existing
   opencode mount block is extended to also match `ocv`, so authenticating opencode on
   the host also authenticates ocv. To be verified at build/test time; if ocv uses its
   own directory, this is a localized change.

3. **Launch command: plain `ocv`.** No skip-permissions flag, matching how `opencode`
   is launched. opencode/ocv have no `--dangerously-skip-permissions` equivalent in the
   current script.

## Changes

### Dockerfile
- Add a `RUN` block (after the Claude Code install) that installs `@leohenon/ocv`
  globally via npm inside the nvm environment, then verifies with
  `zsh -i -c 'which ocv && ocv --version'`.

### agentbox
- **Tool validation** (~line 745): accept `ocv` in addition to `claude` and
  `opencode`; update the error message.
- **Config mount** (~line 379): change the opencode branch condition to match both
  `opencode` and `ocv` so both mount `~/.config/opencode` and
  `~/.local/share/opencode`.
- **Tool command** (~line 435): add `elif [[ "$tool" == "ocv" ]]; then tool_cmd="ocv"`.
- **Help text** (`show_help`): list `ocv` in the `--tool` description, add a usage
  example, and update the `AGENTBOX_TOOL` example note.

### entrypoint.sh
- **Startup banner** (~line 76): add an `elif [ "$TOOL" = "ocv" ]` branch displaying
  `ocv --version`.

### README.md
- List `ocv` as a `--tool` option where `claude`/`opencode` are documented.

## Out of scope

- The pre-existing bug that `--tool opencode` fails because opencode is no longer
  installed in the Dockerfile (documented in `.full-review/03-testing-documentation.md`).
  ocv is self-contained and does not depend on the opencode binary, so it is unaffected.
  Fixing the opencode install is a separate change.

## Verification

- `agentbox --tool ocv` builds the image and launches ocv.
- `agentbox --tool ocv --version` (or the startup banner) reports an ocv version.
- opencode/ocv auth persists across container restarts via the shared mount.
