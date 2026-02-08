# Excalibur

A native macOS/Linux desktop app for viewing and editing [Excalidraw](https://excalidraw.com) drawings. Built with Tauri 2, React, and the Excalidraw component.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/)
- Tauri CLI: `cargo install tauri-cli --locked`

## Getting Started

### Install & Build

```bash
./install.sh
```

This will check prerequisites, install frontend dependencies, build the app, and install it to `/Applications` (macOS) or `~/.local/bin` (Linux).

### Development

```bash
cd frontend && npm install   # install frontend deps (first time)
cd src-tauri && cargo tauri dev   # run the app in dev mode
```

### Run a Release Build

```bash
./run.sh
```

Opens the built `.app` bundle from `src-tauri/target/release/bundle/macos/`.

## File Associations

Excalibur registers as the handler for `.excalidraw` files, so you can double-click them to open directly in the app.

## Project Structure

```
frontend/       React + Vite frontend (Excalidraw, Mermaid)
src-tauri/      Tauri 2 backend (Rust)
install.sh      Build & install script
run.sh          Launch a release build
```

## License

[Unlicense](LICENSE) -- public domain.
