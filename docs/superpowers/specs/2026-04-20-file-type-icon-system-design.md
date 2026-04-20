# File Type Icon System Design

**Date:** 2026-04-20

**Goal**

Improve file-type recognition across the product by replacing generic file glyphs with semantically matched `lucide-react` icons while preserving the current lightweight visual style.

**Scope**

- Add one shared file-type resolver for filename / extension / MIME-based classification.
- Add one shared `FileTypeIcon` presentation component that renders a single `lucide-react` icon per resolved type.
- Replace the generic file icon on the receiver single-file confirmation card.
- Add file-type icons to sender file-list rows.
- Preserve the existing aggregate multi-file icon for grouped transfer cards.

**Non-Goals**

- Do not add thumbnails, previews, badges, color-coded type chips, or custom SVG icon compositions.
- Do not redesign receiver or sender card layouts beyond swapping or inserting icons.
- Do not introduce a new icon library or custom visual language outside the existing `lucide-react` system.

**User-Approved Constraints**

- Use the existing `lucide-react` icon library as the visual source of truth.
- Render one icon directly; do not nest one file icon inside another or add corner badges.
- Keep the result visually light and aligned with the current interface style.
- Match icons by content meaning where possible rather than forcing everything into `file-*` variants.
- Keep `exe`-style installer artifacts mapped to `FileCog`.
- Keep Excel-style spreadsheet artifacts mapped to `Sheet`.

**Approach**

Introduce a small shared classification layer plus a small shared icon component. Centralize extension-to-type mapping in one place, keep all UI surfaces dumb, and only expose the resolved semantic type to the icon component. This keeps the behavior testable, avoids duplicated switch statements in UI files, and makes future surfaces reuse the same icon logic without re-deciding the mapping.

**Design**

1. Add a pure resolver in `services/` that accepts:
   - `fileName`
   - optional `mimeType`
   - optional `isDirectory`
2. Normalize the extension to lowercase before matching.
3. Prefer extension-based matching for deterministic desktop/file-transfer behavior.
4. Fall back to MIME-based heuristics only when the extension is absent or ambiguous.
5. Return one normalized semantic type string.
6. Add a `FileTypeIcon` component that maps the semantic type to a single `lucide-react` icon component.
7. Keep icon sizing configurable so the same component works in cards and compact lists.

**Semantic Types**

- `document`
- `spreadsheet`
- `presentation`
- `image`
- `video`
- `audio`
- `archive`
- `code`
- `json`
- `executable`
- `folder`
- `unknown`

**Primary Mapping**

- `pdf`, `doc`, `docx`, `txt`, `md`, `rtf` -> `document` -> `FileText`
- `xls`, `xlsx`, `csv` -> `spreadsheet` -> `Sheet`
- `ppt`, `pptx`, `key` -> `presentation` -> `Presentation`
- `jpg`, `jpeg`, `png`, `gif`, `webp`, `svg`, `bmp`, `ico`, `avif` -> `image` -> `Image`
- `mp4`, `mov`, `webm`, `mkv`, `avi` -> `video` -> `Video`
- `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg` -> `audio` -> `Music`
- `zip`, `rar`, `7z`, `tar`, `gz`, `bz2`, `xz` -> `archive` -> `Archive`
- `js`, `ts`, `jsx`, `tsx`, `html`, `css`, `scss`, `sass`, `vue`, `py`, `java`, `kt`, `go`, `rs`, `c`, `cpp`, `h`, `hpp`, `sh` -> `code` -> `Code`
- `json`, `map` -> `json` -> `FileJson`
- `exe`, `msi`, `apk`, `dmg`, `pkg`, `deb`, `rpm` -> `executable` -> `FileCog`
- directory items -> `folder` -> `Folder`
- everything else -> `unknown` -> `File`

**Fallback Rules**

- If `isDirectory` is true, always return `folder`.
- If the filename has no extension and MIME is image/video/audio/text-like, infer the corresponding semantic type.
- If MIME is absent or non-specific, return `unknown`.

**UI Surface Rules**

1. `components/receiver/ReceiverUI.tsx`
   - Single-file transfer card: replace the current generic file icon with `FileTypeIcon`.
   - Multi-file transfer card: keep the existing grouped file icon (`Layers`) because the card represents a bundle, not one concrete file type.

2. `components/sender/SenderUI.tsx`
   - File-list rows: add `FileTypeIcon` to the left of each filename.
   - Keep the current file-list structure and spacing otherwise unchanged.

3. Future surfaces
   - Any future per-file row or card should use `FileTypeIcon` plus the shared resolver rather than creating a new local mapping.

**Sizing**

- Receiver single-file card: medium display size, visually comparable to the current card icon footprint.
- Sender file-list rows: compact size suitable for dense lists.
- Use current text/icon colors; do not introduce per-type colors in this phase.

**Files**

- Create: `services/fileType.ts`
- Create: `services/fileType.test.ts`
- Create: `components/FileTypeIcon.tsx`
- Modify: `components/receiver/ReceiverUI.tsx`
- Modify: `components/sender/SenderUI.tsx`

**Testing**

- Test the resolver as the primary source of truth.
- Cover:
  - expected mappings for every approved high-frequency type
  - uppercase and mixed-case extensions
  - files with no extension
  - MIME fallback for image/video/audio/text-like inputs
  - unknown extensions
  - directory override
- UI verification only needs lightweight rendering confidence; the mapping tests carry most of the correctness burden.

**Risks**

- Some file types may feel semantically close but not exact, especially `presentation` and `json`.
- Over-expanding the mapping table can make maintenance noisy if uncommon extensions are added without clear value.

**Mitigations**

- Keep the first version focused on common, user-visible file types only.
- Centralize the mapping in one file so later adjustments are one-line edits plus tests.
- Preserve the current aggregate icon behavior for multi-file contexts to avoid misleading specificity.

**Verification**

- Run resolver tests first and use them as the acceptance gate for icon selection logic.
- Run `npm run typecheck` after wiring the shared component into sender and receiver UI.
