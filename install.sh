#!/bin/sh
set -eu

# Redwake Agent is published from redwake-agent and installed as `rwa`.
REPO="kvxi/redwake-agent"
BIN="rwa"
DIR="${REDWAKE_AGENT_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported arch" >&2; exit 1 ;;
esac

asset="$BIN-$os-$arch.tar.gz"
url="https://github.com/$REPO/releases/latest/download/$asset"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$asset"
tar -xzf "$tmp/$asset" -C "$tmp"

mkdir -p "$DIR"
install -m 755 "$tmp/$BIN" "$DIR/$BIN"

echo "installed $DIR/$BIN"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "not on PATH — add: export PATH=\"$DIR:\$PATH\"" ;;
esac
