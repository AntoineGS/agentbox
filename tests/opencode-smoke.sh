#!/usr/bin/env bash
set -euo pipefail

smoke_error() {
    printf 'OpenCode smoke check failed: %s\n' "$1" >&2
    exit 1
}

required_plugins=()
required_agents=()
required_skills=()
required_commands=()
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
        --require-agent|--require-skill|--require-command)
            option=$1
            shift
            [[ $# -gt 0 && -n "$1" && "$1" != --* ]] || smoke_error "Missing value for $option"
            case "$option" in
                --require-agent) required_agents+=("$1") ;;
                --require-skill) required_skills+=("$1") ;;
                --require-command) required_commands+=("$1") ;;
            esac
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
command -v curl >/dev/null 2>&1 || smoke_error 'curl is unavailable.'

umask 077
workspace_parent="${TMPDIR:-/tmp}/opencode"
mkdir -p "$workspace_parent"
workspace=$(mktemp -d "$workspace_parent/agentbox-smoke.XXXXXX") || smoke_error 'Could not create private smoke workspace.'
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
printf 'user = "opencode:%s"\n' "$OPENCODE_PASSWORD" >"$workspace/api-auth.conf"

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
catalog_readiness_floor=$((SECONDS + 3))

api_get() {
    local endpoint=$1 remaining=$((deadline - SECONDS))
    ((remaining > 0)) || return 124
    timeout "${remaining}s" curl --config "$workspace/api-auth.conf" --fail --silent --show-error \
        --max-time "$remaining" "$server_url$endpoint" \
        2>>"$workspace/server.log"
}

expected_location=$(pwd -P)
plugins_json=
agents_json=
skills_json=
commands_json=
models_json=
mcps_json=

fetch_catalog() {
    local endpoint=$1 response request_status
    if response=$(api_get "/api/$endpoint"); then
        :
    else
        request_status=$?
        [[ "$request_status" == 124 ]] && return 124
        smoke_error "API catalog request failed: /api/$endpoint (exit status: $request_status)."
    fi
    validate_json "/api/$endpoint" "$response"
    local location_shape data_shape api_error
    location_shape=$(jq -r 'if (.location | type) != "object" then "missing" elif (.location.directory | type) == "string" then "directory" else "invalid" end' \
        2>/dev/null <<<"$response" || printf '%s' invalid)
    data_shape=$(jq -r 'if (.data | type) == "array" then "array" else (.data | type) end' \
        2>/dev/null <<<"$response" || printf '%s' invalid)
    api_error=$(jq -r 'if (.error | type) == "object" then (.error.name // "present") else "none" end | if test("^[A-Za-z][A-Za-z0-9]{0,63}$") then . else "present" end' \
        2>/dev/null <<<"$response" || printf '%s' unknown)
    if [[ "$location_shape" != directory || "$data_shape" != array ]]; then
        smoke_error "Invalid API catalog response: /api/$endpoint (location: $location_shape, data: $data_shape, API error: $api_error)"
    fi
    jq -e --arg expected "$expected_location" '.location.directory == $expected' \
        >/dev/null 2>&1 <<<"$response" || smoke_error "API catalog location mismatch: /api/$endpoint"
    case "$endpoint" in
        plugin) plugins_json=$response ;;
        agent) agents_json=$response ;;
        skill) skills_json=$response ;;
        command) commands_json=$response ;;
        model) models_json=$response ;;
        mcp) mcps_json=$response ;;
    esac
}

refresh_catalogs() {
    local endpoint
    for endpoint in plugin agent skill command model mcp; do
        fetch_catalog "$endpoint" || return $?
    done
}

validate_json() {
    local endpoint=$1 response=$2 response_type api_error response_class
    if ! jq -e 'type == "object" or type == "array"' >/dev/null 2>&1 <<<"$response"; then
        response_type=$(jq -r 'type' 2>/dev/null <<<"$response" || printf '%s' invalid)
        if [[ -z "$response" ]]; then response_class=empty
        elif [[ "$response" == \{* || "$response" == \[* ]]; then response_class=structured-but-invalid
        else response_class=non-container
        fi
        api_error=$(jq -r 'if (.error | type) == "object" then (.error.name // "present") else "none" end | if test("^[A-Za-z][A-Za-z0-9]{0,63}$") then . else "present" end' \
            2>/dev/null <<<"$response" || printf '%s' unknown)
        smoke_error "Invalid API response: $endpoint (class: $response_class, JSON type: $response_type, API error: $api_error)"
    fi
}

while ((SECONDS < catalog_readiness_floor && SECONDS < deadline)); do
    sleep 0.3
done

if response=$(api_get /api/info); then
    :
else
    request_status=$?
    smoke_error "API request failed: /api/info (exit status: $request_status)"
fi
validate_json /api/info "$response"
printf 'Verified API endpoint: info\n'

plugin_is_active() {
    jq -e --arg value "$1" \
        'def source_matches($source): $source == $value or (($value | startswith("/")) and (($value | rtrimstr("/")) != "") and ($source | type == "string") and ($source | startswith((($value | rtrimstr("/")) + "/")))); def matches: .id == $value or source_matches(.source.path) or source_matches(.source.target); any(.data[]?; matches and .state.status == "active")' \
        >/dev/null 2>&1 <<<"$plugins_json"
}

plugin_status() {
    jq -r --arg value "$1" \
        'def source_matches($source): $source == $value or (($value | startswith("/")) and (($value | rtrimstr("/")) != "") and ($source | type == "string") and ($source | startswith((($value | rtrimstr("/")) + "/")))); def matches: .id == $value or source_matches(.source.path) or source_matches(.source.target); ([.data[]? | select(matches)] | first) as $plugin | if $plugin == null then "missing" elif $plugin.state.status == "active" or $plugin.state.status == "pending" or $plugin.state.status == "failed" or $plugin.state.status == "disabled" or $plugin.state.status == "installing" or $plugin.state.status == "loading" then $plugin.state.status else "unknown" end' \
        2>/dev/null <<<"$plugins_json" || printf '%s' unknown
}

catalog_has_entry() {
    jq -e --arg value "$2" \
        'any(.data[]?; .id == $value or .name == $value)' \
        >/dev/null 2>&1 <<<"$1"
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
    for name in "${required_agents[@]}"; do
        catalog_has_entry "$agents_json" "$name" || return 1
    done
    for name in "${required_skills[@]}"; do
        catalog_has_entry "$skills_json" "$name" || return 1
    done
    for name in "${required_commands[@]}"; do
        catalog_has_entry "$commands_json" "$name" || return 1
    done
    for name in "${required_mcps[@]}"; do
        mcp_has_status "$name" connected || return 1
    done
    for name in "${disabled_mcps[@]}"; do
        mcp_has_status "$name" disabled || return 1
    done
}

has_requirements=0
if (( ${#required_plugins[@]} + ${#required_agents[@]} + ${#required_skills[@]} +
    ${#required_commands[@]} + ${#required_mcps[@]} + ${#disabled_mcps[@]} > 0 )); then
    has_requirements=1
fi

if refresh_catalogs; then
    :
else
    request_status=$?
    [[ "$request_status" == 124 ]] && smoke_error 'Timed out refreshing API catalogs.'
    smoke_error 'Could not refresh API catalogs.'
fi

final_snapshot_complete=0
if ((has_requirements)); then
    while ((SECONDS < deadline)); do
        if ((SECONDS >= catalog_readiness_floor)) && requirements_ready; then
            if refresh_catalogs; then
                if requirements_ready; then
                    final_snapshot_complete=1
                    break
                fi
            else
                request_status=$?
                [[ "$request_status" == 124 ]] && break
                smoke_error 'Could not refresh API catalogs.'
            fi
        fi
        ((SECONDS < deadline)) || break
        sleep 0.3
        if refresh_catalogs; then
            :
        else
            request_status=$?
            [[ "$request_status" == 124 ]] && break
            smoke_error 'Could not refresh API catalogs.'
        fi
    done
    if ((!final_snapshot_complete)); then
        for name in "${required_plugins[@]}"; do
            if ! plugin_is_active "$name"; then
                status=$(plugin_status "$name")
                printf 'Required plugin is not active: %s (status: %s)\n' "$name" "$status" >&2
            fi
        done
        for name in "${required_agents[@]}"; do
            catalog_has_entry "$agents_json" "$name" ||
                printf 'Required agent is missing: %s\n' "$name" >&2
        done
        for name in "${required_skills[@]}"; do
            catalog_has_entry "$skills_json" "$name" ||
                printf 'Required skill is missing: %s\n' "$name" >&2
        done
        for name in "${required_commands[@]}"; do
            catalog_has_entry "$commands_json" "$name" ||
                printf 'Required command is missing: %s\n' "$name" >&2
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
        smoke_error 'Requested integrations did not reach their expected states within the readiness deadline.'
    fi
else
    if refresh_catalogs; then
        :
    else
        request_status=$?
        [[ "$request_status" == 124 ]] && smoke_error 'Timed out refreshing API catalogs.'
        smoke_error 'Could not refresh API catalogs.'
    fi
fi

printf 'Verified catalog location: %s\n' 'current working directory'
for endpoint in plugin agent skill command model mcp; do
    case "$endpoint" in
        plugin) response=$plugins_json ;;
        agent) response=$agents_json ;;
        skill) response=$skills_json ;;
        command) response=$commands_json ;;
        model) response=$models_json ;;
        mcp) response=$mcps_json ;;
    esac
    catalog_count=$(jq -r '.data | length' <<<"$response")
    printf 'Verified API endpoint: %s (%s entries)\n' "$endpoint" "$catalog_count"
done

for name in "${required_plugins[@]}"; do
    printf 'Verified plugin: %s (active)\n' "$name"
done
for name in "${required_agents[@]}"; do
    printf 'Verified agent: %s (present)\n' "$name"
done
for name in "${required_skills[@]}"; do
    printf 'Verified skill: %s (present)\n' "$name"
done
for name in "${required_commands[@]}"; do
    printf 'Verified command: %s (present)\n' "$name"
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
