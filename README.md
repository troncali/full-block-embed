# Full Block Embed

[![Latest release](https://img.shields.io/github/v/release/troncali/full-block-embed?sort=semver)](https://github.com/troncali/full-block-embed/releases/latest)
[![Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22full-block-embed%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=full-block-embed)
[![Lint & Tests](https://github.com/troncali/full-block-embed/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/troncali/full-block-embed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/troncali/full-block-embed)](LICENSE)

Embed the full Markdown of a source block in other Obsidian notes and keep every copy synchronized. Each reference contains ordinary Markdown so notes remain complete and readable in other editors, renderers, scripts, and LLM workflows.

- [Why](#why)
- [Install](#install)
- [Use](#use)
- [Example](#example)
- [Implementation Details](#implementation-details)
- [Development](#development)

## Why?

Embedded blocks are useful outside of Obsidian if notes are self-contained.

Obsidian's native block embeds are links, and other embed plugins use similar strings. Other tools generally render these as text because they cannot resolve the blocks.

```md
# Example: Obsidian's native block embed

![[folder/file^block-id]]
```

This plugin places the full Markdown of a source block between invisible HTML comment markers in every referencing note. Each note is self-contained and synchronized by Obsidian.

This is useful when a note is used outside of Obsidian, like with an LLM: a longer note contains the referenced text directly, while source notes can still be indexed separately to feed focused context relevant to the current operation. [See an example](#example).

<sup>[Back to Top](#full-block-embed)</sup>

## Install

1. **From Community plugins**
    - Open `Settings → Community plugins` and click `Browse`
    - Search for `Full Block Embed`
    - Click `Install` and `Enable`

2. **From source**
    - Clone this repository:

        ```sh
        git clone https://github.com/troncali/full-block-embed.git
        ```

    - Run `npm install` and `npm run build`
    - Copy the generated `main.js`, `manifest.json` and `styles.css` into `<vault-path>/.obsidian/plugins/full-block-embed/`
    - Open `Settings → Community plugins`
    - Click the refresh button, then enable Full Block Embed

<sup>[Back to Top](#full-block-embed)</sup>

## Use

This plugin adds the following actions to the command palette (`Cmd/Ctrl+P`) and the editor's context (right-click) menu. Set hotkeys for each command in `Settings` for faster use.

<!-- prettier-ignore -->
| Command | What it does |
| --- | --- |
| **Create shared block** | Prompts for a block name and wraps the selected text with a source block marker. |
| **Insert shared block reference** | Lists source blocks and inserts the selected reference block at the cursor, filled with a complete Markdown copy. |
| **Open shared block source** | Opens the source note with the source block selected. Ctrl/Cmd-clicking a reference block or pressing its arrow button triggers this command. To trigger the command by hotkey or palette, the cursor must be inside the reference block. |
| **Delete current shared block reference** | Removes the reference block, including its marker lines and copied Markdown. Pressing the block's trash button triggers this command. To trigger the command by hotkey or palette, the cursor must be inside the reference block. |
| **Convert current shared source to normal text** | After confirmation, removes related markers from all notes while leaving the copied Markdown in place. Pressing the block's unlink button will trigger this command. To trigger the command by hotkey or palette, the cursor must be inside the source block. |
| **Open first shared block sync issue** | Opens the first malformed marker or synchronization conflict at its source line. |
| **Synchronize shared blocks now** | Explicitly rebuilds the vault index and synchronizes every shared block. Normal editing does not require this command. |

### Editing & Rendering

Block rendering and functionality depend on context.

- **Reading mode** — blocks render as normal Markdown.

- **Live Preview mode** — blocks render in the normal live-edit manner but do not show marker lines.

- **Source mode** — all blocks appear in normal source-edit form, including marker lines.

When focused for editing, reference blocks are replaced with an embedded Obsidian editor scoped to the source block. Editing the content of a source or reference block updates all related blocks.

All blocks highlight on hover. Reference blocks also reveal buttons to open the source or delete the reference. Source blocks reveal a button to convert it and all references to normal text.

### Block Structure

Blocks are delimited by single-line HTML comment markers that only show in source view. Markers must be on their own lines and be comprised of the components below _without any spaces_. Malformed markers or unclosed blocks are reported as errors.

<!-- prettier-ignore -->
| Marker Component | Explanation |
| --- | --- |
| `<!--#example` | Begins a marker for a block named `example` |
| `+` or `=` or `/` | Declares the marker type: `+` to begin a source block, `=` to begin a reference block, and `/` to close either block type |
| `-->` | Closes the marker |

Below are examples of how blocks appear in Source mode.

```md
# Source Block

<!--#company-acme-summary+-->

Acme makes industrial widgets.

<!--#company-acme-summary/-->
```

```md
# Reference Block

<!--#company-acme-summary=-->

Acme makes industrial widgets.

<!--#company-acme-summary/-->
```

<sup>[Back to Top](#full-block-embed)</sup>

## Example

A full plan is good for user review and an LLM in some contexts, but only some sections of the plan may be useful for an LLM in other contexts.

1. Split the plan's sections into individual notes

    ```text
    ├── sections/
    │   ├── one.md
    │   ├── two.md
    │   └── three.md
    ├── plan.md
    └── index.md
    ```

2. Create source blocks in each section note.

    ```md
    # One

    <!--#one+-->

    Acme makes industrial widgets.

    <!--#one/-->
    ```

3. Build the full plan using reference blocks where relevant.

    ```md
    # Full Plan

    Description of the full plan.

    ## One

    <!--#one=-->

    Acme makes industrial widgets.

    <!--#one/-->
    ```

4. Create an index so that LLMs can selectively read only relevant sections.

    ```md
    # Index

    Read only the linked files below that are relevant to the request.

    - [auth, jwt, oauth, sessions, security](./sections/one.md)
    - [database, prisma, sql, migrations](./sections/two.md)
    - [ui, tailwind, design components](./sections/three.md)
    ```

<sup>[Back to Top](#full-block-embed)</sup>

## Implementation Details

- **Privacy & Compatibility** – all processing occurs locally. The plugin uses Obsidian Vault and Editor APIs instead of filesystem access, so it works on desktop and mobile.

- **Block processing** – blocks synchronize when a note is opened or edited in Obsidian. No vault-wide scan occurs unless manually triggered. Markers inside fenced code blocks (\`\`\`) are treated as examples, not embedded blocks.

- **Cache** – the plugin maintains a cache of metadata in `data.json` that is written when synchronization occurs. The cache contains an index of block-bearing note paths, modification times, block names, and a hash of the last synchronized content for each block.

- **Nested Blocks** – blocks may be nested. Nested children synchronize before parents. When a parent source block contains child source blocks, the child source markers change from `+` to `=` when copied to reference blocks.

- **Conflict Behavior** – The plugin never chooses a winner for divergent copies and raises an error for circular nesting, malformed or unclosed markers, duplicate sources, and missing sources. A conflict or error pauses writes and shows a notice; the console lists affected block names and files.

- **Editing Outside Obsidian** – blocks synchronize when a note is opened in Obsidian, or a vault-wide sync can be manually triggered. Conflicting copies raise warnings without overwriting. Newly inserted reference blocks are hydrated from the source block.

- **Disabling Plugin** – Markdown remains in the state it was at the time of the last synchronization.

<sup>[Back to Top](#full-block-embed)</sup>

## Development

### Code Contributions

Fork the repository, create a branch, and open a pull request. Before submitting, please ensure `npm test` and `npm run build` pass.

### Local Development

1. Clone the repository and run `npm i`.
2. Run `npm run dev` to rebuild on changes to `.ts` files.
3. Follow the [`Install from source`](#install) instructions to add our modified plugin files to Obsidian.
4. Toggle the plugin off and on to test updates in Obsidian.

### Scripts

```bash
npm run build   # type-check and build production bundle
npm run check   # run lint and test scripts
npm run dev     # build in watch mode
npm run lint    # check syntax errors, bugs, and stylistic
npm run tag     # add tag based on package.json version
npm run test    # unit test for the parsing and cache logic
npm run version # increment the plugin version
```

### Release

1. If applicable, update `minAppVersion` in `manifest.json` to the minimum Obsidian version the plugin requires.
2. Run `npm version [patch | minor | major]`
3. Run `npm run version` to update `manifest.json` and `versions.json`.
4. Update `CHANGELOG.md` with notes for the version.
5. Commit changes and run `npm run tag`.
6. Push to origin: `git push origin main --tags`.

### License & Provenance

Full Block Embed is © 2026 Matt Troncali and released under the MIT License. It incorporates ideas and adapted implementation work from [Sync Embeds](https://github.com/uthvah/sync-embeds) and [Shared Blocks](https://github.com/perezamadorluisenrique-gif/shared-blocks), both MIT-licensed. Their copyright notices are preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<sup>[Back to Top](#full-block-embed)</sup>
