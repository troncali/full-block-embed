# Full Block Embed

[![Latest release](https://img.shields.io/github/v/release/troncali/full-block-embed?sort=semver)](https://github.com/troncali/full-block-embed/releases/latest)
[![Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22full-block-embed%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=full-block-embed)
[![Tests](https://github.com/troncali/full-block-embed/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/troncali/full-block-embed/actions/workflows/lint.yml)
[![License: MIT](https://img.shields.io/github/license/troncali/full-block-embed)](LICENSE)

Embed the full Markdown of a source block in other Obsidian notes and keep every copy syncronized. Each reference contains ordinary Markdown so notes remain complete and readable in other editors, renderers, scripts, and LLM workflows.

- [Why](#why)
- [Install](#install)
- [Use](#use)
- [Example](#example)
- [Implementation Details](#implementation-details)
- [Development](#development)

## Why?

For embeded blocks to be useful outside of Obsidian, notes must be readable as a single file.

1. **Source Markdown**
    - <u>Problem</u>: Obsidian's native implementation for embedding a block results in a single line that other programs don't natively interpret. Other embed and syncronization plugins have a similar result.

        ```md
        # Example: Obsidian's native block embed

        ![[folder/file^block-id]]
        ```

    - <u>Solution</u>: This plugin includes the full Markdown of a source block in all reference blocks and keeps the blocks syncronized regardless of where the edit is made.

2. **Rendered Markdown**
    - <u>Problem</u>: Source and reference strings that define and use blocks show as text in other programs when a Markdown note is rendered, both for Obsidian's native implementation and other plugins.

    - <u>Solution</u>: This plugin uses HTML comments to define source and reference blocks. Those comments only show in source view.

3. **LLM Token Efficiency**
    - <u>Problem</u>: Long notes burn tokens if only some content is relevant to the current operation. Multiple file reads (more tokens) are necessary to piece together a complete note, assuming an LLM is configured to interpret Obsidian and other plugins' block reference lines.

    - <u>Solution</u>: This plugin ensures that every note is complete and readable as a single file, even with reference blocks. Preserves the ability to provide an LLM an index of source blocks when only some content is needed. [See an example](#example).

<sup>[Back to Top](#full-block-embed)</sup>

## Install

1. **Community Plugin Installation**
    - Open the `Obsidian` menu and select `Settings`
    - In the left sidebar, select `Community plugins`
    - Click the `Browse` button
    - Search for and select `Full Block Embed`
    - Click the `Install` and `Enable` buttons

2. **Manual Installation from Source**
    - Clone this repository:

        ```sh
        git clone https://github.com/troncali/full-block-embed.git
        ```

    - Run `npm run build`
    - Copy the generated `main.js`, `manifest.json` and `styles.css` into `<vault-path>/.obsidian/plugins/shared-blocks/`
    - Open the `Obsidian` menu and select `Settings`
    - In the left sidebar, select `Community plugins`
    - Click the toggle to enable Full Block Embed

<sup>[Back to Top](#full-block-embed)</sup>

## Use

This plugin adds block actions to the command palette (`Cmd/Ctrl+P`) and the editor's context (right-click) menu. Set hotkeys for each command in `Settings` for faster use.

<!-- prettier-ignore -->
| Command | What it does |
| --- | --- |
| **Create shared block** | Prompts for a block name and adds markers at the beginning and end of the selected text. |
| **Insert shared block reference** | Shows a picker of source block names and their file path. Inserts the selected reference block at the cursor. |
| **Open shared block source** | Opens the source file with the source block selected and scrolled into view. When hovering on a reference block, the arrow button that appears will trigger this command. To trigger the command by hotkey or palette, the cursor must be inside the reference block. Ctrl/Cmd-clicking on a reference will also trigger the command. |
| **Delete current shared block reference** | Removes the reference block (the marker lines and markdown content). When hovering on a reference block, the trash button that appears will trigger this command. To trigger the command by hotkey or palette, the cursor must be inside the reference block. |
| **Convert current shared source to normal text** | Asks for confirmation, then removes the marker lines from all files while keeping every copy's current Markdown in place. When hovering on a source block, the unlink button that appears will trigger this command. To trigger the command by hotkey or palette, the cursor must be inside the source block. |
| **Open first shared block sync issue** | Opens the first issue's file in source mode with the offending line selected. |

### Block Rendering

Blocks render and have different functionality based on the context.

- **Reading mode** — references render as typical Markdown with no embedded editor.

- **Live Preview mode** — all blocks show in the normal live-edit manner but do not display marker lines.

- **Source mode** — all blocks show in the normal source-edit manner, including display marker lines.

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

- **Block processing** – Locally-stored plugin data records the last synchronized block content.

- **Conflict Behavior** – The plugin never chooses a winner for divergent copies and raises an error for duplicate or missing sources and malformed or nested markers. A conflict or error pauses **all writes** and shows a notice; the console lists affected block names and files.

- **Disabling Plugin** – Markdown remains in the state it was at the time of the last synchronization.

- **Editing Outside Obsidian** – Edits will synchronize on the next startup, subject to conflict detection.
    - A newly added reference is filled from the established source even if it contains stale pasted text.
    - An existing emptied reference propagates an intentional deletion.

- **Performance Considerations** – The plugin scans all Markdown notes at startup and after each batch of changes. Very large vaults may see a delay. Each visible reference in `Live Preview` or `Source` mode owns a lightweight Obsidian editor, so notes containing many simultaneous references use more memory.

<sup>[Back to Top](#full-block-embed)</sup>

## Development

```bash
npm install
npm run dev     # esbuild in watch mode
npm run build   # type-check, then a production bundle
npm test        # unit tests for the parsing and cache logic
```

### License & Provenance

Full Block Embed is copyright © 2026 Matt Troncali and released under the MIT License. It incorporates ideas and adapted implementation work from [Sync Embeds](https://github.com/uthvah/sync-embeds) and [Shared Blocks](https://github.com/perezamadorluisenrique-gif/shared-blocks), which are also MIT-licensed. Their copyright notices are preserved in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<sup>[Back to Top](#full-block-embed)</sup>
