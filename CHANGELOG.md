# Changelog

## 1.0.2

- Fix embedded editor top spacing for mobile
- Fix faint highlight background for reference blocks in reading mode
- Fix README typos

## 1.0.1

- Fix embedded editor in `src/source-editor.ts` to mount only the Markdown editor subtree instead of the full-height workspace leaf and simplified CSS, which resolves CSS lint error by allowing the removal of `!important` overrides
- Fix type error at `src/block.ts:122`
- Moved upstream license information entirely to THIRD_PARTY_NOTICES.md and updated test

## 1.0.0

- Synchronize the full Markdown between one source and any number of references, in both directions.
- Implement lazy, display-driven synchronization instead of scanning at startup or after every vault change.
- Persist a structural path/ID/mtime index and content fingerprints rather than complete synchronized block bodies.
- Keep only block-bearing notes in the persisted structural index; discover first blocks through vault events or the explicit full scan.
- Accept consistent outside updates, but refuse to overwrite divergent outside edits, including a single emptied copy found after Obsidian reopens.
- Edit references inline through an embedded Obsidian editor.
- Create embedded Obsidian editors only after a reference is selected.
- Use editor transactions for open notes and keep the vault-wide refresh as an explicit command.
- Support nested source and reference blocks with child-before-parent synchronization, source-to-reference marker projection, parent hashes, and circular-dependency protection.
- Highlight references and provide controls to open their source or remove them.
- Convert a source and all its references back to ordinary Markdown.
- Create sources and references from commands or the editor context menu.
- Pause safely on conflicting edits or malformed markers and open marker errors at their exact line.
- Keep notes portable and readable when the plugin is disabled or outside Obsidian.
- Update documentation, privacy disclosures, and release-guideline compliance.
