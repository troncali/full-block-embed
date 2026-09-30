import { EditorView as CodeMirrorEditorView } from '@codemirror/view';
import {
	Component,
	Editor,
	MarkdownRenderer,
	Menu,
	Notice,
	Plugin,
	TFile,
} from 'obsidian';
import {
	Block,
	FileText,
	parseFile,
	referenceBody,
	removeBlock,
	unwrapBlock,
} from './blocks';
import { editingExtension, type EditingActions } from './editor';
import { ReadingViewRenderer, type ReferenceLocator } from './reading-view';
import { SourceEditor } from './source-editor';
import { BlockSyncManager, type LegacyStoredSyncData } from './sync-manager';
import { BlockPicker, ConfirmModal, IdModal } from './ui';

export default class FullBlockEmbed extends Plugin {
	private lastError = '';
	private lastIssues: string[] = [];
	private readingView: ReadingViewRenderer | null = null;
	private sourceEditor!: SourceEditor;
	private sync!: BlockSyncManager;

	async onload(): Promise<void> {
		this.sync = new BlockSyncManager(this, {
			onIssues: (errors) => this.handleSyncIssues(errors),
			onClearIssues: () => {
				this.lastError = '';
				this.lastIssues = [];
			},
		});
		this.sync.load((await this.loadData()) as LegacyStoredSyncData | null);
		this.sourceEditor = new SourceEditor(this.app, (id) =>
			this.sync.findSource(id),
		);
		const changed = (file: unknown) => {
			if (file instanceof TFile && file.extension === 'md')
				this.sync.markModified(file);
		};
		this.registerEvent(this.app.vault.on('modify', changed));
		this.registerEvent(this.app.vault.on('create', changed));
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md')
					this.sync.markDeleted(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md')
					this.sync.markRenamed(file, oldPath);
			}),
		);
		const editingActions: EditingActions = {
			renderPreview: (container, block, livePreview, owner) =>
				this.renderPreview(container, block, livePreview, owner),
			mountLiveEditor: (container, id, livePreview, contentChanged) =>
				this.sourceEditor.mount(
					container,
					id,
					livePreview,
					contentChanged,
				),
			openSource: (id) => void this.sourceEditor.open(id),
			removeReference: (view, block) =>
				this.removeReferenceInEditor(view, block),
			convertSource: (view, block) =>
				void this.confirmConvertSource(block.id, () => ({
					path: block.path,
					text: view.state.doc.toString(),
				})),
			observeEditor: (owner, path, text, document, editedInObsidian) =>
				this.sync.observe(
					owner,
					path,
					text,
					document,
					editedInObsidian,
				),
			unobserveEditor: (owner) => this.sync.unobserve(owner),
		};
		this.registerEditorExtension(editingExtension(editingActions));
		this.readingView = new ReadingViewRenderer(this.app, {
			openSource: (id) => this.sourceEditor.open(id),
			removeReference: (path, id, locator) =>
				this.removeReferenceFromFile(path, id, locator),
			convertSource: (id) => this.confirmConvertSource(id),
			observeRendered: (owner, path, text) =>
				this.sync.observe(owner, path, text),
			unobserveRendered: (owner) => this.sync.unobserve(owner),
		});
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.readingView?.decorate(el, ctx),
		);
		this.addCommand({
			id: 'sync-now',
			name: 'Synchronize shared blocks now',
			callback: () => void this.sync.synchronizeAll(),
		});
		this.addCommand({
			id: 'create-shared-block',
			name: 'Create shared block',
			icon: 'blocks',
			editorCallback: (editor, view) =>
				this.createSharedBlock(editor, view.file),
		});
		this.addCommand({
			id: 'insert-shared-block',
			name: 'Insert shared block reference',
			icon: 'copy-plus',
			editorCallback: (editor) => void this.insertSharedBlock(editor),
		});
		this.addCommand({
			id: 'open-shared-block-source',
			name: 'Open shared block source',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '=');
				if (block) void this.sourceEditor.open(block.id);
				else new Notice('Cursor is not inside a shared reference');
			},
		});
		this.addCommand({
			id: 'remove-shared-block-reference',
			name: 'Delete current shared block reference',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '=');
				if (!block) {
					new Notice('Cursor is not inside a shared reference');
					return;
				}
				this.removeReference(editor, block);
			},
		});
		this.addCommand({
			id: 'convert-shared-block-source',
			name: 'Convert current shared source to normal text',
			editorCallback: (editor, view) => {
				const block = this.blockAtCursor(editor, view.file, '+');
				if (!block) {
					new Notice('Cursor is not inside a shared source');
					return;
				}
				void this.confirmConvertSource(block.id, () =>
					view.file
						? { path: view.file.path, text: editor.getValue() }
						: undefined,
				);
			},
		});
		this.addCommand({
			id: 'open-shared-block-sync-issue',
			name: 'Open first shared block sync issue',
			checkCallback: (checking) => {
				if (!this.lastIssues.length) return false;
				if (!checking)
					void this.sourceEditor.openIssue(this.lastIssues[0]!);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on(
				'editor-menu',
				(menu: Menu, editor: Editor, view) => {
					const block = this.blockAtCursor(editor, view.file);
					menu.addSeparator();
					if (block?.kind === '=')
						menu.addItem((item) =>
							item
								.setTitle('Delete shared block reference')
								.setIcon('trash-2')
								.onClick(() =>
									this.removeReference(editor, block),
								),
						);
					if (block?.kind === '+')
						menu.addItem((item) =>
							item
								.setTitle('Convert shared block to normal text')
								.setIcon('unlink')
								.onClick(
									() =>
										void this.confirmConvertSource(
											block.id,
											() =>
												view.file
													? {
															path: view.file
																.path,
															text: editor.getValue(),
														}
													: undefined,
										),
								),
						);
					menu.addItem((item) =>
						item
							.setTitle('Create shared block')
							.setIcon('blocks')
							.onClick(() =>
								this.createSharedBlock(editor, view.file),
							),
					);
					menu.addItem((item) =>
						item
							.setTitle('Insert shared block reference')
							.setIcon('copy-plus')
							.onClick(() => void this.insertSharedBlock(editor)),
					);
				},
			),
		);
	}
	onunload(): void {
		this.sync.unload();
		this.readingView = null;
	}

	private async renderPreview(
		container: HTMLElement,
		block: Block,
		livePreview: boolean,
		owner: Component,
	): Promise<void> {
		container.empty();
		if (livePreview) {
			container.addClass('full-block-embed-live-preview');
			await MarkdownRenderer.render(
				this.app,
				block.body,
				container,
				block.path,
				owner,
			);
			return;
		}
		const previewBlock =
			(await this.sync.findSource(block.id))?.block ?? block;
		container.addClass('full-block-embed-source-preview');
		container.createDiv({
			cls: 'full-block-embed-marker-line',
			text: `<!--#${previewBlock.id}+-->`,
		});
		container.createDiv({
			cls: [
				'full-block-embed-source-preview-body',
				...(previewBlock.body
					? []
					: ['full-block-embed-empty-preview']),
			],
			text: previewBlock.body || `Select to edit ${previewBlock.id}`,
		});
		container.createDiv({
			cls: 'full-block-embed-marker-line',
			text: `<!--#${previewBlock.id}/-->`,
		});
	}
	private blockAtCursor(
		editor: Editor,
		file: TFile | null,
		kind?: '+' | '=',
	): Block | undefined {
		if (!file) return undefined;
		const line = editor.getCursor().line;
		return parseFile(file.path, editor.getValue())
			.blocks.filter(
				(block) =>
					(!kind || block.kind === kind) &&
					line >= block.startLine &&
					line <= block.endLine,
			)
			.sort(
				(a, b) =>
					b.depth - a.depth || a.end - a.start - (b.end - b.start),
			)[0];
	}
	private removeReference(editor: Editor, block: Block): void {
		editor.replaceRange(
			'',
			editor.offsetToPos(block.start),
			editor.offsetToPos(block.end),
		);
		new Notice(`Deleted reference ${block.id}`);
	}
	private removeReferenceInEditor(
		view: CodeMirrorEditorView,
		block: Block,
	): void {
		if (block.kind !== '=') return;
		const current = view.state.doc.toString();
		const latest = parseFile(block.path, current).blocks.find(
			(candidate) =>
				candidate.kind === '=' &&
				candidate.id === block.id &&
				candidate.start === block.start,
		);
		if (!latest) {
			new Notice('This reference changed; try the delete button again');
			return;
		}
		view.dispatch({
			changes: { from: latest.start, to: latest.end, insert: '' },
		});
		new Notice(`Deleted reference ${block.id}`);
	}
	private async removeReferenceFromFile(
		path: string,
		id: string,
		locator: ReferenceLocator = {},
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${path}`);
			return;
		}
		try {
			await this.app.vault.process(file, (current) => {
				const candidates = parseFile(path, current).blocks.filter(
					(block) => block.kind === '=' && block.id === id,
				);
				const target =
					locator.startLine === undefined
						? candidates[
								locator.occurrence ??
									(candidates.length === 1 ? 0 : -1)
							]
						: candidates.find(
								(block) =>
									block.startLine === locator.startLine,
							);
				if (!target)
					throw new Error(
						`Reference ${id} changed; reopen the note and try again`,
					);
				return removeBlock(current, target);
			});
			new Notice(`Deleted reference ${id}`);
		} catch (error) {
			new Notice(String(error), 8000);
		}
	}
	private async confirmConvertSource(
		id: string,
		live?: () => FileText | undefined,
	): Promise<void> {
		const files = await this.sync.filesForId(id);
		const current = live?.();
		if (current?.path) {
			const index = files.findIndex((file) => file.path === current.path);
			if (index >= 0) files[index] = current;
		}
		const copies = files
			.flatMap((file) => parseFile(file.path, file.text).blocks)
			.filter((block) => block.id === id);
		const sources = copies.filter((block) => block.kind === '+');
		if (sources.length !== 1) {
			new Notice(
				`Cannot convert ${id}: expected one source, found ${sources.length}`,
			);
			return;
		}
		const references = copies.filter((block) => block.kind === '=').length;
		const explanation = references
			? `This removes shared-block markers from the source and ${references} reference${references === 1 ? '' : 's'}. Their current Markdown stays in place, but the copies will no longer synchronize.`
			: 'This removes the shared-block markers and keeps the current Markdown as normal text.';
		new ConfirmModal(
			this.app,
			`Stop sharing ${id}?`,
			explanation,
			'Convert to normal text',
			() => {
				void this.convertSourceToNormal(id, live);
			},
		).open();
	}
	private async convertSourceToNormal(
		id: string,
		live?: () => FileText | undefined,
	): Promise<void> {
		try {
			const files = await this.sync.filesForId(id);
			const current = live?.();
			if (current?.path) {
				const index = files.findIndex(
					(file) => file.path === current.path,
				);
				if (index >= 0) files[index] = current;
			}
			const matches = files
				.flatMap((file) => parseFile(file.path, file.text).blocks)
				.filter((block) => block.id === id);
			if (matches.filter((block) => block.kind === '+').length !== 1) {
				throw new Error(`Cannot convert ${id}: its source changed`);
			}
			for (const scanned of files) {
				const blocks = matches
					.filter((block) => block.path === scanned.path)
					.sort((a, b) => b.start - a.start);
				if (!blocks.length) continue;
				const converted = blocks.reduce(
					(text, block) => unwrapBlock(text, block),
					scanned.text,
				);
				await this.sync.replaceFileText(
					scanned.path,
					scanned.text,
					converted,
				);
			}
			await this.sync.forget(id);
			new Notice(`Converted ${id} and all of its copies to normal text`);
		} catch (error) {
			new Notice(String(error), 10000);
		}
	}
	private createSharedBlock(editor: Editor, file: TFile | null): void {
		if (!file) return;
		const selection = editor.getSelection();
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		new IdModal(this.app, (id) => {
			void this.finishCreatingBlock(
				editor,
				file,
				id,
				selection,
				from,
				to,
			);
		}).open();
	}
	private async finishCreatingBlock(
		editor: Editor,
		file: TFile,
		id: string,
		selection: string,
		from: { line: number; ch: number },
		to: { line: number; ch: number },
	): Promise<void> {
		const current = editor.getValue();
		const fromOffset = editor.posToOffset(from);
		const toOffset = editor.posToOffset(to);
		if (
			parseFile(file.path, current).blocks.some(
				(block) =>
					block.kind === '=' &&
					fromOffset >= block.bodyStart &&
					toOffset <= block.bodyEnd,
			)
		) {
			new Notice(
				'Create nested sources in the source block, not in a reference',
			);
			return;
		}
		const existing = await this.sync.getSources();
		if (
			existing.some((block) => block.id === id) ||
			parseFile(file.path, current).blocks.some(
				(block) => block.id === id,
			)
		) {
			new Notice(`Shared block ${id} already exists`);
			return;
		}
		const body = selection.replace(/\n$/, '');
		editor.replaceRange(
			`<!--#${id}+-->\n${body}\n<!--#${id}/-->`,
			from,
			to,
		);
		if (!body) editor.setCursor({ line: from.line + 1, ch: 0 });
	}
	private async insertSharedBlock(editor: Editor): Promise<void> {
		const blocks = await this.sync.getSources();
		if (!blocks.length) {
			new Notice('Create a shared source block first');
			return;
		}
		new BlockPicker(this.app, blocks, (block) => {
			editor.replaceSelection(
				`<!--#${block.id}=-->\n${referenceBody(block.body, block.path)}\n<!--#${block.id}/-->`,
			);
		}).open();
	}
	private handleSyncIssues(errors: string[]): void {
		this.lastIssues = errors;
		const message = errors.join('\n');
		if (message === this.lastError) return;
		this.lastError = message;
		this.showSyncIssue(errors[0]!, errors.length);
	}
	private showSyncIssue(issue: string, count: number): void {
		const content = createFragment();
		const wrapper = createDiv({
			cls: 'full-block-embed-issue-notice',
		});
		wrapper.createDiv({
			text: `Shared block sync paused: ${issue}${count > 1 ? ` (+${count - 1} more)` : ''}`,
		});
		if (/^(.*):(\d+): /.test(issue)) {
			const button = wrapper.createEl('button', { text: 'Open issue' });
			button.addEventListener(
				'click',
				() => void this.sourceEditor.openIssue(issue),
			);
		}
		content.appendChild(wrapper);
		new Notice(content, 12000);
	}
}
