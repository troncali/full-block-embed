import { App, Modal, Notice, SuggestModal, setIcon } from 'obsidian';
import { Block, validId } from './blocks';

export interface IconAction {
	icon: string;
	title: string;
	run: () => void;
}

export function addIconButton(
	container: HTMLElement,
	action: IconAction,
): HTMLButtonElement {
	const button = container.createEl('button', {
		cls: 'full-block-embed-control',
		attr: {
			type: 'button',
			title: action.title,
			'aria-label': action.title,
		},
	});
	setIcon(button, action.icon);
	const stop = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	button.addEventListener('mousedown', stop);
	button.addEventListener('click', (event) => {
		stop(event);
		action.run();
	});
	return button;
}

export class IdModal extends Modal {
	constructor(
		app: App,
		private done: (id: string) => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle('Name the shared block');
		const input = this.contentEl.createEl('input', {
			attr: { placeholder: 'Example: company-acme-summary' },
		});
		this.contentEl.createDiv({
			cls: 'full-block-embed-help',
			text: 'Letters, numbers, hyphens; start with a letter.',
		});
		input.focus();
		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			const id = input.value.trim();
			if (!validId(id)) {
				new Notice('Invalid shared block ID');
				return;
			}
			this.close();
			this.done(id);
		});
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

export class BlockPicker extends SuggestModal<Block> {
	constructor(
		app: App,
		private blocks: Block[],
		private done: (block: Block) => void,
	) {
		super(app);
	}
	getSuggestions(query: string): Block[] {
		return this.blocks
			.filter((block) =>
				block.id.toLowerCase().includes(query.toLowerCase()),
			)
			.slice(0, 100);
	}
	renderSuggestion(block: Block, el: HTMLElement): void {
		el.createDiv({ text: block.id });
		el.createEl('small', { text: block.path });
	}
	onChooseSuggestion(block: Block): void {
		this.done(block);
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private explanation: string,
		private confirmLabel: string,
		private done: () => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl('p', { text: this.explanation });
		const actions = this.contentEl.createDiv({
			cls: 'full-block-embed-modal-actions',
		});
		actions
			.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => this.close());
		const confirm = actions.createEl('button', {
			text: this.confirmLabel,
			cls: 'mod-warning',
		});
		confirm.addEventListener('click', () => {
			this.close();
			this.done();
		});
		confirm.focus();
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
