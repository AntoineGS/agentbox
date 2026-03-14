# Review Scope

## Target

Full agentbox codebase - a Bash-based tool that creates ephemeral Docker/Podman containers for Claude Code development. Recently refactored to decompose a 211-line function and fix a variable scoping bug, plus added support for concurrent sessions.

## Files

- `agentbox` - Main script (~730 lines, Bash 4+): CLI parsing, rebuild detection, container lifecycle, mount management
- `Dockerfile` - Container image build (~242 lines): Debian trixie, multi-language toolchains
- `entrypoint.sh` - Container entrypoint (~88 lines): environment setup, tool updates, SSH permissions

## Flags

- Security Focus: no
- Performance Critical: no
- Strict Mode: no
- Framework: bash/docker

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
