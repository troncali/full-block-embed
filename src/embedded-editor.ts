import { Component, MarkdownRenderChild, WorkspaceLeaf } from 'obsidian';
import type { Block } from './blocks';

export interface EmbeddedEditorHost {
	renderPreview(
		container: HTMLElement,
		block: Block,
		livePreview: boolean,
		owner: Component,
	): Promise<void>;
	mountLiveEditor(
		container: HTMLElement,
		id: string,
		livePreview: boolean,
		contentChanged: () => void,
	): Promise<WorkspaceLeaf | null>;
}

export class EmbeddedBlockEditor extends MarkdownRenderChild {
	private leaf: WorkspaceLeaf | null = null;
	private stopped = false;
	private activated = false;
	private previewVersion = 0;

	constructor(
		containerEl: HTMLElement,
		private host: EmbeddedEditorHost,
		private block: Block,
		private livePreview: boolean,
		private mounted?: () => void,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.tabIndex = 0;
		this.containerEl.setAttribute(
			'aria-label',
			`Edit shared block ${this.block.id}`,
		);
		this.registerDomEvent(this.containerEl, 'mousedown', (event) => {
			// Events from the mounted CodeMirror editor bubble through this
			// container. Once activation has started, leave them entirely to the
			// editor so clicks can place the cursor normally.
			if (
				this.activated ||
				this.loading ||
				event.ctrlKey ||
				event.metaKey
			)
				return;
			event.preventDefault();
			void this.loadEditor();
		});
		this.registerDomEvent(this.containerEl, 'keydown', (event) => {
			// Only the unfocused preview host uses Enter/Space as activation
			// keys. In particular, never cancel a Space typed into the embedded
			// editor after it has mounted.
			if (
				this.activated ||
				this.loading ||
				event.target !== this.containerEl ||
				(event.key !== 'Enter' && event.key !== ' ')
			)
				return;
			event.preventDefault();
			void this.loadEditor();
		});
		void this.showPreview();
	}

	onunload(): void {
		this.stopped = true;
		this.previewVersion++;
		this.leaf?.detach();
		this.leaf = null;
	}

	update(block: Block, livePreview: boolean): boolean {
		if (block.id !== this.block.id || block.path !== this.block.path)
			return false;
		const changed =
			block.body !== this.block.body || livePreview !== this.livePreview;
		this.block = block;
		this.livePreview = livePreview;
		// Keep a mounted editor and its focus intact while the outer reference is
		// synchronized. An inactive preview can be refreshed in place.
		if (changed && !this.activated) void this.showPreview();
		return true;
	}

	private async loadEditor(): Promise<void> {
		if (this.leaf || this.loading || this.stopped) return;
		this.activated = true;
		this.loading = true;
		try {
			this.containerEl.empty();
			this.containerEl.createDiv({
				cls: 'full-block-embed-loading',
				text: `Loading ${this.block.id}…`,
			});
			const leaf = await this.host.mountLiveEditor(
				this.containerEl,
				this.block.id,
				this.livePreview,
				this.mounted ?? (() => undefined),
			);
			if (this.stopped) leaf?.detach();
			else {
				this.leaf = leaf;
				this.mounted?.();
			}
		} catch (error) {
			console.error(
				'Full Block Embed: unable to create embedded editor',
				error,
			);
			if (!this.stopped) {
				this.containerEl.empty();
				this.containerEl.createDiv({
					cls: 'full-block-embed-error',
					text: `Unable to edit ${this.block.id}: ${String(error)}`,
				});
			}
		} finally {
			this.loading = false;
		}
	}

	private loading = false;

	private async showPreview(): Promise<void> {
		const version = ++this.previewVersion;
		try {
			const preview = createDiv();
			await this.host.renderPreview(
				preview,
				this.block,
				this.livePreview,
				this,
			);
			if (
				this.stopped ||
				this.activated ||
				version !== this.previewVersion
			)
				return;
			this.containerEl.empty();
			this.containerEl.appendChild(preview);
		} catch (error) {
			console.error(
				'Full Block Embed: unable to render block preview',
				error,
			);
			if (
				!this.stopped &&
				!this.activated &&
				version === this.previewVersion
			) {
				this.containerEl.empty();
				this.containerEl.createDiv({
					cls: 'full-block-embed-error',
					text: `Unable to preview ${this.block.id}`,
				});
			}
		}
	}
}
