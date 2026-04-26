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

## Mermaid CLI Conversion

Excalibur includes an mmdc-like command for rendering Mermaid files without installing Mermaid CLI:

```bash
cd frontend
npm install
npm run mmdc:install   # first time only; installs Chromium for Playwright
npm --silent run mmdc -- -i docs/registration-auth-flow.md -o /tmp/registration-auth-flow.md
npm --silent run mmdc -- -i flow.mmd -o flow.svg
```

Markdown input preserves surrounding Markdown, renders each `` ```mermaid `` code fence as a sidecar SVG next to the output Markdown, and replaces the fence with an image reference. Raw `.mmd` / `.mermaid` input writes a single SVG. Use `--input -` for stdin and `--inline-svg` to embed SVG markup directly into transformed Markdown.

On parse or render failures, the command exits nonzero and writes JSON diagnostics to stderr with the file, diagram index, line, stage, and message.

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
