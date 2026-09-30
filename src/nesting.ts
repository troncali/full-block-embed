import {
	canonicalBlockBody,
	contentFingerprint,
	type FileText,
	normalize,
	parseFile,
	type Patch,
} from './blocks';

/**
 * Return IDs in the order they must synchronize so nested children settle
 * before the bodies that contain them. Cycles would recursively grow copied
 * Markdown, so they are reported instead of being synchronized.
 */
export function nestedSyncOrder(
	files: FileText[],
	targetIds: ReadonlySet<string>,
): { ids: string[]; errors: string[] } {
	const dependencies = new Map<string, Set<string>>();
	for (const id of targetIds) dependencies.set(id, new Set());
	for (const file of files) {
		const blocks = parseFile(file.path, file.text).blocks;
		for (const parent of blocks) {
			if (parent.kind !== '+' || !targetIds.has(parent.id)) continue;
			for (const child of blocks) {
				if (
					child.start > parent.start &&
					child.end < parent.end &&
					targetIds.has(child.id)
				)
					dependencies.get(parent.id)!.add(child.id);
			}
		}
	}

	const ids: string[] = [];
	const complete = new Set<string>();
	const active: string[] = [];
	const errors: string[] = [];
	const visit = (id: string): void => {
		if (complete.has(id) || errors.length) return;
		const cycleAt = active.indexOf(id);
		if (cycleAt >= 0) {
			errors.push(
				`${id}: circular nested shared blocks (${[...active.slice(cycleAt), id].join(' -> ')})`,
			);
			return;
		}
		active.push(id);
		for (const child of [...(dependencies.get(id) ?? [])].sort())
			visit(child);
		active.pop();
		complete.add(id);
		ids.push(id);
	};
	for (const id of [...targetIds].sort()) visit(id);
	return { ids, errors };
}

/**
 * Advance baselines for parents changed only because one of their nested
 * references synchronized. This keeps the child update from looking like a
 * second, conflicting edit when a parent was edited at the same time.
 */
export function rebaseContainingFingerprints(
	before: FileText[],
	after: FileText[],
	patchesByFile: ReadonlyMap<string, Patch[]>,
	hashes: Record<string, string>,
): void {
	const afterByPath = new Map(after.map((file) => [file.path, file.text]));
	for (const file of before) {
		const patches = patchesByFile.get(file.path);
		if (!patches?.length) continue;
		const updated = afterByPath.get(file.path);
		if (updated === undefined) continue;
		const oldBlocks = parseFile(file.path, file.text).blocks;
		const newBlocks = parseFile(file.path, updated).blocks;
		for (const parent of oldBlocks) {
			if (
				!patches.some(
					(patch) =>
						patch.from >= parent.bodyStart &&
						patch.to <= parent.bodyEnd,
				)
			)
				continue;
			if (
				hashes[parent.id] !==
				contentFingerprint(
					normalize(canonicalBlockBody(file.text, parent, oldBlocks)),
				)
			)
				continue;
			const current = newBlocks.find(
				(candidate) =>
					candidate.id === parent.id &&
					candidate.kind === parent.kind &&
					candidate.start === parent.start,
			);
			if (current)
				hashes[parent.id] = contentFingerprint(
					normalize(canonicalBlockBody(updated, current, newBlocks)),
				);
		}
	}
}
