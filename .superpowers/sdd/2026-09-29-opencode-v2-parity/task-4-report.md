# Task 4 Report: Verify OpenCode V2 and document its boundary

## Status

**DONE_WITH_CONCERNS** — The smoke checker, documentation, fixture coverage, and safe container checks are complete. Full host parity is not established: the real server returned empty plugin and agent catalogs, the CLI-plugin load result was inconclusive, and there was no host OpenCode listener available for an identity comparison.

## Changes

- Added `tests/opencode-smoke.sh`, an opt-in, read-only check for the selected V2 version, seven API endpoints, optional plugin/MCP expectations, Meridian's model catalog, and connection-only Herdr socket access. It creates one private child server with a temporary password and reports catalog counts/statuses rather than bodies.
- Updated `README.md` and `DEVELOPMENT_NOTES.md` for selective mounts, shared config/data, isolated state/cache, host networking, private-server behavior, rebuild selection, and the smoke command.
- Corrected managed API/run argument placement for OpenCode 2.0.19 and added the Meridian config home alias required by its discovered root dependency.
- Fixed managed OpenCode launches being short-circuited when the noninteractive `zsh -c` source of `~/.zshrc` returns nonzero. A regression test covers the failure; Claude retains its original `&&` gate.

## Verification

- RED: the new zsh-return regression failed because the generated OpenCode command exited with status 1 before invoking the CLI. GREEN: the focused test passed after the OpenCode-only change; its Claude assertion confirms that Claude behavior remains gated as before.
- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs`: **62 passed, 0 failed**.
- `bash -n agentbox entrypoint.sh tests/opencode-smoke.sh`, `node --check opencode-dependencies.cjs`, and `git diff --check`: passed.
- `shellcheck agentbox entrypoint.sh tests/opencode-smoke.sh` exits 1 on the previously recorded baseline warnings (agentbox SC2155/SC2034; entrypoint SC1091/SC2166/SC2046). No new warning category was introduced.
- The real Docker image build completed and selected OpenCode `2.0.19`.
- Real private-server smoke: all seven endpoints responded; counts were plugin **0**, agent **0**, skill **2**, command **8**, model **44**, and MCP **9**. The extended check found all five configured InterBase MCPs connected, all four debugger MCPs disabled, a nonempty Meridian model catalog at `127.0.0.1:3456`, and a Herdr socket connection without an RPC request.
- The managed `agentbox --tool opencode api get /api/info` command returned version `2.0.19` and a container-local loopback URL after the zsh-return fix. The private child process was allowed to exit with its container.
- A renderer-only TUI launch used a real PTY, fresh container-local `XDG_DATA_HOME`, `HERDR_ENV=0`, and no session/pane identifiers or input. Filtered debug output referenced both provider-indicator and Herdr load events, but also matched failure-pattern text for both; successful plugin activation is therefore **inconclusive**, not claimed. The bounded TUI process was terminated by its timeout.
- Earlier actual-container inspection recorded host networking, the shared config/data aliases, the separate reusable AgentBox cache, the main-checkout mount, no host state mount, and readable Meridian code/config aliases. No AgentBox-driven config/auth replacement or conversion was observed. Live SQLite bytes were not compared.

## Outstanding checks and safety boundary

- The private server's plugin and agent catalogs each returned zero entries. The required Meridian server plugin was consequently missing; configured server plugins/agents (Meridian, Jev, routing, Superpowers, and safety-net) are not verified. Meridian's HTTP model catalog working does not prove its OpenCode plugin loaded.
- The host listener check found `127.0.0.1:3456` but no listener on the expected OpenCode port `4096`; host-service identity comparison is incomplete. No host service was started, stopped, or modified.
- A real `.env` selector-override fixture launch was blocked by Safety Net (`secret.basename.env`). It was not retried or worked around and remains incomplete.
- No prompts, paid requests, session selection/resumption, Herdr pane RPC, config/credential inspection, or database repair was performed. Smoke/TUI runs excluded project `.env` injection.

## Final fast-check output

- Unit tests: **62/62 passed**.
- Syntax checks and whitespace check: passed.
- ShellCheck: baseline diagnostics only; exit status 1 as recorded above.

## Final review

- Jev selected full-branch review dimensions for architecture, security, database, performance, deployment, tests, documentation, and accessibility. No reviewer was delegated because the user required controller-owned review.
- Controller self-review covered all five plan Review Focus items, the approved spec, the Task 4 implementation, and actual evidence. No additional Critical/Important code findings were identified; the known integration gaps are listed above. This was not an independent review.
