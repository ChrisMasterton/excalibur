#!/bin/bash

# Excalibur Install Script
# Builds and installs the Excalibur application

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin)
        PLATFORM="macos"
        INSTALL_DIR="/Applications"
        APP_NAME="Excalibur.app"
        ;;
    Linux)
        PLATFORM="linux"
        INSTALL_DIR="$HOME/.local/bin"
        APP_NAME="excalibur"
        ;;
    *)
        error "Unsupported operating system: $OS"
        ;;
esac

info "Detected platform: $PLATFORM"

check_prerequisites() {
    info "Checking prerequisites..."

    if ! command -v node &> /dev/null; then
        error "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/"
    fi
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        error "Node.js 18+ is required. Current version: $(node -v)"
    fi
    success "Node.js $(node -v) found"

    if ! command -v npm &> /dev/null; then
        error "npm is not installed"
    fi
    success "npm $(npm -v) found"

    if ! command -v rustc &> /dev/null; then
        error "Rust is not installed. Please install Rust from https://rustup.rs/"
    fi
    success "Rust $(rustc --version | cut -d' ' -f2) found"

    if ! command -v cargo &> /dev/null; then
        error "Cargo is not installed"
    fi
    success "Cargo found"

    if ! cargo tauri --version &> /dev/null; then
        error "Tauri CLI is not installed. Run: cargo install tauri-cli --locked"
    fi
    success "Tauri CLI found"

    if [ "$PLATFORM" = "linux" ]; then
        MISSING_DEPS=""
        for pkg in libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev; do
            if ! dpkg -l | grep -q "$pkg"; then
                MISSING_DEPS="$MISSING_DEPS $pkg"
            fi
        done
        if [ -n "$MISSING_DEPS" ]; then
            warn "Missing dependencies:$MISSING_DEPS"
            info "Install with: sudo apt install$MISSING_DEPS"
            read -t 0.1 -n 10000 discard 2>/dev/null || true
            read -p "Do you want to continue anyway? (y/N) " -r REPLY </dev/tty
            if [[ ! $REPLY =~ ^[Yy] ]]; then
                exit 1
            fi
        fi
    fi
}

install_dependencies() {
    info "Installing frontend dependencies..."
    (cd frontend && npm install)
    success "Dependencies installed"
}

build_app() {
    info "Building Excalibur (this may take a few minutes)..."

    rm -rf src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
    cargo tauri build </dev/null
    success "Build complete"
}

install_app() {
    info "Installing Excalibur..."

    if [ "$PLATFORM" = "macos" ]; then
        BUNDLE_PATH="src-tauri/target/release/bundle/macos/$APP_NAME"

        if [ ! -d "$BUNDLE_PATH" ]; then
            error "Build artifact not found at $BUNDLE_PATH"
        fi

        if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
            warn "Existing installation found at $INSTALL_DIR/$APP_NAME"
            read -t 0.1 -n 10000 discard 2>/dev/null || true
            read -p "Do you want to replace it? (y/N) " -r REPLY </dev/tty
            if [[ $REPLY =~ ^[Yy] ]]; then
                rm -rf "$INSTALL_DIR/$APP_NAME"
            else
                info "Installation cancelled"
                exit 0
            fi
        fi

        cp -R "$BUNDLE_PATH" "$INSTALL_DIR/"
        success "Installed to $INSTALL_DIR/$APP_NAME"
    elif [ "$PLATFORM" = "linux" ]; then
        BINARY_PATH="src-tauri/target/release/excalibur"
        DEB_PATH=$(find src-tauri/target/release/bundle/deb -name "*.deb" 2>/dev/null | head -1)
        APPIMAGE_PATH=$(find src-tauri/target/release/bundle/appimage -name "*.AppImage" 2>/dev/null | head -1)

        if [ -n "$DEB_PATH" ]; then
            info "Found .deb package: $DEB_PATH"
            read -t 0.1 -n 10000 discard 2>/dev/null || true
            read -p "Install .deb package system-wide? (requires sudo) (y/N) " -r REPLY </dev/tty
            if [[ $REPLY =~ ^[Yy] ]]; then
                sudo dpkg -i "$DEB_PATH"
                success "Installed system-wide via .deb package"
            fi
        elif [ -n "$APPIMAGE_PATH" ]; then
            info "Found AppImage: $APPIMAGE_PATH"
            mkdir -p "$INSTALL_DIR"
            cp "$APPIMAGE_PATH" "$INSTALL_DIR/excalibur"
            chmod +x "$INSTALL_DIR/excalibur"
            success "Installed AppImage to $INSTALL_DIR/excalibur"
        elif [ -f "$BINARY_PATH" ]; then
            mkdir -p "$INSTALL_DIR"
            cp "$BINARY_PATH" "$INSTALL_DIR/"
            chmod +x "$INSTALL_DIR/$APP_NAME"
            success "Installed binary to $INSTALL_DIR/$APP_NAME"
        else
            error "No installable artifact found"
        fi
    fi
}

main() {
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║      Excalibur Installation Script     ║"
    echo "╚════════════════════════════════════════╝"
    echo ""

    cd "$(dirname "$0")"

    check_prerequisites
    install_dependencies
    build_app
    install_app

    echo ""
    success "Excalibur has been installed successfully!"
    echo ""
    if [ "$PLATFORM" = "macos" ]; then
        info "Launch from Applications or run:"
        echo "    open -a Excalibur"
    else
        info "You can now run:"
        echo "    excalibur"
    fi
    echo ""
}

main "$@"
