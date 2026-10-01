import {
	Facet,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
	type Range,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView as CodeMirrorEditorView,
	type ViewUpdate,
	ViewPlugin,
	WidgetType,
} from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import { applyPatches, Block, parseFile, type Patch } from './blocks';
import {
	EmbeddedBlockEditor,
	type EmbeddedEditorHost,
} from './embedded-editor';
import { addIconButton } from './ui';

const embeddedEditor = Facet.define<boolean, boolean>({
	combine: (values) => values.some(Boolean),
});

export interface EditingActions extends EmbeddedEditorHost {
	openSource: (id: string) => void;
	removeReference: (view: CodeMirrorEditorView, block: Block) => void;
	convertSource: (view: CodeMirrorEditorView, block: Block) => void;
	observeEditor: (
		owner: object,
		path: string,
		text: string,
		document: {
			read(): string;
			apply(patches: Patch[]): boolean;
		},
		editedInObsidian: boolean,
	) => void;
	unobserveEditor: (owner: object) => void;
}

const referenceEditors = new WeakMap<HTMLElement, EmbeddedBlockEditor>();

class ReferenceEditorWidget extends WidgetType {
	constructor(
		private block: Block,
		private livePreview: boolean,
		private actions: EditingActions,
	) {
		super();
	}

	eq(other: ReferenceEditorWidget): boolean {
		return (
			other.block.id === this.block.id &&
			other.block.path === this.block.path &&
			other.block.start === this.block.start &&
			other.block.body === this.block.body &&
			other.livePreview === this.livePreview
		);
	}

	toDOM(view: CodeMirrorEditorView): HTMLElement {
		const host = createDiv({
			cls: [
				'full-block-embed-reference',
				'full-block-embed-editing-reference',
			],
		});
		host.dataset.sharedBlockId = this.block.id;
		const controls = host.createDiv({
			cls: 'full-block-embed-reading-controls',
		});
		addIconButton(controls, {
			icon: 'arrow-up-right',
			title: `Open source: ${this.block.id}`,
			run: () => this.actions.openSource(this.block.id),
		});
		addIconButton(controls, {
			icon: 'trash-2',
			title: `Delete reference: ${this.block.id}`,
			run: () => this.actions.removeReference(view, this.block),
		});
		host.addEventListener('mousedown', (event) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			event.stopPropagation();
			this.actions.openSource(this.block.id);
		});
		const component = new EmbeddedBlockEditor(
			host.createDiv({ cls: 'full-block-embed-editor' }),
			this.actions,
			this.block,
			this.livePreview,
			() => view.requestMeasure(),
		);
		referenceEditors.set(host, component);
		component.load();
		return host;
	}

	destroy(dom: HTMLElement): void {
		referenceEditors.get(dom)?.unload();
		referenceEditors.delete(dom);
	}

	updateDOM(dom: HTMLElement): boolean {
		return (
			referenceEditors.get(dom)?.update(this.block, this.livePreview) ??
			false
		);
	}

	ignoreEvent(): boolean {
		return true;
	}
}

class BlockControlsWidget extends WidgetType {
	constructor(
		private block: Block,
		private actions: EditingActions,
	) {
		super();
	}
	eq(other: BlockControlsWidget): boolean {
		return (
			other.block.id === this.block.id &&
			other.block.kind === this.block.kind &&
			other.block.start === this.block.start
		);
	}
	toDOM(view: CodeMirrorEditorView): HTMLElement {
		const controls = createSpan({
			cls: 'full-block-embed-editing-controls',
		});
		if (this.block.kind === '=') {
			addIconButton(controls, {
				icon: 'arrow-up-right',
				title: `Open source: ${this.block.id}`,
				run: () => this.actions.openSource(this.block.id),
			});
			addIconButton(controls, {
				icon: 'trash-2',
				title: `Delete reference: ${this.block.id}`,
				run: () => this.actions.removeReference(view, this.block),
			});
		} else {
			addIconButton(controls, {
				icon: 'unlink',
				title: `Convert shared block to normal text: ${this.block.id}`,
				run: () => this.actions.convertSource(view, this.block),
			});
		}
		return controls;
	}
}

function decorations(
	state: EditorState,
	actions: EditingActions,
): DecorationSet {
	if (state.facet(embeddedEditor)) return Decoration.none;
	const ranges: Array<Range<Decoration>> = [];
	const text = state.doc.toString();
	if (!text.includes('<!--#')) return Decoration.none;
	const path = state.field(editorInfoField, false)?.file?.path || '';
	const livePreview = state.field(editorLivePreviewField, false) ?? false;
	const blocks = parseFile(path, text).blocks;
	for (const block of blocks) {
		if (block.kind === '=') {
			// The outer widget renders its complete Markdown body. Decorating a
			// nested reference as well would create overlapping atomic ranges.
			if (
				blocks.some(
					(parent) =>
						parent.kind === '=' &&
						parent.start < block.start &&
						parent.end > block.end,
				)
			)
				continue;
			ranges.push(
				Decoration.replace({
					block: true,
					widget: new ReferenceEditorWidget(
						block,
						livePreview,
						actions,
					),
				}).range(block.start, block.end),
			);
			continue;
		}
		for (let line = block.startLine + 1; line < block.endLine; line++)
			ranges.push(
				Decoration.line({
					class: 'full-block-embed-source-editing-line',
				}).range(state.doc.line(line + 1).from),
			);
		const first = state.doc.lineAt(
			Math.min(block.bodyStart, state.doc.length),
		);
		ranges.push(
			Decoration.line({ class: 'full-block-embed-editing-first' }).range(
				first.from,
			),
		);
		ranges.push(
			Decoration.widget({
				widget: new BlockControlsWidget(block, actions),
				side: 1,
			}).range(first.to),
		);
		ranges.push(
			Decoration.line({ class: 'full-block-embed-marker-line' }).range(
				state.doc.line(block.startLine + 1).from,
			),
		);
		ranges.push(
			Decoration.line({ class: 'full-block-embed-marker-line' }).range(
				state.doc.line(block.endLine + 1).from,
			),
		);
	}
	return Decoration.set(ranges, true);
}

export function editingExtension(actions: EditingActions): Extension {
	const observer = ViewPlugin.fromClass(
		class {
			constructor(private view: CodeMirrorEditorView) {
				this.publish(false);
			}

			update(update: ViewUpdate): void {
				const oldPath = update.startState.field(editorInfoField, false)
					?.file?.path;
				const path = update.state.field(editorInfoField, false)?.file
					?.path;
				if (update.docChanged || oldPath !== path)
					// A document transaction in an Obsidian editor is an approved
					// in-app change even when Obsidian or an input method omits the
					// CodeMirror user-event annotation. Filesystem changes still take
					// the guarded outside-edit path because they do not pass here.
					this.publish(update.docChanged);
			}

			destroy(): void {
				actions.unobserveEditor(this);
			}

			private publish(editedInObsidian: boolean): void {
				const path = this.view.state.field(editorInfoField, false)?.file
					?.path;
				const text = this.view.state.doc.toString();
				if (!path || !text.includes('<!--#')) {
					actions.unobserveEditor(this);
					return;
				}
				actions.observeEditor(
					this,
					path,
					text,
					{
						read: () => this.view.state.doc.toString(),
						apply: (patches) => this.apply(patches),
					},
					editedInObsidian,
				);
			}

			private apply(patches: Patch[]): boolean {
				const current = this.view.state.doc.toString();
				try {
					applyPatches(current, patches);
				} catch {
					return false;
				}
				this.view.dispatch({
					changes: [...patches]
						.sort((a, b) => a.from - b.from)
						.map((patch) => ({
							from: patch.from,
							to: patch.to,
							insert: patch.body,
						})),
				});
				return true;
			}
		},
	);
	const field = StateField.define<DecorationSet>({
		create: (state) => decorations(state, actions),
		update: (current, transaction) => {
			const oldEmbedded = transaction.startState.facet(embeddedEditor);
			const isEmbedded = transaction.state.facet(embeddedEditor);
			const oldLivePreview = transaction.startState.field(
				editorLivePreviewField,
				false,
			);
			const livePreview = transaction.state.field(
				editorLivePreviewField,
				false,
			);
			const oldPath = transaction.startState.field(editorInfoField, false)
				?.file?.path;
			const path = transaction.state.field(editorInfoField, false)?.file
				?.path;
			return transaction.docChanged ||
				oldEmbedded !== isEmbedded ||
				oldLivePreview !== livePreview ||
				oldPath !== path
				? decorations(transaction.state, actions)
				: current;
		},
		provide: (value) => CodeMirrorEditorView.decorations.from(value),
	});
	return [
		observer,
		field,
		CodeMirrorEditorView.atomicRanges.of((view) => view.state.field(field)),
	];
}

export function viewportExtension(
	path: string,
	id: string,
	livePreview: boolean,
	contentChanged: () => void,
): Extension {
	const focusChanged = StateEffect.define<boolean>();
	interface ViewportState {
		decorations: DecorationSet;
		focused: boolean;
	}
	const getDecorations = (text: string, focused: boolean): DecorationSet => {
		const block = parseFile(path, text).blocks.find(
			(candidate) => candidate.id === id && candidate.kind === '+',
		);
		if (!block) return Decoration.none;
		const ranges: Array<Range<Decoration>> = [];
		for (const position of [block.start, block.bodyEnd])
			ranges.push(
				Decoration.line({
					class: 'full-block-embed-marker-line',
				}).range(position),
			);
		if (block.start > 0)
			ranges.push(
				Decoration.replace({ block: true }).range(0, block.start),
			);
		if (block.end < text.length)
			ranges.push(
				Decoration.replace({ block: true }).range(
					block.end,
					text.length,
				),
			);
		if (livePreview && !focused) {
			const body = text.slice(block.bodyStart, block.bodyEnd);
			for (const match of body.matchAll(/%%[\s\S]*?%%/g)) {
				const from = block.bodyStart + (match.index ?? 0);
				ranges.push(
					Decoration.replace({}).range(from, from + match[0].length),
				);
			}
		}
		return Decoration.set(ranges, true);
	};
	const field = StateField.define<ViewportState>({
		create: (state) => ({
			decorations: getDecorations(state.doc.toString(), false),
			focused: false,
		}),
		update: (current, transaction) => {
			let focused = current.focused;
			for (const effect of transaction.effects)
				if (effect.is(focusChanged)) focused = effect.value;
			return transaction.docChanged || focused !== current.focused
				? {
						decorations: getDecorations(
							transaction.state.doc.toString(),
							focused,
						),
						focused,
					}
				: current;
		},
		provide: (value) =>
			CodeMirrorEditorView.decorations.from(
				value,
				(state) => state.decorations,
			),
	});
	return [
		embeddedEditor.of(true),
		field,
		CodeMirrorEditorView.atomicRanges.of(
			(view) => view.state.field(field).decorations,
		),
		CodeMirrorEditorView.domEventHandlers({
			focus: (_event, view) => {
				view.dispatch({ effects: focusChanged.of(true) });
			},
			blur: (_event, view) => {
				view.dispatch({ effects: focusChanged.of(false) });
			},
		}),
		CodeMirrorEditorView.updateListener.of((update) => {
			if (update.docChanged || update.geometryChanged)
				window.requestAnimationFrame(contentChanged);
		}),
		CodeMirrorEditorView.contentAttributes.of({
			'aria-label': `Shared block ${id}`,
		}),
	];
}
