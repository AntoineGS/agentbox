#!/usr/bin/env bash
set -euo pipefail

smoke_error() {
    printf 'OpenCode smoke check failed: %s\n' "$1" >&2
    exit 1
}

required_plugins=()
required_mcps=()
disabled_mcps=()
meridian_url=
while (($#)); do
    case "$1" in
        --require-plugin)
            option=$1
            shift
            [[ $# -gt 0 && -n "$1" && "$1" != --* ]] || smoke_error "Missing value for $option"
            required_plugins+=("$1")
            shift
            ;;
        --require-mcp)
            option=$1
            shift
            [[ $# -gt 0 && -n "$1" && "$1" != --* ]] || smoke_error "Missing value for $option"
            required_mcps+=("$1")
            shift
            ;;
        --disabled-mcp)
            option=$1
            shift
            [[ $# -gt 0 && -n "$1" && "$1" != --* ]] || smoke_error "Missing value for $option"
            disabled_mcps+=("$1")
            shift
            ;;
        --meridian-url)
            option=$1
            shift
            [[ -z "$meridian_url" ]] || smoke_error "Duplicate option: $option"
            [[ $# -gt 0 && -n "$1" && "$1" != --* ]] || smoke_error "Missing value for $option"
            meridian_url=$1
            shift
            ;;
        *) smoke_error "Unknown option: $1" ;;
    esac
done

[[ "${TOOL:-}" == opencode ]] || smoke_error 'Run this check in an OpenCode-selected AgentBox shell.'
unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$repo/agentbox"

expected_version="${AGENTBOX_OPENCODE_VERSION:-}"
[[ -n "$expected_version" ]] || smoke_error 'AgentBox OpenCode version selector is missing.'
if ! version_output=$(opencode --version 2>/dev/null); then
    smoke_error 'Could not read the OpenCode version.'
fi
if ! actual_version=$(parse_opencode_version "$version_output"); then
    smoke_error 'Could not parse the OpenCode version.'
fi
if [[ "$expected_version" == 2 ]]; then
    [[ "$actual_version" == 2.* ]] || smoke_error 'OpenCode version does not match AgentBox selection.'
elif [[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    [[ "$actual_version" == "$expected_version" ]] || smoke_error 'OpenCode version does not match AgentBox selection.'
else
    smoke_error 'AgentBox OpenCode version selector is invalid.'
fi

[[ -n "${HOME:-}" && "${XDG_STATE_HOME:-}" == "$HOME/.local/state" ]] ||
    smoke_error 'OpenCode container-local state is not selected.'
[[ "${OPENCODE_CONFIG_DIR:-}" == "$HOME/.config/opencode" ]] ||
    smoke_error 'OpenCode shared configuration is not selected.'
command -v jq >/dev/null 2>&1 || smoke_error 'jq is unavailable.'
command -v node >/dev/null 2>&1 || smoke_error 'Node.js is unavailable.'
command -v timeout >/dev/null 2>&1 || smoke_error 'timeout is unavailable.'
if [[ -n "$meridian_url" ]]; then
    command -v curl >/dev/null 2>&1 || smoke_error 'curl is unavailable.'
fi

umask 077
mkdir -p /tmp/opencode
workspace=$(mktemp -d /tmp/opencode/agentbox-smoke.XXXXXX) || smoke_error 'Could not create private smoke workspace.'
server_pid=
cleanup() {
    if [[ -n "$server_pid" ]]; then
        if kill -0 "$server_pid" 2>/dev/null; then
            kill "$server_pid" 2>/dev/null || true
        fi
        wait "$server_pid" 2>/dev/null || true
    fi
    if [[ -n "$workspace" ]]; then
        rm -rf -- "$workspace"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset OPENCODE_SERVER_PASSWORD
test_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' 2>/dev/null) ||
    smoke_error 'Could not create private test authentication.'
export OPENCODE_PASSWORD="$test_password"
unset test_password

opencode serve --hostname 127.0.0.1 --port 0 >"$workspace/server.log" 2>&1 &
server_pid=$!
deadline=$((SECONDS + 120))
server_url=
while ((SECONDS < deadline)); do
    kill -0 "$server_pid" 2>/dev/null || smoke_error 'Private OpenCode server stopped during startup.'
    if candidate=$(grep -Eo 'http://127[.]0[.]0[.]1:[0-9]+' "$workspace/server.log" | head -n 1); then
        if [[ -n "$candidate" ]]; then
            server_url=$candidate
            break
        fi
    fi
    sleep 0.2
done
[[ -n "$server_url" ]] || smoke_error 'Timed out waiting for the private OpenCode server.'

api_get() {
    local endpoint=$1 remaining=$((deadline - SECONDS))
    ((remaining > 0)) || return 124
    timeout "${remaining}s" opencode api --server "$server_url" get "$endpoint" \
        2>>"$workspace/server.log"
}

validate_json() {
    local endpoint=$1 response=$2
    if ! jq -e 'type == "object" or type == "array"' >/dev/null 2>&1 <<<"$response"; then
        smoke_error "Invalid API response: $endpoint"
    fi
}

plugins_json=
mcps_json=
for endpoint in info plugin agent skill command model mcp; do
    api_path="/api/$endpoint"
    if response=$(api_get "$api_path"); then
        :
    else
        request_status=$?
        smoke_error "API request failed: $api_path (exit status: $request_status)"
    fi
    validate_json "$api_path" "$response"
    case "$endpoint" in
        plugin)
            plugins_json=$response
            ;;
        mcp)
            jq -e '.data | type == "array"' >/dev/null 2>&1 <<<"$response" ||
                smoke_error 'Invalid MCP catalog response.'
            mcps_json=$response
            ;;
    esac
    if [[ "$endpoint" == info ]]; then
        printf 'Verified API endpoint: %s\n' "$endpoint"
    else
        jq -e '.data | type == "array"' >/dev/null 2>&1 <<<"$response" ||
            smoke_error "Invalid API catalog response: /api/$endpoint"
        catalog_count=$(jq -r '.data | length' <<<"$response")
        printf 'Verified API endpoint: %s (%s entries)\n' "$endpoint" "$catalog_count"
    fi
done

plugin_is_active() {
    jq -e --arg value "$1" \
        'any(.data[]?; (.id == $value or .source.path == $value or .source.target == $value) and .state.status == "active")' \
        >/dev/null 2>&1 <<<"$plugins_json"
}

plugin_status() {
    jq -r --arg value "$1" \
        '([.data[]? | select(.id == $value or .source.path == $value or .source.target == $value)] | first) as $plugin | if $plugin == null then "missing" elif $plugin.state.status == "active" or $plugin.state.status == "pending" or $plugin.state.status == "failed" or $plugin.state.status == "disabled" or $plugin.state.status == "installing" or $plugin.state.status == "loading" then $plugin.state.status else "unknown" end' \
        2>/dev/null <<<"$plugins_json" || printf '%s' unknown
}

mcp_has_status() {
    jq -e --arg name "$1" --arg status "$2" \
        'any(.data[]?; .name == $name and .status.status == $status)' \
        >/dev/null 2>&1 <<<"$mcps_json"
}

mcp_status() {
    jq -r --arg name "$1" \
        '([.data[]? | select(.name == $name)] | first) as $record | if $record == null then "missing" elif $record.status.status == "connected" or $record.status.status == "pending" or $record.status.status == "disabled" or $record.status.status == "failed" or $record.status.status == "needs_auth" then $record.status.status else "unknown" end' \
        2>/dev/null <<<"$mcps_json" || printf '%s' unknown
}

requirements_ready() {
    local name
    for name in "${required_plugins[@]}"; do
        plugin_is_active "$name" || return 1
    done
    for name in "${required_mcps[@]}"; do
        mcp_has_status "$name" connected || return 1
    done
    for name in "${disabled_mcps[@]}"; do
        mcp_has_status "$name" disabled || return 1
    done
}

if (( ${#required_plugins[@]} + ${#required_mcps[@]} + ${#disabled_mcps[@]} > 0 )); then
    while ! requirements_ready; do
        ((SECONDS < deadline)) || break
        sleep 0.3
        if (( ${#required_plugins[@]} )); then
            if refreshed_plugins=$(api_get /api/plugin); then
                plugins_json=$refreshed_plugins
            else
                request_status=$?
                [[ "$request_status" == 124 ]] && break
                smoke_error "Plugin catalog request failed (exit status: $request_status)."
            fi
            validate_json /api/plugin "$plugins_json"
        fi
        if (( ${#required_mcps[@]} + ${#disabled_mcps[@]} )); then
            if refreshed_mcps=$(api_get /api/mcp); then
                mcps_json=$refreshed_mcps
            else
                request_status=$?
                [[ "$request_status" == 124 ]] && break
                smoke_error "MCP catalog request failed (exit status: $request_status)."
            fi
            validate_json /api/mcp "$mcps_json"
        fi
    done
    if ! requirements_ready; then
        for name in "${required_plugins[@]}"; do
            if ! plugin_is_active "$name"; then
                status=$(plugin_status "$name")
                printf 'Required plugin is not active: %s (status: %s)\n' "$name" "$status" >&2
            fi
        done
        for name in "${required_mcps[@]}"; do
            if ! mcp_has_status "$name" connected; then
                status=$(mcp_status "$name")
                printf 'Required MCP is not connected: %s (status: %s)\n' "$name" "$status" >&2
            fi
        done
        for name in "${disabled_mcps[@]}"; do
            if ! mcp_has_status "$name" disabled; then
                status=$(mcp_status "$name")
                printf 'Expected MCP to be disabled: %s (status: %s)\n' "$name" "$status" >&2
            fi
        done
        smoke_error 'Requested integrations did not reach their expected states.'
    fi
fi

for name in "${required_plugins[@]}"; do
    printf 'Verified plugin: %s (active)\n' "$name"
done
for name in "${required_mcps[@]}"; do
    printf 'Verified MCP: %s (connected)\n' "$name"
done
for name in "${disabled_mcps[@]}"; do
    printf 'Verified disabled MCP: %s\n' "$name"
done

if [[ -n "$meridian_url" ]]; then
    if ! curl --fail --silent --connect-timeout 3 --max-time 5 "$meridian_url" \
        2>>"$workspace/server.log" | jq -e '.data | type == "array" and length > 0' >/dev/null 2>&1; then
        smoke_error 'Meridian catalog request failed.'
    fi
    printf '%s\n' 'Verified Meridian model catalog.'
fi

if [[ "${HERDR_ENV:-}" == 1 ]]; then
    [[ -S "${HERDR_SOCKET_PATH:-}" ]] || smoke_error 'Herdr socket is unavailable.'
    if ! node -e '
const socket = require("node:net").createConnection(process.argv[1]);
socket.setTimeout(3000, () => { process.exitCode = 1; socket.destroy(); });
socket.once("error", () => { process.exitCode = 1; });
socket.once("connect", () => { socket.end(); });
' "$HERDR_SOCKET_PATH" >/dev/null 2>>"$workspace/server.log"; then
        smoke_error 'Herdr socket connection failed.'
    fi
    printf '%s\n' 'Verified Herdr socket connection without an RPC request.'
fi
