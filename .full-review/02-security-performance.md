# Phase 2: Security & Performance Review

## Security Findings

### Critical

1. **Supply chain -- curl-pipe-bash on every container startup** (`entrypoint.sh:63`) -- CVSS 9.1, CWE-829. Downloads and executes `claude.ai/install.sh` on every launch with `2>/dev/null` suppressing errors. A CDN compromise, DNS hijack, or MITM would execute arbitrary code with access to project files, SSH keys, API tokens, and environment variables. The `|| true` ensures the container starts even after a failed/malicious script.

2. **Command injection in admin shell mode** (`agentbox:382`) -- CVSS 8.4, CWE-78. `${args[*]}` interpolated into `bash -c` string without escaping. PoC: `agentbox shell --admin "'; cat /home/agent/.ssh/id_ed25519 #"`. The non-admin tool path already uses `printf '%q'` escaping; admin path does not.

### High

3. **SSH keys mounted read-write** (`agentbox:314`) -- CVSS 7.5, CWE-732. Container can exfiltrate, modify, or delete host SSH private keys. Contradicts AgentBox's stated purpose of making YOLO mode safer.

4. **Unpinned supply chain dependencies** (Dockerfile, 10+ locations) -- CVSS 7.3, CWE-1357. Base image not pinned by digest, 8+ curl-pipe-bash installers with no checksums, tool versions fetched from unauthenticated APIs. 48-hour rebuild cycle amplifies exposure window.

5. **Hardcoded `--dangerously-skip-permissions`** (`agentbox:393`) -- CVSS 7.1, CWE-250. No opt-out. Combined with RW project mount and SSH keys, agent has unrestricted command execution and file access.

6. **Passwordless sudo always configured** (`Dockerfile:81`) -- CVSS 6.7, CWE-269. Sudoers entry exists regardless of whether admin mode is used. AI agent can escalate to root inside container.

### Medium

7. **Overly broad path traversal regex** (`agentbox:165`) -- CWE-22. Matches `..` anywhere in string, rejecting legitimate dir names like `my..project`. Should use `(^|/)\.\.(/|$)`.

8. **HOST_HOME symlink with sudo** (`entrypoint.sh:7-10`) -- CWE-59. Creates directory at attacker-influenced path with sudo. Should validate HOST_HOME and drop sudo.

9. **Hostname injection via PROJECT_NAME** (`agentbox:511`) -- CWE-78. Directory names with spaces/special chars cause unhelpful docker errors. ANSI escape sequences in dir names would render in log output via `echo -e`.

10. **`.env` files loaded without filtering** (`agentbox:416-425`) -- CWE-526. A malicious `.env` in a cloned repo could inject `HTTP_PROXY`, `CURL_CA_BUNDLE` etc. to intercept all container traffic.

11. **AGENTBOX_EXTRA_HOSTS lacks format validation** (`agentbox:437-450`) -- CWE-20. No validation of `host:ip` format. Allows DNS override of any hostname inside container.

12. **eval of resize output** (`entrypoint.sh:69`) -- CWE-95. `eval $(resize)` executes external command output as shell code. Low practical risk but violates defense-in-depth.

### Low

13. **Build metadata in Docker labels** (`agentbox:142-144`) -- CWE-200. Minor info disclosure.
14. **GitHub Actions id-token:write permission** (`.github/workflows/claude.yml`) -- CWE-250. Any commenter can trigger @claude.
15. **Prompt injection in parallel-claude.sh** -- CWE-74. Self-injection risk only.
16. **No network isolation option** -- CWE-284. Full outbound access, no opt-in restriction.

## Performance Findings

### Critical

1. **Runtime Claude Code update on every launch** (`entrypoint.sh:63`) -- 2-8s latency per invocation. Blocks interactive prompt. Redundant with 48-hour rebuild cycle.

### High

2. **Image size ~2GB+ with full multi-language toolchain** -- 5-15min initial pull. Most users need 1-2 languages. No profile-based build system.

### Medium

3. **NVM sourcing at startup** (`entrypoint.sh:13-16`) -- 200-500ms. Could be replaced with static PATH/ENV in Dockerfile.

4. **SDKMAN sourcing at startup** (`entrypoint.sh:18-20`) -- 300-800ms. Same fix: static ENV in Dockerfile.

5. **Multiple docker inspect calls** (`agentbox:95-109`) -- 300-700ms total from 3 separate daemon calls. Could combine into single inspect.

6. **Shared cache dirs without locking** -- Multiple concurrent sessions share npm/pip/maven/gradle caches. Concurrent package installs can corrupt caches.

7. **Shared Claude config dir** -- `~/.claude` bind-mounted RW into every container. Concurrent Claude sessions may conflict.

8. **No container resource limits** -- No `--memory`, `--cpus`, or `--pids-limit`. Unbounded agent could exhaust host.

9. **Duplicate Java/Gradle installs** -- apt `default-jdk` + SDKMAN Java = two JDKs (~200-350MB wasted). apt `gradle` + SDKMAN gradle = two Gradles.

10. **stylua compiled from source** (`Dockerfile:160`) -- `cargo install stylua` takes 2-5min. Prebuilt binary available.

### Low

11. **21 RUN instructions creating 21 layers** -- Good cache granularity tradeoff but scattered `.zshrc`/`.bashrc` appends across 8+ layers make final shell state hard to audit.

12. **Version banner collection** (`entrypoint.sh:76-83`) -- 100-300ms from sequential version commands. Could prebake at build time.

13. **No cache garbage collection** -- Per-project caches at `~/.cache/agentbox/<hash>/` never cleaned up. Unbounded disk growth.

14. **No tmpfs for /tmp** -- Build tools write heavily to /tmp; tmpfs would keep this in RAM.

15. **SELinux `:z` flag on all mounts** -- First-mount relabeling can take seconds on large dirs. No-op on most non-SELinux systems.

## Critical Issues for Phase 3 Context

- **Hardcoded `--dangerously-skip-permissions`**: Testing should verify the agent cannot escape container boundaries
- **No test suite exists**: Zero automated tests for a security-critical tool
- **Supply chain**: No SBOM, no checksum verification, no reproducible builds
- **Concurrent session safety**: Shared caches and config dirs need testing under concurrent load
- **Documentation gaps**: Threat model not documented; `.env` exposure not documented
