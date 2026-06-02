# Excalibur

A native macOS, Linux, and Windows desktop app for viewing and editing [Excalidraw](https://excalidraw.com) drawings. Built with Tauri 2, React, and the Excalidraw component.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/)
- Tauri CLI: `cargo install tauri-cli --locked`
- Windows only: Microsoft C++ Build Tools and Microsoft Edge WebView2 runtime

## Getting Started

### Install & Build

macOS/Linux:

```bash
./install.sh
```

Windows PowerShell:

```powershell
.\install.ps1
```

If PowerShell blocks local scripts, run `powershell -ExecutionPolicy Bypass -File .\install.ps1` from the repo root.

These scripts check prerequisites, install frontend dependencies, build the app, and install it to `/Applications` (macOS), `~/.local/bin` (Linux), or the Windows installer/default local app directory.

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

On Windows:

```powershell
.\run.ps1
```

## Mermaid CLI Conversion

Excalibur includes an mmdc-like command for rendering Mermaid files without installing Mermaid CLI:

```bash
cd frontend
npm install
npm run mmdc:install   # first time only; installs Chromium for Playwright
npm --silent run mmdc -- -i docs/registration-auth-flow.md -o registration-auth-flow.md
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
install.ps1     Windows build & install script
run.ps1         Windows launch script
```

## License

[Unlicense](LICENSE) -- public domain.
