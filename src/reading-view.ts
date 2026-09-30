import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	TFile,
} from 'obsidian';
import { parseFile, type ParseResult } from './blocks';
import { addIconButton } from './ui';

export interface ReferenceLocator {
	startLine?: number;
	occurrence?: number;
}

export interface ReadingViewActions {
	openSource(id: string): Promise<void>;
	removeReference(
		path: string,
		id: string,
		locator: ReferenceLocator,
	): Promise<void>;
	convertSource(id: string): Promise<void>;
	observeRendered(owner: object, path: string, text: string): void;
	unobserveRendered(owner: object): void;
}

class RenderedNoteObserver extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private actions: ReadingViewActions,
		private path: string,
		private text: string,
	) {
		super(containerEl);
	}

	onload(): void {
		this.actions.observeRendered(this, this.path, this.text);
	}

	onunload(): void {
		this.actions.unobserveRendered(this);
	}
}

export class ReadingViewRenderer {
	private parsedFiles = new Map<
		string,
		{ mtime: number; text: string; parsed: ParseResult }
	>();

	constructor(
		private app: App,
		private actions: ReadingViewActions,
	) {}

	private addReferenceControls(
		host: HTMLElement,
		id: string,
		ctx: MarkdownPostProcessorContext,
		locator: ReferenceLocator = {},
	): void {
		host.addClass('full-block-embed-reference');
		host.dataset.sharedBlockId = id;
		const controls = host.createDiv({
			cls: 'full-block-embed-reading-controls',
		});
		addIconButton(controls, {
			icon: 'arrow-up-right',
			title: `Open source: ${id}`,
			run: () => void this.actions.openSource(id),
		});
		addIconButton(controls, {
			icon: 'trash-2',
			title: `Delete reference: ${id}`,
			run: () =>
				void this.actions.removeReference(ctx.sourcePath, id, locator),
		});
		host.addEventListener('mousedown', (event) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			event.stopPropagation();
			void this.actions.openSource(id);
		});
	}

	private addSourceControl(host: HTMLElement, id: string): void {
		host.addClass('full-block-embed-source-section');
		const controls = host.createDiv({
			cls: 'full-block-embed-reading-controls',
		});
		addIconButton(controls, {
			icon: 'unlink',
			title: `Convert shared block to normal text: ${id}`,
			run: () => void this.actions.convertSource(id),
		});
	}

	async decorate(
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		const { text, parsed } = await this.readParsed(file);
		if (parsed.blocks.length || parsed.errors.length)
			ctx.addChild(
				new RenderedNoteObserver(el, this.actions, file.path, text),
			);
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
		const comments: Comment[] = [];
		while (walker.nextNode()) comments.push(walker.currentNode as Comment);
		const pairs: Array<{
			start: Comment;
			end: Comment;
			id: string;
			occurrence: number;
		}> = [];
		const occurrences = new Map<string, number>();
		for (const [i, comment] of comments.entries()) {
			const match = /^\s*#([^\s]+)=\s*$/.exec(comment.data);
			if (!match) continue;
			const id = match[1]!;
			const end = comments
				.slice(i + 1)
				.find((candidate) => candidate.data.trim() === `#${id}/`);
			if (!end) continue;
			const occurrence = occurrences.get(id) || 0;
			occurrences.set(id, occurrence + 1);
			pairs.push({ start: comment, end, id, occurrence });
		}
		for (const pair of pairs.reverse()) {
			if (!pair.start.parentNode || !pair.end.parentNode) continue;
			const host = createDiv();
			const range = document.createRange();
			range.setStartAfter(pair.start);
			range.setEndBefore(pair.end);
			host.appendChild(range.extractContents());
			range.insertNode(host);
			pair.start.remove();
			pair.end.remove();
			this.addReferenceControls(host, pair.id, ctx, {
				occurrence: pair.occurrence,
			});
		}
		if (
			pairs.length ||
			comments.some((comment) => /^\s*#.*=\s*$/.test(comment.data))
		)
			return;

		// Obsidian commonly discards comments and processes one rendered section
		// at a time. Keep every rendered section intact and decorate each section
		// that belongs to the reference.
		const section = ctx.getSectionInfo(el);
		if (!section) return;
		const blocks = parsed.blocks;
		const refs = blocks.filter(
			(block) =>
				block.kind === '=' &&
				block.startLine <= section.lineStart &&
				block.endLine >= section.lineEnd - 1,
		);
		if (refs.length) {
			const ref = refs.sort(
				(a, b) =>
					b.depth - a.depth || a.end - a.start - (b.end - b.start),
			)[0]!;
			this.addReferenceControls(el, ref.id, ctx, {
				startLine: ref.startLine,
			});
			return;
		}
		const sources = blocks.filter(
			(block) =>
				block.kind === '+' &&
				block.startLine <= section.lineStart &&
				block.endLine >= section.lineEnd - 1,
		);
		if (sources.length) {
			const source = sources.sort(
				(a, b) =>
					b.depth - a.depth || a.end - a.start - (b.end - b.start),
			)[0]!;
			el.addClass('full-block-embed-source-section');
			el.dataset.sharedBlockId = source.id;
			if (section.lineStart <= source.startLine + 1)
				this.addSourceControl(el, source.id);
		}
	}

	private async readParsed(
		file: TFile,
	): Promise<{ text: string; parsed: ParseResult }> {
		const cached = this.parsedFiles.get(file.path);
		if (cached?.mtime === file.stat.mtime) return cached;
		const text = await this.app.vault.cachedRead(file);
		const parsed = parseFile(file.path, text);
		this.parsedFiles.set(file.path, {
			mtime: file.stat.mtime,
			text,
			parsed,
		});
		return { text, parsed };
	}
}
