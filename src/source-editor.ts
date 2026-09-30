import { StateEffect } from '@codemirror/state';
import { EditorView as CodeMirrorEditorView } from '@codemirror/view';
import {
	App,
	Editor,
	MarkdownView,
	Notice,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import { Block, parseFile } from './blocks';
import { viewportExtension } from './editor';

export interface LocatedSource {
	block: Block;
	file: TFile;
}

export class SourceEditor {
	constructor(
		private app: App,
		private findSource: (id: string) => Promise<LocatedSource | null>,
	) {}

	async mount(
		container: HTMLElement,
		id: string,
		livePreview: boolean,
		contentChanged: () => void,
	): Promise<WorkspaceLeaf | null> {
		const source = await this.findSource(id);
		if (!source) {
			container.empty();
			container.createDiv({
				cls: 'full-block-embed-error',
				text: `Source not found for ${id}`,
			});
			return null;
		}
		container.empty();
		const loading = container.createDiv({
			cls: 'full-block-embed-loading',
			text: `Loading ${id}…`,
		});
		// Obsidian uses this constructor for embedded views but omits it from the
		// public TypeScript declaration.
		const EmbeddedLeaf = WorkspaceLeaf as unknown as new (
			app: App,
		) => WorkspaceLeaf;
		const leaf = new EmbeddedLeaf(this.app);
		try {
			await leaf.openFile(source.file, {
				state: { mode: 'source', source: !livePreview },
			});
			const view = leaf.view;
			if (!(view instanceof MarkdownView))
				throw new Error('Obsidian did not create a Markdown editor');
			const editor = view.editor as Editor & {
				cm?: CodeMirrorEditorView;
			};
			if (!editor.cm) throw new Error('Obsidian editor is not ready');
			editor.cm.dispatch({
				effects: StateEffect.appendConfig.of(
					viewportExtension(
						source.file.path,
						id,
						livePreview,
						contentChanged,
					),
				),
			});
			view.containerEl.addClass('full-block-embed-embedded-view');
			view.containerEl.toggleClass(
				'full-block-embed-embedded-live-preview',
				livePreview,
			);
			view.containerEl.toggleClass(
				'full-block-embed-embedded-source-mode',
				!livePreview,
			);
			loading.remove();
			container.appendChild(view.containerEl);
			window.requestAnimationFrame(() => {
				const latest = parseFile(
					source.file.path,
					view.editor.getValue(),
				).blocks.find((block) => block.id === id && block.kind === '+');
				if (!latest) return;
				view.editor.setCursor({ line: latest.startLine + 1, ch: 0 });
				editor.cm?.focus();
				editor.cm?.requestMeasure();
			});
			return leaf;
		} catch (error) {
			leaf.detach();
			throw error;
		}
	}

	async open(id: string): Promise<void> {
		const source = await this.findSource(id);
		if (!source) {
			new Notice(`Source not found for ${id}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(source.file, { state: { mode: 'source' } });
		if (!(leaf.view instanceof MarkdownView)) return;
		leaf.view.editor.setSelection(
			{ line: source.block.startLine + 1, ch: 0 },
			{ line: source.block.endLine, ch: 0 },
		);
		leaf.view.editor.scrollIntoView(
			{
				from: { line: source.block.startLine, ch: 0 },
				to: { line: source.block.endLine, ch: 0 },
			},
			true,
		);
	}

	async openIssue(issue: string): Promise<void> {
		const match = /^(.*):(\d+): /.exec(issue);
		if (!match) {
			new Notice(issue, 8000);
			return;
		}
		const path = match[1]!;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file, { state: { mode: 'source' } });
		if (!(leaf.view instanceof MarkdownView)) return;
		const line = Math.max(0, Number(match[2]!) - 1);
		const editor = leaf.view.editor;
		const text = editor.getLine(line);
		editor.setSelection({ line, ch: 0 }, { line, ch: text.length });
		editor.scrollIntoView(
			{ from: { line, ch: 0 }, to: { line, ch: text.length } },
			true,
		);
	}
}
