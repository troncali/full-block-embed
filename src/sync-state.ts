import { contentFingerprint, normalize } from './blocks';

export interface StoredFileIndex {
	mtime: number;
	size: number;
	ids: string[];
	sourceIds: string[];
}

export interface StoredSyncDataV3 {
	version: 3;
	hashes: Record<string, string>;
	knownRefs: Record<string, boolean>;
	sourcePaths: Record<string, string>;
	files: Record<string, StoredFileIndex>;
}

export interface LegacyStoredSyncData {
	version?: number;
	hashes?: Record<string, string>;
	revisions?: Record<string, string>;
	knownRefs?: Record<string, boolean>;
	sourcePaths?: Record<string, string>;
	files?: Record<string, StoredFileIndex>;
}

export interface IndexedFileMetadata {
	mtime: number;
	size: number;
	ids: ReadonlySet<string>;
	sourceIds: ReadonlySet<string>;
}

export interface LoadedSyncState {
	hashes: Record<string, string>;
	knownRefs: Record<string, boolean>;
	sourcePaths: Record<string, string>;
	files?: Record<string, StoredFileIndex>;
}

export function loadSyncState(
	raw: LegacyStoredSyncData | null,
): LoadedSyncState {
	const stored = raw ?? {};
	const baselines = stored.hashes ?? stored.revisions ?? {};
	const hashes = Object.fromEntries(
		Object.entries(baselines).flatMap(([id, value]) =>
			typeof value !== 'string'
				? []
				: [
						[
							id,
							/^v1:\d+:[0-9a-f]{32}$/.test(value)
								? value
								: contentFingerprint(normalize(value)),
						],
					],
		),
	);
	const files =
		stored.version === 3 && stored.files
			? Object.fromEntries(
					Object.entries(stored.files).filter(
						([, entry]) =>
							validStoredFile(entry) && entry.ids.length > 0,
					),
				)
			: undefined;
	return {
		hashes,
		knownRefs: { ...(stored.knownRefs ?? {}) },
		sourcePaths: { ...(stored.sourcePaths ?? {}) },
		files,
	};
}

export function createStoredSyncData(
	hashes: Record<string, string>,
	knownRefs: Record<string, boolean>,
	sourcePaths: Record<string, string>,
	indexedFiles: ReadonlyMap<string, IndexedFileMetadata>,
): StoredSyncDataV3 {
	const files: Record<string, StoredFileIndex> = {};
	for (const [path, indexed] of indexedFiles) {
		if (!indexed.ids.size) continue;
		files[path] = {
			mtime: indexed.mtime,
			size: indexed.size,
			ids: [...indexed.ids].sort(),
			sourceIds: [...indexed.sourceIds].sort(),
		};
	}
	return {
		version: 3,
		hashes,
		knownRefs,
		sourcePaths,
		files,
	};
}

function validStoredFile(value: StoredFileIndex): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		Number.isFinite(value.mtime) &&
		Number.isFinite(value.size) &&
		Array.isArray(value.ids) &&
		value.ids.every((id) => typeof id === 'string') &&
		Array.isArray(value.sourceIds) &&
		value.sourceIds.every((id) => typeof id === 'string')
	);
}
