#!/bin/sh
# Installs the Switchboard CLI in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/shlok1806/switchboard/main/install.sh | sh
#
# It clones (or updates) this repo into $SWITCHBOARD_HOME (default ~/.switchboard/src),
# builds the CLI, and links the global `switchboard` command to it with npm.
# Run it again to update.
set -eu

REPO_URL="${SWITCHBOARD_REPO:-https://github.com/shlok1806/switchboard.git}"
DIR="${SWITCHBOARD_HOME:-$HOME/.switchboard/src}"

fail() {
  echo "switchboard install: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is not installed."
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is not installed."
command -v npm >/dev/null 2>&1 || fail "npm is not installed."

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node.js 22 or newer is necessary. This is Node.js $(node -v)."

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  git -C "$DIR" pull --ff-only --quiet
else
  echo "Cloning $REPO_URL into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 "$REPO_URL" "$DIR"
fi

cd "$DIR/cli"
echo "Building the CLI"
npm ci --no-audit --no-fund --loglevel=error
echo "Linking the switchboard command"
npm install -g . --no-audit --no-fund --loglevel=error

echo
switchboard --help >/dev/null 2>&1 || fail "the switchboard command is not on your PATH. Add \"\$(npm prefix -g)/bin\" to PATH."
echo "Installed. Next: switchboard login --url <Channel URL>"
