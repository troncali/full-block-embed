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
			if (event.ctrlKey || event.metaKey) return;
			event.preventDefault();
			void this.loadEditor();
		});
		this.registerDomEvent(this.containerEl, 'keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			void this.loadEditor();
		});
		void this.showPreview();
	}

	onunload(): void {
		this.stopped = true;
		this.leaf?.detach();
		this.leaf = null;
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
		try {
			const preview = createDiv();
			await this.host.renderPreview(
				preview,
				this.block,
				this.livePreview,
				this,
			);
			if (this.stopped || this.activated) return;
			this.containerEl.empty();
			this.containerEl.appendChild(preview);
		} catch (error) {
			console.error(
				'Full Block Embed: unable to render block preview',
				error,
			);
			if (!this.stopped) {
				this.containerEl.empty();
				this.containerEl.createDiv({
					cls: 'full-block-embed-error',
					text: `Unable to preview ${this.block.id}`,
				});
			}
		}
	}
}
