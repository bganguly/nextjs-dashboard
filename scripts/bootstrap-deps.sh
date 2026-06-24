#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <tool> [tool ...]"
  echo "Supported tools: terraform aws python3"
  exit 1
fi

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then return; fi
  echo "Error: Homebrew is required for automatic installs on macOS." >&2
  echo "Install Homebrew first: https://brew.sh" >&2
  exit 1
}

install_tool_if_missing() {
  local tool="$1" binary="" formula=""
  case "$tool" in
    terraform) binary="terraform"; formula="hashicorp/tap/terraform" ;;
    aws)       binary="aws";       formula="awscli" ;;
    python3)   binary="python3";   formula="python" ;;
    *) echo "Error: unsupported tool '$tool'." >&2; exit 1 ;;
  esac

  if command -v "$binary" >/dev/null 2>&1; then echo "Found $binary"; return; fi

  if ! is_macos; then
    echo "Error: automatic install for '$tool' is macOS-only. Install it manually and retry." >&2
    exit 1
  fi

  ensure_brew
  if [[ "$tool" == "terraform" ]]; then brew tap hashicorp/tap >/dev/null; fi
  echo "Installing $tool via Homebrew..."
  brew install "$formula"
}

for tool in "$@"; do install_tool_if_missing "$tool"; done
echo "Dependency check complete."
