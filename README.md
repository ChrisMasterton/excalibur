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

## Workspaces, Tabs, Recents, and Projects

- **Excalidraw** and **Mermaid** are two always-mounted workspaces; switching between them keeps the canvas and editor state intact. The sidebar buttons jump to the most recent tab of that kind (or start an empty one).
- **Tabs** hold every open document. Opening a Recent item, a project file, a dropped or double-clicked file, `Open…`, `New drawing`, and *Convert to Excalidraw* all add a tab (or re-activate the one that already has that file) instead of replacing what you were working on. An untouched blank tab is taken over rather than left behind, so opening a file on a fresh launch gives you one tab, not two. Unsaved edits stay with their tab, so switching never prompts; only closing a dirty tab or quitting does.
- Tab shortcuts: middle-click or ✕ closes, right-click offers *Close / Close others / Close all*, `Cmd/Ctrl+W` closes the active tab, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle, and `Cmd/Ctrl+1`…`9` jump to a tab. Open files are marked in Recent/Projects, with the active one highlighted.
- The tabs you had open are reopened on the next launch (paths only, never contents); files that have gone missing are skipped.
- The toolbar title is the file name. Click it to rename (the file is renamed on disk when one is loaded); `Cmd/Ctrl+S` saves and `Cmd/Ctrl+O` opens in the active workspace.
- **Convert to Excalidraw** loads the Mermaid diagram onto the canvas as an unsaved drawing, measured with the real Excalidraw fonts so labels fit their boxes. **Refit text** in the Excalidraw toolbar applies the same pass to drawings converted earlier.
- Mermaid files can carry a display title in YAML frontmatter (`---\ntitle: Auth flow\n---`). It shows beside the file name in the toolbar, becomes the display name in Recent/Projects, and seeds the drawing name when converting an unnamed diagram.
- **Recent** lists the last 10 files. Right-click (or the `…` button) to move a file into a project or remove it from the list.
- **Projects** are plain folders. *Add project folder…* registers a folder (the picker can create one), and every `.excalidraw`, `.mmd`, or `.mermaid` file inside it (up to four levels deep) appears under the project. *Open all diagrams* (the folder button on the project row, or the right-click menu) opens the whole project as tabs in one go without filling up Recent. Rename a project to rename the folder; *Remove from projects* only forgets the folder and never deletes files. Dropping a folder onto the window registers it too.

## Settings

The gear button in the sidebar (or `Cmd/Ctrl+,`) opens global settings: Mermaid preview zoom speed, scroll-wheel behaviour (pan vs zoom), whether *Fit to window* may enlarge small diagrams, editor font size, how many recent files to keep, and project scan depth. They are stored in `settings.json` in the app data folder, so every Excalibur window and instance shares them.

## File Associations

Excalibur registers as the handler for `.excalidraw` files, so you can double-click them to open directly in the app.

## Project Structure

```
frontend/       React + Vite frontend (Excalidraw, Mermaid)
  src/components/   Sidebar, toolbar, workspaces, context menu, zoom/pan viewport
  src/lib/          Tauri command wrappers, Mermaid conversion, text refit, helpers
src-tauri/      Tauri 2 backend (Rust): file dialogs, recents, projects (projects.json)
install.sh      Build & install script
run.sh          Launch a release build
install.ps1     Windows build & install script
run.ps1         Windows launch script
```

## License

[Unlicense](LICENSE) -- public domain.
