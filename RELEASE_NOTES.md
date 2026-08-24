# Release Notes

## Sticky symbol highlight across tabs - 2026-08-23
- The symbol you click stays **active** for as long as the references panel is open, and is marked in whatever document you move to next - a tab click, `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Cmd/Ctrl+1`…`9`, or a file in the sidebar. Walking a project's diagrams now shows you the same thing in each of them without touching the panel.
- Documents that never mention the symbol just show nothing: no marks, no message.
- A plain tab switch only marks; it never pans or zooms, so the per-tab viewport you left a diagram at is exactly what you come back to. Choosing a document in the panel is still the deliberate act that reveals its match.
- Picking another symbol replaces the active one everywhere. Closing the panel (✕, or the second Escape) clears the marks from every document that was walked through, and a press in the Mermaid preview no longer drops the active symbol's marks.
- Editing a highlighted Mermaid diagram re-marks the freshly rendered SVG if the symbol still resolves, and drops the marks silently if it no longer does.
- Highlights are strictly presentation: the Excalidraw side is selection-only, applied with `CaptureUpdateAction.NEVER` and invisible to `serializeAsJSON` (which drops `selectedElementIds`), so a highlighted drawing never goes dirty, never enters undo history, and never changes what is saved. The Mermaid PNG export rasterises the SVG Mermaid rendered rather than the live preview, so it comes out byte for byte identical whether or not the diagram is highlighted.

## Per-tab viewports - 2026-08-23
- Scroll position and zoom now belong to the tab. Switching away and back returns you to exactly what you were looking at, in both workspaces; one tab's zoom no longer leaks into the next.
- Excalidraw's `serializeAsJSON` deliberately drops scroll and zoom, so the canvas viewport is now read straight from the live app state when a tab is put aside, and re-applied once the canvas is back on screen and measured. Mermaid preview tabs stash the preview's pan/zoom the same way, including whether it is still auto-fitting.

## Reading mode and symbol references - 2026-08-23
- Diagrams are for reading first: every file opened from disk now lands in **Viewing** mode, with a slim toolbar (mode toggle, Open, Fit to window, Export PNG, and Convert for Mermaid), a read-only file name, the Mermaid code pane closed, and the Excalidraw canvas in view + zen mode.
- The mode is a labelled toggle in both toolbars that says which mode you are in - **Editing** or **Viewing** - and belongs to the tab, so cycling tabs never changes anyone's mode. `Cmd/Ctrl+Shift+E` flips it (plain `E` is still Excalidraw's eraser). Hiding the code pane in view mode remembers your own Hide-code preference for when you come back.
- New drawings, Mermaid → Excalidraw conversions, and recovered autosave backups still open ready to edit.
- **Clicking a symbol** now answers "where else is this?": click a node in the Mermaid preview, or a labelled shape on the Excalidraw canvas while viewing, and a references panel lists every diagram in the same project that mentions it. Clicking an entry opens that document with its matches highlighted and leaves the panel open, so a symbol can be followed across a whole project.
- Escape peels one layer at a time - the highlight first, then the panel. Clicking empty space does nothing, and a diagram outside every registered project says so rather than listing nothing.

## Find in project, and Mermaid PNG export - 2026-08-23
- **Find in project**: a search field above the project list indexes every diagram in every registered project and groups what it finds by *symbol*, so the ER entity `USER`, the class `User`, and the sequence participant `User` are one entry with the documents that mention them.
- Symbols come from Mermaid's own parser rather than a regex: class names and their members/methods, ER entities and attributes, sequence participants, flowchart nodes (id and label), and states. Excalidraw drawings are read from their text elements; drawings Excalibur converted carry the exact symbol on each shape.
- Clicking a result opens or re-activates that document's tab and shows you the match - selected and zoomed-to on the Excalidraw canvas, outlined in the Mermaid preview. Escape or the next click in the preview clears it.
- The index builds the first time the search box is used, one file at a time so the UI stays responsive, and re-reads only files whose timestamp has changed (including the one you just saved).
- **Export PNG** in the Mermaid toolbar renders the preview at 2x on the paper background and saves it through a native dialog.
- Mermaid labels are now drawn as plain SVG text everywhere (previously only flowcharts were), which is what makes the PNG export and the highlight pass work. Class and ER diagrams look slightly different as a result.

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
