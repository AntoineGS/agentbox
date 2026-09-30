# Task 4 Report: Verify OpenCode V2 and document its boundary

## Status

**Fix round 2 implementation committed; controller re-review pending.** The no-requirements path now warms location before waiting and remains endpoint-only, without catalog-readiness or count claims. Requirement runs retain bounded readiness and final location/status checks. The real container verifies configured server plugins, definitions, MCPs, and Meridian. Actual CLI-plugin activation remains inconclusive because the safe no-session renderer exposed no conclusive registration signal and the authorized fixture-session command was blocked before execution. The real `.env` selector fixture also remains blocked by Safety Net.

## Changes

- Added `tests/opencode-smoke.sh`, an opt-in, read-only check for the selected V2 version, seven API endpoints, optional plugin/agent/skill/command/MCP expectations, Meridian's model catalog, and connection-only Herdr socket access. It creates one private child server with a temporary password; requirement runs wait for catalog readiness and report final counts/statuses, while no-requirements runs validate endpoint envelopes/locations without claiming catalog readiness or counts.
- Updated `README.md` and `DEVELOPMENT_NOTES.md` for selective mounts, shared config/data, isolated state/cache, host networking, private-server behavior, rebuild selection, and the smoke command.
- Corrected managed API/run argument placement for OpenCode 2.0.19 and added the Meridian config home alias required by its discovered root dependency.
- Fixed managed OpenCode launches being short-circuited when the noninteractive `zsh -c` source of `~/.zshrc` returns nonzero. A regression test covers the failure; Claude retains its original `&&` gate.

## Verification

- RED: the new zsh-return regression failed because the generated OpenCode command exited with status 1 before invoking the CLI. GREEN: the focused test passed after the OpenCode-only change; its Claude assertion confirms that Claude behavior remains gated as before.
- `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs`: **62 passed, 0 failed**.
- `bash -n agentbox entrypoint.sh tests/opencode-smoke.sh`, `node --check opencode-dependencies.cjs`, and `git diff --check`: passed.
- `shellcheck agentbox entrypoint.sh tests/opencode-smoke.sh` exits 1 on the previously recorded baseline warnings (agentbox SC2155/SC2034; entrypoint SC1091/SC2166/SC2046). No new warning category was introduced.
- The real Docker image build completed and selected OpenCode `2.0.19`.
- Pre-fix initial sample (superseded by Fix round 1 below): all seven endpoints responded, but plugin and agent counts were **0**; the sample was too early to be an integration verdict. The extended check at that time found five InterBase MCPs connected, four debugger MCPs disabled, a nonempty Meridian catalog, and a connection-only Herdr socket check.
- The managed `agentbox --tool opencode api get /api/info` command returned version `2.0.19` and a container-local loopback URL after the zsh-return fix. The private child process was allowed to exit with its container.
- An earlier renderer-only TUI launch used a real PTY, fresh container-local `XDG_DATA_HOME`, `HERDR_ENV=0`, and no session/pane identifiers or input. Its filtered logs were ambiguous; Fix round 1 repeats and narrows that check below.
- Earlier actual-container inspection recorded host networking, the shared config/data aliases, the separate reusable AgentBox cache, the main-checkout mount, no host state mount, and readable Meridian code/config aliases. No AgentBox-driven config/auth replacement or conversion was observed. Live SQLite bytes were not compared.

## Outstanding checks and safety boundary

- Server-plugin, configured-definition, and MCP parity are verified by the Fix round 1 checks below. The renderer-only provider-indicator/Herdr CLI activation result remains inconclusive and is not inferred from server catalogs.
- A port-4096-only host check was incomplete. Fix round 1 scanned all host TCP listeners and found an existing OpenCode-owned loopback listener on port `49374`; process/state evidence below distinguishes it from the ephemeral managed container server. No host service was contacted, started, stopped, or modified.
- A real `.env` selector-override fixture launch was blocked by Safety Net (`secret.basename.env`). It was not retried or worked around and remains incomplete.
- No prompts, paid requests, host session selection/resumption, Herdr pane RPC, credential-content reads, or database repair was performed. Plugin declarations and definition filenames were used as read-only expectations; selected config/cache metadata was checked without reading auth or credential files. Smoke/TUI runs excluded project `.env` injection. The round-2 synthetic fixture-session setup did not reach its POST step; no fixture session was created.

## Baseline verification (before fix round 1)

- Unit tests on the prior baseline: **62/62 passed**.
- Baseline syntax/whitespace and ShellCheck results are superseded by the fresh fix-round verification below.

## Review boundary

- This fix round had no delegated/nested reviewer and no broad review. The task implementer performed the self-review; controller-owned independent scoped re-review is pending. No approval is claimed.

## Fix round 1/5: readiness, final evidence, and remaining blockers

### Checker and regression changes

- Added `--require-agent`, `--require-skill`, and `--require-command`. The checker waits through a three-second startup floor, polls every relevant catalog while required entries are pending, validates `.location.directory` against `pwd -P`, then refreshes all six catalogs and checks the final snapshot before reporting counts.
- `--require-plugin` accepts an exact ID/source or a configured absolute plugin directory containing its loaded entrypoint; the Meridian directory requirement now matches the active `index.js` source.
- Catalog GETs use authenticated read-only HTTP with a random password held in a mode-`0600` temporary curl config inside the owned private workspace. This avoids an observed OpenCode 2.0.19 `api get /api/skill` client-output defect while still checking the private server's API route. The smoke suppresses response bodies and raw service errors.
- RED: the delayed-activation fixture reproduced stale output (`plugin (0 entries)`, `agent (0 entries)`) despite the requirement becoming active after the three-second delay. GREEN: the delayed plugin/agent/skill/command test passes and reports populated final counts. Additional fixtures cover path-location mismatch, sanitized API error classification, directory-source plugin matching, enforced temporary authentication, child termination, workspace cleanup, and refresh of all catalogs.

### Real configured runtime checks

- Actual configured-server command (run with `HERDR_ENV=0`):

  ```bash
  main_checkout=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  cmd=(./agentbox --add-dir "$main_checkout" --tool opencode shell bash tests/opencode-smoke.sh \
    --require-plugin /usr/lib/meridian/dist/meridian-v2 \
    --require-plugin agent-provider-routing --require-plugin herdr.opencode \
    --require-plugin jev --require-plugin tmux-agent-indicator \
    --require-plugin superpowers --require-plugin cc-safety-net \
    --require-mcp interbase_nrf01 --require-mcp interbase_reference \
    --require-mcp interbase_centrale --require-mcp interbase_todos \
    --require-mcp interbase_mdevapps \
    --disabled-mcp rdbg_x64 --disabled-mcp rdbg_x86 \
    --disabled-mcp rdbg_vm_x64 --disabled-mcp rdbg_vm_x86 \
    --meridian-url http://127.0.0.1:3456/v1/models)
  HERDR_ENV=0 script -qefc "$(printf '%q ' "${cmd[@]}")" /dev/null
  ```

  A second run built `args` from read-only file discovery and then invoked `bash tests/opencode-smoke.sh "${args[@]}"`; agent IDs came from `*.md` under configured `agents` roots, skill IDs from directories containing `SKILL.md`, and command IDs from configured `command(s)/*.md` roots. This required **47 agents, 39 skills, and 37 commands** in addition to the static plugin/MCP/Meridian options above. No definition bodies were printed.
- Final private-server result: version `2.0.19`; all seven endpoints passed; every catalog reported the current working directory. Counts: plugin **94**, agent **54**, skill **57**, command **45**, model **44**, MCP **9**.
- All seven configured server-plugin expectations were **active**: Meridian (`/usr/lib/meridian/dist/meridian-v2`), `agent-provider-routing`, `herdr.opencode`, `jev`, `tmux-agent-indicator`, `superpowers`, and `cc-safety-net`. File-backed definitions all passed presence requirements: **47 agents, 39 skills, 37 commands**. All five configured InterBase MCPs were **connected**, all four debugger MCPs were **disabled**, and Meridian returned a nonempty model catalog.
- The managed `agentbox --tool opencode api get /api/info` route returned `2.0.19`, container API PID `621`, loopback URL `http://127.0.0.1:44985`, and temp path `/tmp/opencode`. After the AgentBox container exited, port `44985` was no longer listening.
- An all-listener process-ownership scan found the pre-existing host OpenCode process at `127.0.0.1:49374`, PID `3053404`, executable `/usr/bin/opencode`, UID `155801123`, started Sep 29 2026 at 14:56:22. No request was sent to it. A separate private child observed inside AgentBox was PID `380`, command `opencode`, parent PID `8`, user `agent`, at loopback port `34095`; its state path resolved to the container overlay (`/`), while OpenCode shared data and AgentBox cache resolved to their explicit mount targets. This corrects the earlier assumption based on port `4096` alone.
- Two separate AgentBox container launches saw identical device/inode/size/mtime metadata for the cached `superpowers` and `cc-safety-net` package directories. The second full smoke reused those entries without metadata changes. Metadata for the OpenCode config directory, present `opencode.json`/`opencode.jsonc`/`cli.json`, and Meridian `plugins.json` was unchanged between launches and across the second smoke. No credential values or auth-file contents were read or printed; configured plugin declarations were parsed read-only and only plugin identifiers/paths were emitted. No live SQLite bytes were read or hashed.
- CLI-client diagnostic: `opencode api ... get /api/skill` returned **241,664 bytes of non-JSON**; a direct authenticated GET to the same private server returned HTTP **200** with the expected catalog envelope. The other six CLI API route outputs were JSON. No non-JSON content was printed or retained. The smoke now tests server routes over direct HTTP; the managed CLI `/api/info` route was separately verified.

### Renderer-only CLI plugin result

- Two bounded PTY launches used fresh container-local `XDG_DATA_HOME` under an owned temporary directory, `HERDR_ENV=0`, no session/pane identifiers, and no input. They timed out and were forcibly terminated as planned (status **137**); no host session was selected or resumed.
- Sanitized trace summary: provider-indicator references **0**, rendered `Rte: OpenAI/Anthropic` marker **absent**; Herdr references **3**, load-like markers **1**, failure markers **0**. Module-resolution, permission, external-network, auth, and compatibility error-pattern counts were all **0**. The provider-indicator's data source has `orchestrator_provider=openai`, but no renderer marker appeared on the safe no-session screen. With `HERDR_ENV=0`, Herdr's session callbacks intentionally return before socket/RPC behavior.
- Therefore provider-indicator and Herdr CLI-plugin **successful activation remains unverified**. The readable plugin mounts and absence of categorized load errors do not prove renderer registration; the no-session safety boundary prevented opening a session/prompt to force a footer render. This is an unresolved CLI/TUI integration result, not evidence of a server-plugin or catalog failure.

### Fix-round verification and safety

- Full fix-round suite (the owned worktree-local fixture root was removed by the trap):

  ```bash
  testtmp=$(mktemp -d "$PWD/.task4-test.XXXXXX")
  trap 'rm -rf -- "$testtmp"' EXIT
  AGENTBOX_TEST_TMPDIR="$testtmp" NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs
  ```

  Result: **66 passed, 0 failed**. The test temp root avoided `/tmp` cleanup or unrelated files.
- Syntax/whitespace checks: `bash -n tests/opencode-smoke.sh`, `node --check tests/agentbox.test.cjs`, `node --check tests/opencode-dependencies.test.cjs`, and `git diff --check` all exited **0**. `shellcheck tests/opencode-smoke.sh` exited **0** with no diagnostics.
- A second full real smoke verified the same final counts, all seven active server plugins, all **47/39/37** configured definitions, five connected InterBase MCPs, four disabled debugger MCPs, and Meridian. No host listener was contacted.
- The real `.env` selector-override fixture remains blocked by Safety Net (`secret.basename.env`). It was not retried or bypassed. No prompt, paid request, session mutation, Herdr RPC, credential-content access, config repair, database access/repair, host-service mutation, or live SQLite hashing occurred.
- Self-review for this fix round is by the task implementer. The controller's independent scoped re-review is pending; this report does not claim its approval.

## Fix round 2/5: warm-up order, endpoint-only default, and remaining CLI gate

### Checker and regression changes

- Moved the first project-location-scoped `GET /api/plugin` ahead of the bounded startup wait. This request now performs the location warm-up before any wait; subsequent catalog reads still validate the returned working-directory location.
- The no-requirements path now explicitly reports endpoint response-shape/location checks only. It does not claim catalog readiness or print entry counts. `README.md` and `DEVELOPMENT_NOTES.md` describe that distinction and reserve bounded readiness/final counts for requirement runs.
- The new no-requirements fixture delays location-catalog population until one second after the first plugin request. It verifies the first plugin response is empty, the warm-up precedes `/api/info` and the wait, a later endpoint sees the populated agent catalog, and successful output makes no readiness/count claim.
- Requirement-path regressions continue to cover delayed configured catalogs and final refreshed counts/statuses. Failure-path and TERM-interruption tests now verify that only the owned child process is stopped and the private workspace is removed.

### RED/GREEN evidence

- RED command, run before the implementation change:

  ```bash
  testtmp=$(mktemp -d "$PWD/.task4-test.XXXXXX") || exit 1
  trap 'rm -rf -- "$testtmp"' EXIT
  AGENTBOX_TEST_TMPDIR="$testtmp" NODE_PATH=/tmp/opencode/agentbox-dev/node_modules \
    node --test --test-name-pattern='default smoke warms the location' tests/agentbox.test.cjs
  ```

  Result: **1 failed** as intended. The no-options smoke succeeded while reporting plugin **0** and agent **0**, and did not emit the new endpoint-only disclaimer.
- GREEN focused command after the change:

  ```bash
  testtmp=$(mktemp -d "$PWD/.task4-test.XXXXXX")
  trap 'rm -rf -- "$testtmp"' EXIT
  AGENTBOX_TEST_TMPDIR="$testtmp" NODE_PATH=/tmp/opencode/agentbox-dev/node_modules \
    node --test --test-name-pattern='smoke cleanup|smoke reports API failure|default smoke warms|documentation records' \
    tests/agentbox.test.cjs
  ```

  Result: **4 passed, 0 failed**, including the delayed-location, API-failure cleanup, TERM cleanup, and documentation-alignment checks.
- Final suite command:

  ```bash
  testtmp=$(mktemp -d "$PWD/.task4-test.XXXXXX")
  trap 'rm -rf -- "$testtmp"' EXIT
  AGENTBOX_TEST_TMPDIR="$testtmp" NODE_PATH=/tmp/opencode/agentbox-dev/node_modules \
    node --test tests/*.test.cjs
  ```

  Result: **68 passed, 0 failed**. `bash -n agentbox entrypoint.sh tests/opencode-smoke.sh`, `node --check opencode-dependencies.cjs`, `node --check tests/agentbox.test.cjs`, `shellcheck tests/opencode-smoke.sh`, and `git diff --check` all passed.

### Isolated renderer evidence and blocker

- One bounded renderer-only launch used the actual `agentbox:latest` image (**OpenCode 2.0.19**) with `docker run --rm --network=none`, a container-local executable `/tmp` tmpfs, fresh `HOME` and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` below that temp root, and an isolated project. The actual `herdr-opencode`, its imported `herdr-tui-session.js`, and `provider-indicator` sources were bind-mounted read-only. A temporary global `cli.json` listed those two configured sources. `OPENCODE_CONFIG_DIR` pointed into the isolated home; `HERDR_ENV=0`; `OPENCODE_DISABLE_AUTOUPDATE=1`; `OPENCODE_DISABLE_MODELS_FETCH=1`; `OPENCODE_SESSION_ID`, `OPENCODE_SESSION`, all Herdr pane/tab/workspace/session identifiers, and `HERDR_SOCKET_PATH` were unset. The renderer received no input and ran under `timeout --signal=INT --kill-after=2s 6s script -qefc 'stty cols 160 rows 45; exec opencode --standalone --log-level trace --print-logs' ...`; it ended with status **137** after the bound.
- Sanitized trace summary: **22** provider-indicator name references and **22** Herdr name references; **0** categorized load/registration success markers and **0** categorized failure markers. `Rte: OpenAI` was absent. This was a no-session screen: absence of its prompt-footer slot is not treated as plugin failure, and the trace does not prove completed registration.
- A separate isolated preflight used static `agents.orchestrator.model = openai/gpt-4.1-mini` metadata and an owned private server. Its read-only `GET /api/agent` did not return a successful response (curl exit **22**), so it sent no `POST /api/session`. A subsequent attempt to execute the controller-authorized disposable fixture-session procedure was blocked by CC Safety Net because it could not verify the shell-command source. Per that denial, the command was not retried or restructured to bypass the guard; no fixture session was created. The documented non-generating session API path is therefore not yet verified against this image.
- Actual provider-indicator/Herdr CLI activation remains a mandatory unresolved gate for controller re-review. The real `.env` selector-override fixture remains blocked by the separate Safety Net denial (`secret.basename.env`) and was not retried or bypassed. No host config/plugin source, host session, credential, host listener, or database was modified or contacted in this round.
