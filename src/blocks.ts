/** Pure Markdown block parser and synchronization planner. */
export type Kind = '+' | '=';
export interface Block {
	id: string;
	kind: Kind;
	path: string;
	body: string;
	depth: number;
	start: number;
	end: number;
	bodyStart: number;
	bodyEnd: number;
	startLine: number;
	endLine: number;
}
export interface ParseResult {
	blocks: Block[];
	errors: string[];
}
export interface FileText {
	path: string;
	text: string;
}
export interface Patch {
	path: string;
	from: number;
	to: number;
	oldBody: string;
	body: string;
}
export interface Plan {
	patches: Patch[];
	next: Record<string, string>;
	nextRefs: Record<string, boolean>;
	errors: string[];
}
export const sourceChangeKey = (path: string, id: string): string =>
	`${path}\u0000${id}\u0000source`;
export const referenceChangeKey = (
	path: string,
	id: string,
	ordinal: number,
): string => `${path}\u0000${id}\u0000${ordinal}`;
export const validId = (id: string): boolean =>
	/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(id);
const OPEN = /^<!--#([^\s]+)(\+|=)-->[ \t]*$/;
const CLOSE = /^<!--#([^\s]+)\/-->[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
interface Line {
	text: string;
	start: number;
	end: number;
	next: number;
}

function linesOf(text: string): Line[] {
	const lines: Line[] = [];
	const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
	for (let m = re.exec(text); m && m[0] !== ''; m = re.exec(text)) {
		lines.push({
			text: m[1]!,
			start: m.index,
			end: m.index + m[1]!.length,
			next: m.index + m[0].length,
		});
		if (!m[2]) break;
	}
	return lines;
}

export function parseFile(path: string, text: string): ParseResult {
	const blocks: Block[] = [],
		errors: string[] = [];
	let fence: { char: string; length: number } | null = null;
	const open: Array<{
		id: string;
		kind: Kind;
		line: number;
		start: number;
		bodyStart: number;
	}> = [];
	const lines = linesOf(text);
	for (let i = 0; i < lines.length; i++) {
		const currentLine = lines[i]!;
		const line = currentLine.text;
		const fm = FENCE.exec(line);
		if (fence) {
			if (
				fm &&
				fm[1]![0] === fence.char &&
				fm[1]!.length >= fence.length &&
				fm[2]!.trim() === ''
			)
				fence = null;
			continue;
		}
		if (fm) {
			fence = { char: fm[1]![0]!, length: fm[1]!.length };
			continue;
		}
		const begin = OPEN.exec(line);
		const end = CLOSE.exec(line);
		if (begin) {
			if (!validId(begin[1]!))
				errors.push(`${path}:${i + 1}: invalid block ID ${begin[1]!}`);
			if (open.some((parent) => parent.id === begin[1]!))
				errors.push(
					`${path}:${i + 1}: shared block ${begin[1]!} cannot contain itself`,
				);
			if (begin[2] === '+' && open.some((parent) => parent.kind === '='))
				errors.push(
					`${path}:${i + 1}: source block ${begin[1]!} cannot be nested inside a reference`,
				);
			open.push({
				id: begin[1]!,
				kind: begin[2] as Kind,
				line: i,
				start: currentLine.start,
				bodyStart: currentLine.next,
			});
		} else if (end) {
			const current = open.at(-1);
			if (!current || current.id !== end[1]!) {
				errors.push(
					`${path}:${i + 1}: orphan closing marker for ${end[1]} (opening marker is missing)`,
				);
			} else {
				const bodyEnd = currentLine.start;
				// Preserve all raw bytes within the markers. A single separator newline
				// is excluded so an empty region has an empty body.
				const raw = text.slice(current.bodyStart, bodyEnd);
				const body = raw.replace(/(?:\r\n|\n|\r)$/, '');
				blocks.push({
					id: current.id,
					kind: current.kind,
					path,
					body,
					depth: open.length - 1,
					start: current.start,
					end: currentLine.next,
					bodyStart: current.bodyStart,
					bodyEnd,
					startLine: current.line,
					endLine: i,
				});
				open.pop();
			}
			// Ignore a marker while the user is still typing it. Once the HTML
			// comment is closed, a marker-shaped line must be valid.
		} else if (/^<!--#.*-->[ \t]*$/.test(line)) {
			errors.push(`${path}:${i + 1}: malformed shared block marker`);
		}
	}
	for (const current of open)
		errors.push(
			`${path}:${current.line + 1}: unclosed ${current.kind === '+' ? 'source' : 'reference'} block ${current.id} (closing marker is missing)`,
		);
	blocks.sort((a, b) => a.start - b.start || b.end - a.end);
	return { blocks, errors };
}

/**
 * The content synchronized for a block. Nested sources are projected to
 * references so a parent source and its copies compare as the same content.
 */
export function canonicalBlockBody(
	text: string,
	block: Block,
	blocks: Block[] = parseFile(block.path, text).blocks,
): string {
	const replacements = blocks
		.filter(
			(candidate) =>
				candidate.kind === '+' &&
				candidate.start > block.start &&
				candidate.end < block.end,
		)
		.map((candidate) => markerKindPosition(candidate) - block.bodyStart)
		.filter((position) => position >= 0 && position < block.body.length);
	return replaceCharacters(block.body, replacements, '=');
}

function markerKindPosition(block: Block): number {
	return block.start + `<!--#${block.id}`.length;
}

function replaceCharacters(
	text: string,
	positions: number[],
	replacement: string,
): string {
	let result = text;
	for (const position of [...positions].sort((a, b) => b - a))
		result =
			result.slice(0, position) +
			replacement +
			result.slice(position + 1);
	return result;
}

/** Convert every source opening marker in a copied body to a reference. */
export function referenceBody(body: string, path = ''): string {
	const positions = parseFile(path, body)
		.blocks.filter((block) => block.kind === '+')
		.map(markerKindPosition);
	return replaceCharacters(body, positions, '=');
}

interface NestedSourceSlot {
	id: string;
	ordinal: number;
}

function nestedSourceSlots(source: Block, blocks: Block[]): NestedSourceSlot[] {
	const ordinals = new Map<string, number>();
	const slots: NestedSourceSlot[] = [];
	for (const child of blocks.filter(
		(candidate) =>
			candidate.start > source.start && candidate.end < source.end,
	)) {
		const ordinal = ordinals.get(child.id) ?? 0;
		ordinals.set(child.id, ordinal + 1);
		if (child.kind === '+') slots.push({ id: child.id, ordinal });
	}
	return slots;
}

function restoreNestedSources(
	canonical: string,
	source: Block,
	sourceBlocks: Block[],
): { body?: string; missing?: NestedSourceSlot } {
	const slots = nestedSourceSlots(source, sourceBlocks);
	if (!slots.length) return { body: canonical };
	const parsed = parseFile(source.path, canonical);
	if (parsed.errors.length) return { missing: slots[0] };
	const wanted = new Map(
		slots.map((slot) => [`${slot.id}\u0000${slot.ordinal}`, slot]),
	);
	const ordinals = new Map<string, number>();
	const replacements: number[] = [];
	for (const block of parsed.blocks) {
		const ordinal = ordinals.get(block.id) ?? 0;
		ordinals.set(block.id, ordinal + 1);
		const key = `${block.id}\u0000${ordinal}`;
		if (!wanted.has(key)) continue;
		replacements.push(markerKindPosition(block));
		wanted.delete(key);
	}
	const missing = wanted.values().next().value;
	return missing
		? { missing }
		: { body: replaceCharacters(canonical, replacements, '+') };
}

/** Remove a complete reference block, including both marker lines. */
export function removeBlock(text: string, block: Block): string {
	assertCurrentBlock(text, block, 'removed');
	return text.slice(0, block.start) + text.slice(block.end);
}

/** Remove a block's marker lines while retaining its Markdown body verbatim. */
export function unwrapBlock(text: string, block: Block): string {
	assertCurrentBlock(text, block, 'converted');
	return (
		text.slice(0, block.start) +
		text.slice(block.bodyStart, block.bodyEnd) +
		text.slice(block.end)
	);
}

function assertCurrentBlock(text: string, block: Block, action: string): void {
	const current = parseFile(block.path, text).blocks.find(
		(candidate) =>
			candidate.id === block.id &&
			candidate.kind === block.kind &&
			candidate.start === block.start &&
			candidate.end === block.end &&
			candidate.bodyStart === block.bodyStart &&
			candidate.bodyEnd === block.bodyEnd,
	);
	if (!current) {
		throw new Error(`Shared block changed before it could be ${action}`);
	}
}

export function normalize(body: string): string {
	return body.replace(/\r\n?|\n/g, '\n');
}

/**
 * A compact, deterministic fingerprint for persisted synchronization state.
 *
 * This is deliberately synchronous because synchronization planning is pure.
 * Four independently seeded 32-bit FNV-style lanes plus the input length make
 * accidental collisions vanishingly unlikely without requiring Node APIs or
 * storing complete vault content in plugin data.
 */
export function contentFingerprint(body: string): string {
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
	const hashes = [...seeds];
	for (let i = 0; i < body.length; i++) {
		const code = body.charCodeAt(i);
		for (let lane = 0; lane < hashes.length; lane++) {
			hashes[lane] = Math.imul(
				(hashes[lane]! ^ code ^ (lane * 0x9e37)) >>> 0,
				0x01000193,
			);
		}
	}
	return `v1:${body.length}:${hashes
		.map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
		.join('')}`;
}

/** Accept the former full-content baseline while data migrates to hashes. */
function storedFingerprint(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return /^v1:\d+:[0-9a-f]{32}$/.test(value)
		? value
		: contentFingerprint(normalize(value));
}

export function planSync(
	files: FileText[],
	previous: Record<string, string>,
	knownRefs: Record<string, boolean> = {},
	targetIds?: ReadonlySet<string>,
	allowedChanges?: ReadonlySet<string>,
): Plan {
	const next = { ...previous },
		nextRefs: Record<string, boolean> = { ...knownRefs },
		errors: string[] = [],
		patches: Patch[] = [];
	const groups = new Map<string, Block[]>();
	const textByPath = new Map(files.map((file) => [file.path, file.text]));
	const blocksByPath = new Map<string, Block[]>();
	for (const file of files) {
		const parsed = parseFile(file.path, file.text);
		errors.push(...parsed.errors);
		blocksByPath.set(file.path, parsed.blocks);
		for (const block of parsed.blocks) {
			if (targetIds && !targetIds.has(block.id)) continue;
			const group = groups.get(block.id) || [];
			group.push(block);
			groups.set(block.id, group);
		}
	}
	// A malformed file could conceal another copy. Never write under that uncertainty.
	if (errors.length) return { patches, next, nextRefs: knownRefs, errors };
	const ids = targetIds ?? new Set(groups.keys());
	for (const id of ids) {
		const blocks = groups.get(id) ?? [];
		const sources = blocks.filter((b) => b.kind === '+');
		if (sources.length !== 1) {
			errors.push(
				`${id}: expected exactly one source, found ${sources.length}`,
			);
			continue;
		}
		const source = sources[0]!;
		const contentOf = (block: Block): string =>
			normalize(
				canonicalBlockBody(
					textByPath.get(block.path)!,
					block,
					blocksByPath.get(block.path),
				),
			);
		const allCopiesMatch =
			new Set(blocks.map((block) => contentOf(block))).size === 1;
		for (const key of Object.keys(nextRefs))
			if (key.split('\u0000')[1] === id) delete nextRefs[key];
		const ordinals = new Map<string, number>();
		const refKeys = new Map<Block, string>();
		for (const b of blocks)
			if (b.kind === '=') {
				const ordinal = ordinals.get(b.path) || 0;
				ordinals.set(b.path, ordinal + 1);
				const key = referenceChangeKey(b.path, id, ordinal);
				nextRefs[key] = true;
				refKeys.set(b, key);
			}
		const base = storedFingerprint(previous[id]);
		const candidates = new Map<string, string>();
		const approvedFingerprints = new Set<string>();
		const outsideChanges: Array<{
			block: Block;
			fingerprint: string;
		}> = [];
		for (const b of blocks) {
			const content = contentOf(b);
			const fingerprint = contentFingerprint(content);
			const changeKey =
				b.kind === '+' ? sourceChangeKey(b.path, id) : refKeys.get(b)!;
			// A new reference never gets to redefine an established source, even
			// if someone pasted stale populated content into it. In strict mode,
			// though, a mismatched reference discovered outside an editor is a
			// conflict rather than content the plugin may silently replace.
			if (
				b.kind === '=' &&
				((base !== undefined && !knownRefs[refKeys.get(b)!]) ||
					(base === undefined && b.body === ''))
			) {
				if (
					base !== undefined &&
					fingerprint !== base &&
					allowedChanges !== undefined
				)
					if (allowedChanges.has(changeKey))
						approvedFingerprints.add(fingerprint);
					else outsideChanges.push({ block: b, fingerprint });
				continue;
			}
			if (base === undefined || fingerprint !== base) {
				if (base !== undefined && allowedChanges !== undefined)
					if (allowedChanges.has(changeKey))
						approvedFingerprints.add(fingerprint);
					else outsideChanges.push({ block: b, fingerprint });
				const collision = candidates.get(fingerprint);
				if (collision !== undefined && collision !== content) {
					errors.push(`${id}: content fingerprint collision`);
					continue;
				}
				candidates.set(fingerprint, content);
			}
		}
		for (const outside of outsideChanges)
			if (
				!allCopiesMatch &&
				!approvedFingerprints.has(outside.fingerprint)
			)
				errors.push(
					`${outside.block.path}:${outside.block.startLine + 1}: outside edit for shared block ${id} differs from the last synchronized content`,
				);
		if (candidates.size > 1) {
			errors.push(
				`${id}: conflicting edits in ${blocks.map((b) => b.path).join(', ')}`,
			);
			continue;
		}
		const chosen =
			candidates.size === 1
				? [...candidates.values()][0]!
				: contentOf(source);
		next[id] = contentFingerprint(chosen);
		for (const b of blocks) {
			if (contentOf(b) === chosen) continue;
			const text = textByPath.get(b.path)!;
			const newline = text.includes('\r\n') ? '\r\n' : '\n';
			let target = chosen;
			if (b.kind === '+') {
				const restored = restoreNestedSources(
					chosen,
					b,
					blocksByPath.get(b.path)!,
				);
				if (restored.body === undefined) {
					errors.push(
						`${id}: edited copy no longer contains nested source ${restored.missing!.id}`,
					);
					continue;
				}
				target = restored.body;
			}
			const replacement =
				normalize(target).replace(/\n/g, newline) + newline;
			patches.push({
				path: b.path,
				from: b.bodyStart,
				to: b.bodyEnd,
				oldBody: text.slice(b.bodyStart, b.bodyEnd),
				body: replacement,
			});
		}
	}
	// Never make partial cross-block edits when any block conflicts.
	if (errors.length)
		return { patches: [], next: previous, nextRefs: knownRefs, errors };
	return { patches, next, nextRefs, errors };
}

export function applyPatches(text: string, patches: Patch[]): string {
	let result = text;
	for (const p of [...patches].sort((a, b) => b.from - a.from)) {
		if (result.slice(p.from, p.to) !== p.oldBody)
			throw new Error('Concurrent edit detected');
		result = result.slice(0, p.from) + p.body + result.slice(p.to);
	}
	return result;
}
