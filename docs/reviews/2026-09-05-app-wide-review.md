# Excalibur app-wide review and fixes

Reviewed the app against `42767d9`, then implemented the remaining findings at the user's request. The checkout now includes `0034794` plus the final working-tree cleanup. This is an app-wide source review with targeted runtime verification, not a claim that every platform workflow has been exercised.

## Outcome

All seven categories of findings from the review have been addressed. The product's core features still earn their place: file-based diagrams, two editor formats, projects with portable labels, tabs, symbol navigation, a visual board, and the CLI. No major feature deletion was justified.

The earlier fixes for cross-tab save/rename completion, retaining edits made during a save, and keeping project labels separate from Mermaid titles remain covered by regression tests. Redundant editor branches, duplicated native file-loading code, unused exports, misleading prompt/settings copy, and the directory-prefix relocation path were removed or simplified.

## Remaining findings resolved

| Original finding | Implemented fix | Verification |
| --- | --- | --- |
| Recovery protected only one Excalidraw scene and no Mermaid source. | Store unsaved contents and saved baselines per document for both formats. Restore active/inactive and untitled documents on startup, including an intentionally empty scene. Save removes the matching saved recovery; closing with discard or confirming exit without saving removes recovery. Storage failures show an actionable alert. Recovery does not store Mermaid undo history. | Browser reload retains two independently edited Mermaid tabs and an empty Excalidraw scene. Close/exit tests verify discard versus cancellation. Quota failure leaves the editor usable and shows an alert. |
| Image imports and text refitting could complete against another live canvas or in viewing mode. | Capture the originating document before asynchronous work, verify it is still the editable active document at completion, and cancel when ownership changes. Refit also checks that its element array is still current. | Browser tests delay actual file decoding/font completion while changing tabs; image tests also check the saved drawing contains no imported image. Viewing-mode drops are refused. Existing successful image-import/conversion tests pass. |
| A three-second empty-scene exception could lose deliberate deletion; malformed drawing files activated before validation. | Delete the timer and its branches. Ignore scene changes only during synchronous replacement or when a callback's element array is obsolete. Validate drawing JSON before creating/activating a tab. | Invalid JSON leaves the original tab active. Immediate deletion can be saved; an unsaved empty scene survives switching and reload. Existing per-tab canvas/preview viewport tests pass. |
| Storage failures looked successful; direct writes could truncate files; a failed cross-project metadata move did not restore the destination. | Return storage errors instead of defaulting to empty data or the working directory. Replace files through a synced temporary file in the same directory, preserving existing permissions and symlink targets; sync the parent directory on Unix. Restore destination metadata bytes or remove newly created metadata if the source metadata write fails. Report ancillary Recent-update failures separately from a completed file operation. Settings apply only after a successful save. | Real filesystem tests cover corrupt/missing/unreadable storage, failed replacement, temporary-file cleanup, read-only files, symlinks/permissions, and rollback of existing/new destination metadata. Browser tests cover failed settings writes and visible storage errors. |
| Search could reuse stale timestamps and cache failed reads as empty results; Rescan refreshed only the file list. | Delete the per-file timestamp cache. The existing lazy index refreshes on writes and explicit rescan, rereads saved contents, and reports failed files. Both the sidebar and index receive the same refresh. Search explains that it uses saved diagrams. | Same-timestamp content changes appear after rescan. An injected file-read failure is reported and succeeds on retry without a timestamp change. Existing symbol-search/reference/board tests pass. |
| Modal dialogs allowed background shortcuts and focus escape. | Use a shared native-dialog lifecycle for Settings, the agent prompt, and the board, with focus wrapping, inert background, Escape, and outside-click dismissal. Remove duplicate backdrop elements/styles. App shortcuts defer while a native modal is open. | Browser keyboard tests keep focus in Settings and block document close. Existing agent typing/copy, board selection/Escape, and settings tests pass. |
| Installer prerequisites were too old, Linux fallback named its binary incorrectly, and native input handling skipped dotted folders/additional files. | Require Node 22.12+ in both installers and README. Copy the Linux binary to the same path that is chmodded. Classify dropped paths through filesystem metadata; handle every dropped/startup path. Queue native file requests until frontend readiness. | Shell syntax and Node boundary checks pass. The Linux copy/chmod branch runs successfully in a temporary directory. Rust tests classify dotted folders and test native request queuing. Browser bridge tests handle multiple startup files and a mixed dotted-folder/multiple-diagram drop. |

## Verification

- Frontend build and lint passed; `git diff --check` passed.
- **70 Playwright tests passed**, including 16 new follow-up scenarios and the seven earlier ownership/label scenarios. These use real React, Mermaid, Excalidraw, browser rendering and interactions; native Tauri dialogs/filesystem commands are mocked.
- **12 Rust tests passed**, including six new tests exercising filesystem behavior and native request queuing.
- Installer shell syntax, Node version boundaries, and the real Linux fallback copy/chmod branch passed.
- The earlier review's real Chromium CLI rendering and malformed-input checks also passed; the CLI was unchanged during this follow-up.

Regression coverage: [review-fixes.spec.ts](/Users/chris/Projects/excalibur/frontend/tests/review-fixes.spec.ts), [document-ownership.spec.ts](/Users/chris/Projects/excalibur/frontend/tests/document-ownership.spec.ts), and the persistence tests in [main.rs](/Users/chris/Projects/excalibur/src-tauri/src/main.rs).

## Practical limits

- Browser reload verifies restoration from persisted content. Native process termination, power failure, and operating-system storage durability were not directly exercised.
- Native file dialogs and full Linux/Windows installation were not run. PowerShell is unavailable on this host; its prerequisite check was reviewed in source. The Rust tests ran on macOS.
- Temporary replacement and handled-error rollback are implemented; cross-project moves are not an atomic multi-file transaction across a machine crash.
- Recovery depends on browser storage capacity. Failed writes are visible; saving documents to files remains the durable user-controlled path. The old explicit Excalidraw backup action remains compatible.
- Vite still reports large bundle chunks. No speculative bundling optimization or new automation was added.
- Final cleanup remains uncommitted. No deployment or push was performed by this task.
