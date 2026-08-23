# Release Notes

## Document tabs - 2026-08-23
- Documents now open as **tabs**: Recent items, project files, drops, file associations, `Open…`, `New drawing`, and Mermaid conversions all add a tab instead of replacing the open document. Unsaved edits travel with their tab, so switching tabs never prompts.
- Opening a file takes over an untouched blank tab instead of leaving an empty *Untitled* beside it, and *Recover backup* loads into the tab that already has that file rather than opening a second one.
- **Open all diagrams** on a project row opens every diagram in the folder at once, in parallel, without pushing them into Recent.
- Tabs can be closed with ✕, middle-click, `Cmd/Ctrl+W`, or the right-click menu (*Close / Close others / Close all*); dirty tabs still ask first, and quitting checks every tab.
- `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs and `Cmd/Ctrl+1`…`9` jump to one. Open files are marked in Recent/Projects and the active one is highlighted.
- The set of open tabs is restored on the next launch; files that no longer exist are skipped.

## Projects, icon toolbar, and better Mermaid conversion - 2026-08-23
- Mermaid conversion now measures labels with the real Excalidraw fonts and refits containers, so text no longer overflows its boxes; a **Refit text** action fixes drawings converted earlier.
- Converting loads the diagram onto the canvas (fit to view) as an unsaved drawing instead of forcing a save dialog; `<br/>` in labels becomes a line break.
- Both workspaces stay mounted, removing the reload jank when switching between Excalidraw and Mermaid.
- Mermaid preview supports zoom (pinch / Ctrl+wheel), pan (drag / scroll), fit, and a collapsible code pane.
- Sidebar has **Recent** and **Projects** tabs. Projects are folders; add, rename, or remove them, browse the diagrams inside, and move recents into a project from the right-click menu.
- Mermaid frontmatter `title:` is read from files and shown in the toolbar and in the Recent/Projects lists.
- Global settings dialog (`Cmd/Ctrl+,`) stored in `settings.json`: preview zoom speed and wheel action, fit upscaling, editor font size, recents limit, project scan depth.
- The Name/File inputs are replaced by an editable title that renames the file on disk, plus an icon toolbar (New, Open, Save, Refit text, Export PNG, Recover backup). `Cmd/Ctrl+S` and `Cmd/Ctrl+O` work in both workspaces.

## Project overview to date - 2026-05-26
- Excalibur is a native macOS/Linux desktop app for opening, editing, saving, and launching `.excalidraw` drawings.
- The Excalidraw workspace includes recent files, unsaved-change prompts, autosave recovery, PNG export, and PNG/JPEG/WebP image import.
- The Mermaid workspace lets users open, edit, preview, save, and convert Mermaid diagrams into Excalidraw drawings.
- The repository ships an `excalibur-mmdc` command for rendering raw Mermaid files or Mermaid code fences in Markdown to SVG, transformed Markdown, or inline SVG output.
- Install and run scripts support building the Tauri desktop app and installing it on macOS or Linux.
