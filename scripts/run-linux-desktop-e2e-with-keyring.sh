#!/usr/bin/env bash
# Runs Electron under a private, real Secret Service. Do not replace this with
# Electron's Linux basic_text backend: desktop diagnostics must stay encrypted.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The Linux desktop keyring harness can only run on Linux." >&2
  exit 1
fi

if [[ "${1:-}" == "--" ]]; then shift; fi
if (( $# == 0 )); then
  set -- bun run --cwd apps/desktop test:e2e
fi

for required_command in base64 dbus-run-session gdbus gnome-keyring-daemon xvfb-run; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required Linux desktop harness command: $required_command" >&2
    exit 1
  fi
done

exec dbus-run-session -- bash -euo pipefail -c '
  state_directory="$(mktemp -d)"
  chmod 700 "$state_directory"
  keyring_pid=""

  cleanup() {
    if [[ -n "$keyring_pid" ]] && kill -0 "$keyring_pid" 2>/dev/null; then
      kill "$keyring_pid" 2>/dev/null || true
      wait "$keyring_pid" 2>/dev/null || true
    fi
    rm -rf "$state_directory"
  }
  trap cleanup EXIT

  export XDG_CONFIG_HOME="$state_directory/config"
  export XDG_DATA_HOME="$state_directory/data"
  export XDG_RUNTIME_DIR="$state_directory/runtime"
  export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring-control"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"
  chmod 700 "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$GNOME_KEYRING_CONTROL"

  # The password is generated in-process, passed only on stdin, and immediately unset.
  # --unlock creates or unlocks the isolated default login keyring without exposing it in argv.
  keyring_password="$(dd if=/dev/urandom bs=32 count=1 status=none | base64 -w0)"
  printf "%s" "$keyring_password" |
    gnome-keyring-daemon \
      --foreground \
      --components=secrets \
      --unlock \
      --control-directory "$GNOME_KEYRING_CONTROL" &
  keyring_pid="$!"
  unset keyring_password

  secret_service_ready=false
  for _ in {1..50}; do
    # Query the bus broker instead of introspecting the service directly.
    # Direct introspection activates the system keyring and races this isolated daemon.
    if [[ "$(gdbus call \
      --session \
      --dest org.freedesktop.DBus \
      --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.NameHasOwner \
      org.freedesktop.secrets 2>/dev/null)" == "(true,)" ]]; then
      secret_service_ready=true
      break
    fi
    if ! kill -0 "$keyring_pid" 2>/dev/null; then
      wait "$keyring_pid"
      exit 1
    fi
    sleep 0.1
  done
  if [[ "$secret_service_ready" != true ]]; then
    echo "GNOME keyring did not claim the org.freedesktop.secrets D-Bus service." >&2
    exit 1
  fi

  xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" "$@"
' -- "$@"
