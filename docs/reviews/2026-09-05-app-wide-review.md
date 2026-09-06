# Excalibur app-wide review

Reviewed 2026-09-05 against commit `42767d9` and the working tree, including the earlier sidebar cleanup. This is a source review across the app with focused runtime verification, not a claim that every native/platform workflow was exercised.

## Verdict

The product has a coherent purpose: read and edit diagrams stored in ordinary files, organize them by folder, and follow concepts across related diagrams. No major feature is clearly disposable. The significant weakness is document ownership and persistence, rather than feature count.

The small, reproducible fixes below are implemented. The remaining findings are open; this review is not a release-readiness sign-off.

## Changes made

| Finding | Change | Evidence |
| --- | --- | --- |
| Save and rename completion updated whichever tab was live, rather than the tab that started the operation. | Capture document identity before awaiting the native response. Update that document and its cache; update the live editor only when it still holds that document. | Delayed-save and delayed-rename browser scenarios reproduced incorrect target paths in both editors; regression checks now pass. |
| Save completion marked newer, unsaved edits clean. Excalidraw also replaced its cached scene with the older saved snapshot. | Advance only the saved baseline. Compare it with the current contents and retain later edits and the close confirmation. | Tests edit Mermaid text and draw an Excalidraw shape while saving, then verify closing still prompts. |
| Mermaid frontmatter could replace a user-chosen project display label. | Store the project label separately from the source title. Resolve tab labels as project label, then source title, then filename. | A file with both labels retains its project label through edits and tab switches. |
| Several branches no longer had callers. | Delete Excalidraw's unused `clean`/`keep` baseline modes, duplicated persisted-path fields, Mermaid's duplicate detach function and unused history reset action, unused symbol exports, and an unused settings-path prop. | Call-site inspection, TypeScript build, lint, existing regression suite. |
| Four native opening routes duplicated read/metadata/recent-list behavior. Text and PNG writes also had identical wrappers. | Use one native file-loading helper and one byte-compatible write helper. Remove verbose per-read success tracing. | Rust compilation/tests; frontend command contracts remain unchanged. Native dialogs were not driven. |
| File relocation still supported directory-prefix rewriting although project renaming now changes metadata and the only caller moves a single file. | Delete prefix relocation and update the matching document through its owning editor. | Call-site trace; existing project/tab tests pass. |
| Generated prompts claimed project folders were watched. Settings copy implied live synchronization between windows. | Describe the actual manual rescan and per-window settings behavior. No watcher or synchronization service added. | Source trace and prompt/browser tests. |

The combined working-tree change removes 165 net production lines, including the earlier sidebar cleanup, before counting tests and this report.

Regression coverage: [document-ownership.spec.ts](/Users/chris/Projects/excalibur/frontend/tests/document-ownership.spec.ts).

## Remaining findings, ordered by consequence

### 1. Recovery is not crash recovery for all open documents — high priority

Only one live Excalidraw scene is written to the current autosave slot. Startup loads the separate recovery slot for the recovery action, while normal scene loading replaces or clears the current slot. Inactive tabs' contents remain in memory, and Mermaid has no equivalent content backup. Session restoration persists paths only.

This means the current backup UI must not be treated as protection for all unsaved work after a crash. The smallest coherent design is recovery owned by document identity for both formats, with explicit retention/discard rules. Do not grow the current two global slots with more special cases.

Evidence: [autosave initialization](/Users/chris/Projects/excalibur/frontend/src/hooks/useExcalidrawDocument.ts:116), [current-slot writes](/Users/chris/Projects/excalibur/frontend/src/hooks/useExcalidrawDocument.ts:208), [session storage](/Users/chris/Projects/excalibur/frontend/src/hooks/useOpenDocuments.ts:85). Source-confirmed; crash/relaunch failure injection was not performed.

### 2. Other asynchronous canvas mutations still rely on the live editor — high priority

Image import awaits file/image decoding, and text refitting awaits fonts, before mutating the shared canvas. Neither operation verifies that the canvas still holds the original document. The custom image-import path also does not check the tab's viewing/editing mode before calling `updateScene`.

The save/rename fixes do not cover these operations. They need document-scoped completion or an explicit cancellation when the target changes. A generic background-job framework is unnecessary.

Evidence: [image import](/Users/chris/Projects/excalibur/frontend/src/hooks/useImageImport.ts:62), [text refit](/Users/chris/Projects/excalibur/frontend/src/hooks/useExcalidrawDocument.ts:638). Source-confirmed ownership gap; delayed decoding/font and read-only-drop scenarios were not reproduced in this pass.

### 3. Excalidraw loading uses a time-based suppression rule — high priority

For three seconds after loading a nonempty scene, empty changes are discarded as presumed transient renderer events. The check has no provenance to distinguish a renderer event from the user deliberately deleting the last element. Invalid JSON is also caught inside canvas application after tab activation, leaving the previous canvas available rather than rejecting the document before activation.

The right simplification is a validated load boundary and a defined scene-application lifecycle, which should make the three-second exception removable. Deleting the guard without reproducing its original purpose could reintroduce scene loss.

Evidence: [scene application](/Users/chris/Projects/excalibur/frontend/src/hooks/useExcalidrawDocument.ts:244), [empty-change suppression](/Users/chris/Projects/excalibur/frontend/src/hooks/useExcalidrawDocument.ts:338), [file input preparation](/Users/chris/Projects/excalibur/frontend/src/lib/documents.ts:43). Source-confirmed branches; deletion-timing and malformed-file journeys remain unverified.

### 4. Persistence can fail without an actionable result — high priority

Project-list and recent-list saves discard filesystem errors. Settings writes reject in Rust but the UI catches them only in the console after applying the value. Loading malformed project-list JSON returns an empty list, which a later write can replace. The app-data directory falls back to the working directory on resolution failure.

Diagram, settings, and metadata writes use direct `fs::write`. Cross-project metadata relocation writes two metadata files sequentially; its failure rollback moves the diagram back but does not restore a destination metadata file already written.

Simplification direction: make persistence functions return their real result and remove success-shaped defaults from write-related paths. Durable replacement and metadata rollback need filesystem failure tests; they were not folded into a cosmetic refactor.

Evidence: [recents persistence](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:116), [project persistence](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:185), [metadata relocation](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:383), [file writes](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:620), [settings UI](/Users/chris/Projects/excalibur/frontend/src/hooks/useSettings.ts:16). Source-confirmed; disk-full, permission, corruption, and rollback failure tests were not run.

### 5. Project search can report stale or incomplete results — medium priority

The index cache identifies files by second-resolution modification time and labels. Two content changes within that timestamp can reuse old symbols. A failed read is cached as an empty result under the same signature. The project menu's Rescan folder reloads the sidebar listing without invalidating the symbol index. Indexing reads saved files, whereas board thumbnails can read unsaved tab contents.

Keep the useful cache, but give explicit rescans one shared invalidation path; do not cache read failure as successful emptiness. Distinguish disk-index results from live document contents.

Evidence: [index cache](/Users/chris/Projects/excalibur/frontend/src/hooks/useSymbolIndex.ts:56), [rescan action](/Users/chris/Projects/excalibur/frontend/src/components/ProjectsPanel.tsx:165), [file timestamp](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:562). Source-confirmed; same-timestamp and failed-read recovery scenarios were not injected.

### 6. Dialogs do not fully own keyboard interaction — medium priority

Settings, prompt, and board overlays declare themselves modal but do not trap focus or make the background inert. App shortcuts listen in capture phase, so a dialog's Escape handler does not prevent the app's highlight/panel handling from also running. This can also leave tab-closing shortcuts active behind dialogs.

Use a single modal boundary for focus and shortcut routing rather than more independent Escape listeners.

Evidence: [global keyboard handler](/Users/chris/Projects/excalibur/frontend/src/hooks/useKeyboardShortcuts.ts:38), [settings dialog](/Users/chris/Projects/excalibur/frontend/src/components/SettingsDialog.tsx:35), [prompt dialog](/Users/chris/Projects/excalibur/frontend/src/components/AgentPromptDialog.tsx:152), [board dialog](/Users/chris/Projects/excalibur/frontend/src/components/SymbolBoard.tsx:109). Source-confirmed; full keyboard/accessibility audit was not performed.

### 7. Platform/setup claims need narrower proof — medium priority

The installers and README accept Node 18, but the installed Vite package declares `^20.19.0 || >=22.12.0`. The Linux bare-binary fallback copies `excalibur-tauri` into the install directory and then tries to chmod a file named `excalibur`. Folder-drop detection assumes a folder has no extension, so a directory with a dot is skipped. Startup/runtime file-event code takes only the first file.

These are concrete setup/input limitations. They do not justify adding platform automation; first align prerequisite checks and path handling, then exercise the relevant native platforms.

Evidence: [install.sh](/Users/chris/Projects/excalibur/install.sh), [install.ps1](/Users/chris/Projects/excalibur/install.ps1), [native drop handling](/Users/chris/Projects/excalibur/frontend/src/hooks/useNativeEvents.ts:121), [native entry point](/Users/chris/Projects/excalibur/src-tauri/src/main.rs:1136). Installed dependency manifest checked locally. Linux/Windows installation and OS file events were not exercised.

## What earns its place

| Area reviewed | Decision |
| --- | --- |
| Two always-mounted editors and per-tab caches | Keep. They serve different formats and preserve expensive editor state. Their ownership rules need tightening; merging their engines would obscure their real differences. |
| Projects, portable display metadata, nested file tree | Keep. Plain folders and labels without physical renames are core requirements. |
| Recents and blank-tab reuse | Keep. These reduce navigation work and unwanted empty tabs. |
| Editing/viewing mode | Keep. Reading architecture diagrams should not accidentally edit them. Enforce the boundary consistently. |
| Symbol search and references | Keep. They are distinct entry points into one shared index and already reuse result rendering. |
| Symbol board and bounded thumbnail cache | Keep. The board provides visual comparison; the cache avoids repeated expensive rendering. Its failure presentation and freshness need attention. |
| Mermaid conversion, text measurement, PNG export | Keep. They cross genuinely different representations. Existing conversion and rendered-output tests justify the integration code. |
| Coding-agent prompt | Keep. Deterministic text generation is sufficient; remove unsupported claims instead of adding an agent runner. |
| Settings | Keep the small current set. No new settings framework or live synchronization service is warranted by this review. |
| CLI | Keep. It is an independent file-conversion workflow with useful failure diagnostics; real Chromium rendering passed. |

## Verification and limits

- Frontend build and lint passed. Vite still reports large bundle chunks; no speculative bundle optimization was added.
- Full Playwright suite: **54 passed**, including seven new document-ownership/label scenarios. Browser tests exercise real React, Mermaid, Excalidraw, rendering, and interactions; the Tauri filesystem/dialog bridge is mocked.
- Rust: **6 passed**, including real temporary-file project-metadata preservation. These do not cover every native command or failure branch.
- Real CLI check: rendered Markdown to a sidecar SVG, preserved surrounding prose, emitted JSON diagnostics for malformed Mermaid, and left an existing output file unchanged on parse failure.
- Earlier sidebar check verified pointer limits, keyboard resize, persistence, and reset.
- No native desktop launch/dialog test, crash recovery experiment, Linux/Windows run, failure-injected filesystem suite, or independent-agent review was performed.
- Changes remain local and uncommitted. No deployment or external tracker changes were made.
