import { Plugin, TFile } from 'obsidian';
import {
	applyPatches,
	Block,
	FileText,
	normalize,
	parseFile,
	Patch,
	planSync,
	referenceChangeKey,
	sourceChangeKey,
} from './blocks';
import { nestedSyncOrder, rebaseContainingFingerprints } from './nesting';
import {
	createStoredSyncData,
	LegacyStoredSyncData,
	loadSyncState,
} from './sync-state';

export type { LegacyStoredSyncData } from './sync-state';

const INDEX_CHUNK_SIZE = 50;
const SYNC_DELAY = 250;
const MARKER_ID = /<!--#\/?([^\s>]+?)(?=[+=/]|-->|\s)/g;

export interface LiveDocument {
	read(): string;
	apply(patches: Patch[]): boolean;
}

interface Observation {
	path: string;
	ids: Set<string>;
	text: string;
	document?: LiveDocument;
}

interface IndexedFile {
	mtime: number;
	size: number;
	ids: Set<string>;
	sourceIds: Set<string>;
}

export interface SyncManagerCallbacks {
	onIssues(errors: string[]): void;
	onClearIssues(): void;
}

/**
 * Keeps a disk-backed structural index and validates it only when a displayed
 * block (or an explicit command) needs synchronization. Block bodies remain in
 * Markdown; plugin data contains fingerprints and file metadata only.
 */
export class BlockSyncManager {
	private hashes: Record<string, string> = {};
	private knownRefs: Record<string, boolean> = {};
	private savedSourcePaths: Record<string, string> = {};
	private observations = new Map<object, Observation>();
	private activeIds = new Set<string>();
	private files = new Map<string, IndexedFile>();
	private pathsById = new Map<string, Set<string>>();
	private sourcePathsById = new Map<string, Set<string>>();
	private dirtyPaths = new Set<string>();
	private queuedIds = new Set<string>();
	private localChanges = new Set<string>();
	private indexReady = false;
	private indexValidated = false;
	private indexPromise: Promise<void> | null = null;
	private syncTimer: number | null = null;
	private dirtyTimer: number | null = null;
	private running = false;
	private rerun = false;

	constructor(
		private plugin: Plugin,
		private callbacks: SyncManagerCallbacks,
	) {}

	load(raw: LegacyStoredSyncData | null): void {
		const stored = loadSyncState(raw);
		this.hashes = stored.hashes;
		this.knownRefs = stored.knownRefs;
		this.savedSourcePaths = stored.sourcePaths;

		if (!stored.files) return;
		for (const [path, entry] of Object.entries(stored.files))
			if (entry.ids.length)
				this.addIndexedPath(path, {
					mtime: entry.mtime,
					size: entry.size,
					ids: new Set(entry.ids),
					sourceIds: new Set(entry.sourceIds),
				});
		this.indexReady = true;
		// Stat indexed block notes when a shared block is first displayed. This
		// finds outside changes without retaining or reading every vault note.
		this.indexValidated = false;
	}

	unload(): void {
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		this.syncTimer = null;
		this.dirtyTimer = null;
		this.observations.clear();
		this.activeIds.clear();
	}

	observe(
		owner: object,
		path: string,
		text: string,
		document?: LiveDocument,
		editedInObsidian = false,
	): void {
		const parsed = parseFile(path, text);
		const ids = markerIds(text, parsed.blocks);
		const previous = this.observations.get(owner);
		if (!ids.size && !parsed.errors.length) {
			if (previous) this.unobserve(owner);
			return;
		}
		if (editedInObsidian && previous?.path === path)
			for (const key of changedBlockKeys(path, previous.text, text))
				this.localChanges.add(key);
		this.observations.set(owner, { path, ids, text, document });
		this.indexParsed(path, text, parsed.blocks);
		this.rebuildActiveIds();
		const requested = new Set([...ids, ...(previous?.ids ?? [])]);
		if (requested.size) this.queue(requested, previous ? SYNC_DELAY : 0);
	}

	unobserve(owner: object): void {
		if (!this.observations.delete(owner)) return;
		this.rebuildActiveIds();
		for (const id of this.queuedIds)
			if (!this.activeIds.has(id)) this.queuedIds.delete(id);
		if (!this.queuedIds.size && this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}

	markModified(file: TFile): void {
		// A legacy cache has no structural index yet; its eventual first scan will
		// include this change. Once an index exists, events let an unindexed note
		// gain its first block without retaining every empty note in plugin data.
		if (!this.indexReady && !this.indexPromise) return;
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		if (this.activeIds.size) this.scheduleDirtyPaths();
	}

	markDeleted(file: TFile): void {
		const previous = this.files.get(file.path)?.ids ?? new Set<string>();
		this.removeIndexedPath(file.path);
		this.dirtyPaths.delete(file.path);
		this.indexValidated = false;
		const affected = intersection(previous, this.activeIds);
		if (affected.size) this.queue(affected, 0);
	}

	markRenamed(file: TFile, oldPath: string): void {
		const previous = this.files.get(oldPath)?.ids ?? new Set<string>();
		this.removeIndexedPath(oldPath);
		this.dirtyPaths.delete(oldPath);
		this.dirtyPaths.add(file.path);
		this.indexValidated = false;
		for (const [id, path] of Object.entries(this.savedSourcePaths))
			if (path === oldPath) this.savedSourcePaths[id] = file.path;
		if (this.activeIds.size) this.scheduleDirtyPaths();
		const affected = intersection(previous, this.activeIds);
		if (affected.size) this.queue(affected, SYNC_DELAY);
	}

	async synchronizeAll(): Promise<void> {
		await this.ensureIndex(true);
		await this.synchronize(new Set(this.pathsById.keys()));
	}

	async getSources(): Promise<Block[]> {
		await this.ensureIndex();
		const sources: Block[] = [];
		for (const [id, paths] of this.sourcePathsById)
			for (const path of paths) {
				const located = await this.readSource(path, id);
				if (located) sources.push(located.block);
			}
		return sources.sort((a, b) => a.id.localeCompare(b.id));
	}

	async findSource(
		id: string,
	): Promise<{ block: Block; file: TFile } | null> {
		await this.ensureIndex();
		const paths = this.sourcePathsById.get(id);
		if (!paths || paths.size !== 1) return null;
		const located = await this.readSource([...paths][0]!, id);
		if (!located) {
			delete this.savedSourcePaths[id];
			return null;
		}
		return located;
	}

	async filesForId(id: string): Promise<FileText[]> {
		await this.ensureIndex();
		return this.readFiles(this.pathsById.get(id) ?? new Set());
	}

	async replaceFileText(
		path: string,
		expected: string,
		replacement: string,
	): Promise<void> {
		const patch: Patch = {
			path,
			from: 0,
			to: expected.length,
			oldBody: expected,
			body: replacement,
		};
		await this.applyFilePatches(path, [patch], [{ path, text: expected }]);
		await this.persist();
	}

	async forget(id: string): Promise<void> {
		delete this.hashes[id];
		delete this.savedSourcePaths[id];
		this.knownRefs = Object.fromEntries(
			Object.entries(this.knownRefs).filter(
				([key]) => key.split('\u0000')[1] !== id,
			),
		);
		this.clearLocalChanges(new Set([id]));
		await this.persist();
	}

	private rebuildActiveIds(): void {
		this.activeIds = new Set(
			[...this.observations.values()].flatMap((observation) => [
				...observation.ids,
			]),
		);
	}

	private queue(ids: Iterable<string>, delay: number): void {
		for (const id of ids) this.queuedIds.add(id);
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.drainQueue();
		}, delay);
	}

	private async drainQueue(): Promise<void> {
		if (this.running) {
			this.rerun = true;
			return;
		}
		const ids = new Set(this.queuedIds);
		this.queuedIds.clear();
		if (!ids.size) return;
		await this.ensureIndex();
		await this.synchronize(ids);
	}

	private async synchronize(ids: Set<string>): Promise<void> {
		if (this.running) {
			for (const id of ids) this.queuedIds.add(id);
			this.rerun = true;
			return;
		}
		this.running = true;
		try {
			const scope = await this.expandNestedScope(ids);
			ids = scope.ids;
			// Always re-read all known copies for the requested IDs. The index only
			// locates files; hashes decide whether an outside edit is safe to apply.
			let scanned = scope.files;
			const order = nestedSyncOrder(scanned, ids);
			if (order.errors.length) {
				await this.persist();
				this.callbacks.onIssues(order.errors);
				return;
			}
			let nextHashes = this.hashes;
			let nextRefs = this.knownRefs;
			const stages: Array<{
				files: FileText[];
				patchesByPath: Map<string, Patch[]>;
			}> = [];
			for (const id of order.ids) {
				const plan = planSync(
					scanned,
					nextHashes,
					nextRefs,
					new Set([id]),
					this.localChanges,
				);
				if (plan.errors.length) {
					await this.persist();
					this.callbacks.onIssues(plan.errors);
					return;
				}
				const patchesByPath = groupPatchesByPath(plan.patches);
				if (patchesByPath.size)
					stages.push({ files: scanned, patchesByPath });
				const updated = scanned.map((file) => {
					const patches = patchesByPath.get(file.path);
					return patches
						? { ...file, text: applyPatches(file.text, patches) }
						: file;
				});
				nextHashes = plan.next;
				rebaseContainingFingerprints(
					scanned,
					updated,
					patchesByPath,
					nextHashes,
				);
				nextRefs = plan.nextRefs;
				scanned = updated;
			}
			this.callbacks.onClearIssues();
			for (const stage of stages)
				for (const [path, patches] of stage.patchesByPath)
					await this.applyFilePatches(path, patches, stage.files);
			this.hashes = nextHashes;
			this.knownRefs = nextRefs;
			this.clearLocalChanges(ids);
			this.refreshSavedSourcePaths(ids);
			await this.persist();
		} catch (error) {
			console.error(
				'Full Block Embed: synchronization interrupted',
				error,
			);
			this.callbacks.onIssues([
				`Synchronization interrupted: ${String(error)}`,
			]);
		} finally {
			this.running = false;
			if (this.rerun || this.queuedIds.size) {
				this.rerun = false;
				this.queue([], SYNC_DELAY);
			}
		}
	}

	private async expandNestedScope(
		requested: ReadonlySet<string>,
	): Promise<{ ids: Set<string>; files: FileText[] }> {
		const ids = new Set(requested);
		const paths = new Set<string>();
		let changed = true;
		let files: FileText[] = [];
		while (changed) {
			changed = false;
			for (const id of ids)
				for (const path of this.pathsById.get(id) ?? [])
					if (!paths.has(path)) {
						paths.add(path);
						changed = true;
					}
			files = await this.readFiles(paths);
			for (const file of files) {
				const blocks = parseFile(file.path, file.text).blocks;
				for (const parent of blocks) {
					if (!ids.has(parent.id)) continue;
					for (const child of blocks)
						if (
							child.start > parent.start &&
							child.end < parent.end &&
							!ids.has(child.id)
						) {
							ids.add(child.id);
							changed = true;
						}
				}
			}
		}
		return { ids, files };
	}

	private async applyFilePatches(
		path: string,
		patches: Patch[],
		scanned: FileText[],
	): Promise<void> {
		const expected = scanned.find((file) => file.path === path)?.text;
		if (expected === undefined)
			throw new Error(`Scanned note disappeared: ${path}`);
		const live = this.liveDocument(path);
		if (live && live.read() === expected && live.apply(patches)) {
			this.indexText(path, applyPatches(expected, patches));
			return;
		}
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile))
			throw new Error(`Note disappeared: ${path}`);
		let updated = expected;
		await this.plugin.app.vault.process(file, (current) => {
			if (current !== expected)
				throw new Error(`Concurrent edit in ${path}; retrying`);
			updated = applyPatches(current, patches);
			return updated;
		});
		this.indexText(path, updated, file.stat.mtime, file.stat.size);
	}

	private liveDocument(path: string): LiveDocument | undefined {
		return [...this.observations.values()].find(
			(observation) =>
				observation.path === path && observation.document !== undefined,
		)?.document;
	}

	private async readFiles(paths: Iterable<string>): Promise<FileText[]> {
		const result: FileText[] = [];
		for (const path of paths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const live = this.liveDocument(path);
			result.push({
				path,
				text: live?.read() ?? (await this.plugin.app.vault.read(file)),
			});
		}
		return result;
	}

	private async readSource(
		path: string,
		id: string,
	): Promise<{ block: Block; file: TFile } | null> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		const text =
			this.liveDocument(path)?.read() ??
			(await this.plugin.app.vault.read(file));
		const block = parseFile(path, text).blocks.find(
			(candidate) => candidate.id === id && candidate.kind === '+',
		);
		return block ? { block, file } : null;
	}

	private scheduleDirtyPaths(): void {
		if (this.dirtyTimer !== null) window.clearTimeout(this.dirtyTimer);
		this.dirtyTimer = window.setTimeout(() => {
			this.dirtyTimer = null;
			void this.drainDirtyPaths();
		}, SYNC_DELAY);
	}

	private async drainDirtyPaths(): Promise<void> {
		const paths = [...this.dirtyPaths];
		for (const path of paths) this.dirtyPaths.delete(path);
		const affected = new Set<string>();
		for (const path of paths) {
			const before = this.files.get(path)?.ids ?? new Set<string>();
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.scanFile(file);
			else this.removeIndexedPath(path);
			const after = this.files.get(path)?.ids ?? new Set<string>();
			for (const id of [...before, ...after])
				if (this.activeIds.has(id)) affected.add(id);
		}
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
		await this.persist();
		if (affected.size) this.queue(affected, 0);
		else if (this.dirtyPaths.size) this.scheduleDirtyPaths();
	}

	private async ensureIndex(force = false): Promise<void> {
		if (this.indexPromise) return this.indexPromise;
		if (this.indexReady && this.indexValidated && !force) return;
		this.indexPromise = this.prepareIndex(force);
		try {
			await this.indexPromise;
			await this.persist();
		} finally {
			this.indexPromise = null;
		}
	}

	private async prepareIndex(force: boolean): Promise<void> {
		if (force || !this.indexReady) await this.scanVault();
		else await this.refreshChangedFiles();
		while (!this.indexValidated) await this.refreshChangedFiles();
	}

	private async scanVault(): Promise<void> {
		this.files.clear();
		this.pathsById.clear();
		this.sourcePathsById.clear();
		this.dirtyPaths.clear();
		const files = this.plugin.app.vault.getMarkdownFiles();
		for (let i = 0; i < files.length; i += INDEX_CHUNK_SIZE) {
			for (const file of files.slice(i, i + INDEX_CHUNK_SIZE))
				await this.scanFile(file);
			await yieldToUi();
		}
		this.indexReady = true;
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
	}

	private async refreshChangedFiles(): Promise<void> {
		const dirty = new Set(this.dirtyPaths);
		for (const path of dirty) this.dirtyPaths.delete(path);
		const candidates = new Map<string, TFile>();
		for (const path of new Set([...this.files.keys(), ...dirty])) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === 'md')
				candidates.set(path, file);
			else this.removeIndexedPath(path);
		}
		const changed = [...candidates.values()].filter((file) => {
			const indexed = this.files.get(file.path);
			return (
				dirty.has(file.path) ||
				(indexed !== undefined &&
					(indexed.mtime !== file.stat.mtime ||
						indexed.size !== file.stat.size))
			);
		});
		for (let i = 0; i < changed.length; i += INDEX_CHUNK_SIZE) {
			for (const file of changed.slice(i, i + INDEX_CHUNK_SIZE))
				await this.scanFile(file);
			await yieldToUi();
		}
		this.indexReady = true;
		this.indexValidated = this.dirtyPaths.size === 0;
		this.refreshAllSavedSourcePaths();
	}

	private async scanFile(file: TFile): Promise<void> {
		try {
			const live = this.liveDocument(file.path);
			const text =
				live?.read() ?? (await this.plugin.app.vault.cachedRead(file));
			this.indexText(file.path, text, file.stat.mtime, file.stat.size);
		} catch (error) {
			console.error(
				`Full Block Embed: unable to scan ${file.path}`,
				error,
			);
		}
	}

	private indexText(
		path: string,
		text: string,
		mtime?: number,
		size?: number,
	): void {
		this.indexParsed(path, text, parseFile(path, text).blocks, mtime, size);
	}

	private indexParsed(
		path: string,
		text: string,
		blocks: Block[],
		mtime?: number,
		size?: number,
	): void {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		const stat = file instanceof TFile ? file.stat : undefined;
		const ids = markerIds(text, blocks);
		const sourceIds = new Set(
			blocks
				.filter((block) => block.kind === '+')
				.map((block) => block.id),
		);
		this.removeIndexedPath(path);
		if (ids.size)
			this.addIndexedPath(path, {
				mtime: mtime ?? stat?.mtime ?? 0,
				size: size ?? stat?.size ?? text.length,
				ids,
				sourceIds,
			});
	}

	private addIndexedPath(path: string, indexed: IndexedFile): void {
		this.files.set(path, indexed);
		for (const id of indexed.ids) addPath(this.pathsById, id, path);
		for (const id of indexed.sourceIds)
			addPath(this.sourcePathsById, id, path);
	}

	private removeIndexedPath(path: string): void {
		const previous = this.files.get(path);
		if (!previous) return;
		for (const id of previous.ids) removePath(this.pathsById, id, path);
		for (const id of previous.sourceIds)
			removePath(this.sourcePathsById, id, path);
		this.files.delete(path);
	}

	private refreshSavedSourcePaths(ids: Iterable<string>): void {
		for (const id of ids) {
			const paths = this.sourcePathsById.get(id);
			if (paths?.size === 1) this.savedSourcePaths[id] = [...paths][0]!;
			else delete this.savedSourcePaths[id];
		}
	}

	private refreshAllSavedSourcePaths(): void {
		this.refreshSavedSourcePaths(
			new Set([
				...this.sourcePathsById.keys(),
				...Object.keys(this.savedSourcePaths),
			]),
		);
	}

	private clearLocalChanges(ids: ReadonlySet<string>): void {
		for (const key of this.localChanges)
			if (ids.has(key.split('\u0000')[1] ?? ''))
				this.localChanges.delete(key);
	}

	private async persist(): Promise<void> {
		await this.plugin.saveData(
			createStoredSyncData(
				this.hashes,
				this.knownRefs,
				this.savedSourcePaths,
				this.files,
			),
		);
	}
}

function groupPatchesByPath(patches: Patch[]): Map<string, Patch[]> {
	const result = new Map<string, Patch[]>();
	for (const patch of patches)
		result.set(patch.path, [...(result.get(patch.path) ?? []), patch]);
	return result;
}

function addPath(
	index: Map<string, Set<string>>,
	id: string,
	path: string,
): void {
	const paths = index.get(id) ?? new Set<string>();
	paths.add(path);
	index.set(id, paths);
}

function removePath(
	index: Map<string, Set<string>>,
	id: string,
	path: string,
): void {
	const paths = index.get(id);
	if (!paths) return;
	paths.delete(path);
	if (!paths.size) index.delete(id);
}

function intersection(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): Set<string> {
	return new Set([...a].filter((value) => b.has(value)));
}

function markerIds(text: string, blocks: Block[]): Set<string> {
	const ids = new Set(blocks.map((block) => block.id));
	for (const match of text.matchAll(MARKER_ID))
		if (match[1]) ids.add(match[1]);
	return ids;
}

function changedBlockKeys(
	path: string,
	previousText: string,
	currentText: string,
): Set<string> {
	const previous = blockBodiesByKey(path, previousText);
	const current = blockBodiesByKey(path, currentText);
	return new Set(
		[...current].flatMap(([key, body]) =>
			previous.get(key) === body ? [] : [key],
		),
	);
}

function blockBodiesByKey(path: string, text: string): Map<string, string> {
	const result = new Map<string, string>();
	const ordinals = new Map<string, number>();
	for (const block of parseFile(path, text).blocks) {
		if (block.kind === '+') {
			result.set(sourceChangeKey(path, block.id), normalize(block.body));
			continue;
		}
		const ordinal = ordinals.get(block.id) ?? 0;
		ordinals.set(block.id, ordinal + 1);
		result.set(
			referenceChangeKey(path, block.id, ordinal),
			normalize(block.body),
		);
	}
	return result;
}

function yieldToUi(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}
