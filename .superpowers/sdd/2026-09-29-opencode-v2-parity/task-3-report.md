# Task 3 Report: OpenCode selective mounts and private launch

## Status

**DONE_WITH_CONCERNS** — Task 3 implementation and fixture verification are complete. Real image construction and configured integration connectivity remain Task 4 work and are intentionally unverified here.

## Changes

- Added validated, destination-keyed mount registries with resolved host sources, exact lexical destinations, duplicate suppression, conflict errors, unsafe delimiter checks, broad-root protections, and read-only credential/file handling.
- Added isolated OpenCode config/data/cache mounts, host/canonical/container aliases, compatible global skill mounts, and selective ancestor/project configuration inputs. No whole-home or ancestor-repository mounts are introduced by discovery.
- Added an iterative, read-only, no-network discovery probe using a unique AgentBox-owned cache temporary directory. It accumulates manifest records across passes, mounts newly found paths read-only for subsequent scans, merges file records as read-only, validates exactly four TSV fields, checks required paths, and stops at 32 passes.
- Probe and mount failures return explicitly before the primary container `run`; stub-runtime tests confirm malformed records and missing required dependencies stop after the probe call. Probe temp directories are removed on success and failure.
- Added host networking for OpenCode (including shell mode), omitted `-p` publications with a warning, and retained Claude bridge networking/port mapping.
- Added Herdr socket-only read-only mounting at the advertised lexical path and forwards only the five approved Herdr variables. Missing sockets warn; absent Herdr context is silent. Session IDs and other arbitrary environment variables are not forwarded by this integration.
- Added explicit server-selection rejection and the `opencode --standalone` prefix. Entrypoint runtime selectors are reset for OpenCode only; host state is not mounted and container-local state directories are created.
- Updated the test harness to source the repository script directly, avoiding the Task 1 relocated-script/hash fixture weakness.

## RED / GREEN evidence

- RED: after correcting the harness to source the repository directly, the first focused `agentbox.test.cjs` run reported **19 tests, 11 passed, 8 failed**. Failures were the expected missing Task 3 interfaces and missing OpenCode entrypoint branch.
- GREEN: final `NODE_PATH=/tmp/opencode/agentbox-dev/node_modules node --test tests/*.test.cjs` reported **47 passed, 0 failed**.
- Runtime-boundary fixture checks include two-pass manifest closure, read-only credential mounts, temp cleanup, probe isolation flags, host/canonical config aliases, Herdr Unix sockets and allowlisting, argument literalness through real zsh plus a CLI shim, and preventing the main runtime launch on invalid/missing required records.

## Final checks

- `bash -n agentbox entrypoint.sh`: passed.
- `git diff --check`: passed.
- `shellcheck agentbox entrypoint.sh`: exits 1 on the recorded baseline diagnostics (agentbox SC2155/SC2034 and entrypoint SC1091/SC2166/SC2046); no new unsuppressed Task 3 diagnostics were observed.
- Installed CLI reports `opencode v2.0.19`. Read-only help checks passed for `opencode --standalone --help`, `opencode --standalone run --help`, and `opencode --standalone api --help`, verifying the root-prefix routing used by the managed command. No prompts or network requests were issued.
- No image build, real container connection, actual MCP/Herdr/host-service probe, current-doc edits, or host configuration mutation was performed; those are outside Task 3 / deferred to Task 4.

## Failure propagation and mount closure

Every probe invocation is checked; nonzero probe status, malformed TSV, invalid modes/roles/required markers/paths, missing required dependencies, `realpath` failures, and mount-registry conflicts return an error before the application container can start. Manifest paths are never evaluated as shell code. The probe uses `--network=none`, `--read-only`, all-capability drop, no-new-privileges, and read-only bind mounts; Podman receives `--userns=keep-id`. Each newly declared dependency and its canonical alias is added to probe mounts and scan roots, then discovery repeats until no destinations are added or 32 passes are reached. The final mount list is rebuilt from accumulated records, parent-first, with file roles forced read-only and existing project/additional mounts not needlessly duplicated.

## Commits

- `5d346dac725cd2bdbc47de15ec37940de3e383c0 feat: preserve OpenCode host integrations inside AgentBox`
- This report is committed separately after the implementation commit; its SHA and subject are returned in the subagent completion response.

## Concerns / boundary

- Docker/Podman runtime behavior and configured host integrations were not exercised against a real image. The stub runtime proves the Task 3 shell integration paths only; Task 4 must report actual image/connectivity failures as unverified or blocked rather than infer parity from these tests.
- Existing ShellCheck baseline warnings remain unchanged; unrelated cleanup was intentionally avoided.
