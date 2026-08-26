#!/bin/sh
set -eu

repository=${AMBER_REPOSITORY:-tpolasek/amber}
install_directory=${AMBER_INSTALL_DIR:-"$HOME/.local/bin"}
version=${AMBER_VERSION:-latest}

case "$(uname -s)" in
  Darwin)
    artifact=amber-macos
    case "$(uname -m)" in
      arm64) ;;
      *) echo "Amber currently provides its macOS binary for Apple Silicon only." >&2; exit 1 ;;
    esac
    ;;
  Linux)
    artifact=amber-linux
    case "$(uname -m)" in
      x86_64|amd64) ;;
      *) echo "Amber currently provides its Linux binary for x86_64 only." >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Amber supports Linux and macOS only." >&2
    exit 1
    ;;
esac

temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/amber-install.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
downloaded_binary="$temporary_directory/$artifact"

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
if [ -n "$script_directory" ] && [ -f "$script_directory/release/$artifact" ]; then
  source_binary="$script_directory/release/$artifact"
elif [ -n "$script_directory" ] && [ -f "$script_directory/$artifact" ]; then
  source_binary="$script_directory/$artifact"
else
  if [ "$version" = latest ]; then
    download_url="https://github.com/$repository/releases/latest/download/$artifact"
  else
    download_url="https://github.com/$repository/releases/download/$version/$artifact"
  fi

  echo "Downloading $artifact from $download_url"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "$download_url" --output "$downloaded_binary"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$download_url" -O "$downloaded_binary"
  else
    echo "Install curl or wget and run this installer again." >&2
    exit 1
  fi
  source_binary=$downloaded_binary
fi

mkdir -p "$install_directory"
install -m 755 "$source_binary" "$install_directory/amber"
echo "Amber installed at $install_directory/amber"

case ":$PATH:" in
  *":$install_directory:"*) ;;
  *)
    printf "%s is not on your PATH. Add it automatically? [y/N] " "$install_directory"
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|Yes|YES)
        case "${SHELL:-}" in
          */zsh) shell_config=$HOME/.zshrc ;;
          */bash) shell_config=$HOME/.bashrc ;;
          *) shell_config=$HOME/.profile ;;
        esac
        {
          printf '\n# Added by Amber installer\n'
          printf 'export PATH="%s:$PATH"\n' "$install_directory"
        } >> "$shell_config"
        echo "Added $install_directory to PATH in $shell_config"
        echo "Restart your shell, or run: export PATH=\"$install_directory:\$PATH\""
        ;;
      *)
        echo "Add $install_directory to PATH, then run: amber"
        ;;
    esac
    ;;
esac
