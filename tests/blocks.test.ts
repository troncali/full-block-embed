import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import {
	applyPatches,
	contentFingerprint,
	parseFile,
	planSync,
	referenceBody,
	referenceChangeKey,
	removeBlock,
	sourceChangeKey,
	unwrapBlock,
	validId,
} from '../src/blocks.ts';
import type * as NestingModule from '../src/nesting.ts';

const { nestedSyncOrder, rebaseContainingFingerprints } = await createJiti(
	import.meta.url,
).import<typeof NestingModule>('../src/nesting.ts');
const source = (body: string) =>
	`# Source\n\n<!--#example+-->\n${body}\n<!--#example/-->\n`;
const ref = (body: string) =>
	`# Ref\n\n<!--#example=-->\n${body}\n<!--#example/-->\n`;
const files = (a: string, b: string) => [
	{ path: 'Source.md', text: source(a) },
	{ path: 'Ref.md', text: ref(b) },
];
const updated = (
	a: string,
	b: string,
	base: string,
	known = { 'Ref.md\u0000example\u00000': true },
) => {
	const input = files(a, b),
		plan = planSync(input, { example: base }, known);
	return {
		plan,
		text: input.map((f) =>
			applyPatches(
				f.text,
				plan.patches.filter((p) => p.path === f.path),
			),
		),
	};
};

test('source edit updates reference, preserving surrounding text', () => {
	const { plan, text } = updated('New\n- item', 'Old', 'Old');
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 1);
	assert.equal(text[1], ref('New\n- item'));
	assert.equal(plan.next.example, contentFingerprint('New\n- item'));
});
test('reference edit updates source', () => {
	const { plan, text } = updated('Old', 'Changed', 'Old');
	assert.deepEqual(plan.errors, []);
	assert.equal(text[0], source('Changed'));
});
test('two independent edits pause all writes', () => {
	const { plan } = updated('First', 'Second', 'Old');
	assert.equal(plan.patches.length, 0);
	assert.match(plan.errors[0], /conflicting edits/);
});
test('the same edit made in source and reference is accepted', () => {
	const { plan } = updated('Same change', 'Same change', 'Old');
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 0);
	assert.equal(plan.next.example, contentFingerprint('Same change'));
});
test('new empty reference hydrates but an existing cleared reference propagates deletion', () => {
	const fresh = planSync(files('Original', ''), { example: 'Original' }, {});
	assert.equal(fresh.patches.length, 1);
	assert.equal(applyPatches(ref(''), fresh.patches), ref('Original'));
	const cleared = updated('Original', '', 'Original');
	assert.deepEqual(cleared.plan.errors, []);
	assert.equal(cleared.plan.next.example, contentFingerprint(''));
	assert.equal(cleared.text[0], source(''));
});
test('outside edits pause without writing, including an emptied known copy', () => {
	const known = { 'Ref.md\u0000example\u00000': true };
	for (const input of [
		files('Changed outside', 'Original'),
		files('Original', ''),
	]) {
		const plan = planSync(
			input,
			{ example: contentFingerprint('Original') },
			known,
			undefined,
			new Set(),
		);
		assert.equal(plan.patches.length, 0);
		assert.match(plan.errors[0], /outside edit/);
	}
});
test('identical outside edits in every copy advance the baseline', () => {
	for (const value of ['Same outside edit', '']) {
		const plan = planSync(
			files(value, value),
			{ example: contentFingerprint('Original') },
			{ 'Ref.md\u0000example\u00000': true },
			undefined,
			new Set(),
		);
		assert.deepEqual(plan.errors, []);
		assert.equal(plan.patches.length, 0);
		assert.equal(plan.next.example, contentFingerprint(value));
	}
});
test('an edit made in Obsidian may propagate, including clearing a block', () => {
	const known = { 'Ref.md\u0000example\u00000': true };
	const cleared = files('Original', '');
	const plan = planSync(
		cleared,
		{ example: contentFingerprint('Original') },
		known,
		undefined,
		new Set([referenceChangeKey('Ref.md', 'example', 0)]),
	);
	assert.deepEqual(plan.errors, []);
	assert.equal(
		applyPatches(
			cleared[0].text,
			plan.patches.filter((patch) => patch.path === 'Source.md'),
		),
		source(''),
	);

	const editedSource = files('Changed in Obsidian', 'Original');
	assert.deepEqual(
		planSync(
			editedSource,
			{ example: contentFingerprint('Original') },
			known,
			undefined,
			new Set([sourceChangeKey('Source.md', 'example')]),
		).errors,
		[],
	);
});
test('an outside copy is accepted only after the same value is approved in Obsidian', () => {
	const input = [
		...files('Reviewed value', 'Reviewed value'),
		{ path: 'Other.md', text: ref('Original') },
	];
	const plan = planSync(
		input,
		{ example: contentFingerprint('Original') },
		{
			'Ref.md\u0000example\u00000': true,
			'Other.md\u0000example\u00000': true,
		},
		undefined,
		new Set([sourceChangeKey('Source.md', 'example')]),
	);
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 1);
	assert.equal(plan.patches[0]?.path, 'Other.md');
	assert.equal(plan.next.example, contentFingerprint('Reviewed value'));
});
test('a mismatched reference added outside Obsidian is not silently hydrated', () => {
	const plan = planSync(
		files('Current', 'Stale outside copy'),
		{ example: contentFingerprint('Current') },
		{},
		undefined,
		new Set(),
	);
	assert.equal(plan.patches.length, 0);
	assert.match(plan.errors[0], /outside edit/);
});
test('new populated reference with stale text cannot redefine an established source', () => {
	const input = files('Current', 'Stale');
	const plan = planSync(input, { example: 'Current' }, {});
	assert.deepEqual(plan.errors, []);
	assert.equal(
		applyPatches(
			input[0].text,
			plan.patches.filter((p) => p.path === 'Source.md'),
		),
		source('Current'),
	);
	assert.equal(
		applyPatches(
			input[1].text,
			plan.patches.filter((p) => p.path === 'Ref.md'),
		),
		ref('Current'),
	);
});
test('first scan refuses differing copies and duplicate sources', () => {
	assert.match(planSync(files('A', 'B'), {}).errors[0], /conflicting edits/);
	assert.match(
		planSync(
			[
				{ path: 'a.md', text: source('A') },
				{ path: 'b.md', text: source('B') },
			],
			{},
		).errors[0],
		/exactly one source/,
	);
});
test('a reference without a source pauses sync without writing', () => {
	const plan = planSync([{ path: 'Ref.md', text: ref('Orphan') }], {});
	assert.equal(plan.patches.length, 0);
	assert.match(plan.errors[0], /expected exactly one source, found 0/);
});
test('fenced examples are ignored and nested blocks are parsed', () => {
	const fenced = '```md\n<!--#fake+-->\nx\n<!--#fake/-->\n```\n';
	assert.equal(parseFile('x.md', fenced).blocks.length, 0);
	const nested =
		'<!--#example+-->\nBefore\n<!--#other=-->\nInner\n<!--#other/-->\nAfter\n<!--#example/-->\n';
	const parsed = parseFile('x.md', nested);
	assert.deepEqual(parsed.errors, []);
	assert.deepEqual(
		parsed.blocks.map((block) => [block.id, block.kind, block.depth]),
		[
			['example', '+', 0],
			['other', '=', 1],
		],
	);
	const nestedSource =
		'<!--#example+-->\n<!--#other+-->\nInner\n<!--#other/-->\n<!--#example/-->\n';
	const sourceParsed = parseFile('x.md', nestedSource);
	assert.deepEqual(sourceParsed.errors, []);
	assert.deepEqual(
		sourceParsed.blocks.map((block) => [block.id, block.kind, block.depth]),
		[
			['example', '+', 0],
			['other', '+', 1],
		],
	);
	const bad =
		'<!--#example=-->\n<!--#other+-->\nInner\n<!--#other/-->\n<!--#example/-->\n';
	assert.match(
		parseFile('x.md', bad).errors[0],
		/cannot be nested inside a reference/,
	);
	assert.equal(
		planSync([{ path: 'x.md', text: bad }, ...files('A', 'A')], {}).patches
			.length,
		0,
	);
});

test('a parent source projects nested sources to references in every copy', () => {
	const sourceBody = 'Before\n<!--#child+-->\nChild\n<!--#child/-->\nAfter';
	const referenceForm = referenceBody(sourceBody, 'Parent.md');
	assert.equal(
		referenceForm,
		'Before\n<!--#child=-->\nChild\n<!--#child/-->\nAfter',
	);
	const input = [
		{
			path: 'Parent.md',
			text: `<!--#parent+-->\n${sourceBody}\n<!--#parent/-->\n`,
		},
		{
			path: 'Copy.md',
			text: `<!--#parent=-->\n${referenceForm}\n<!--#parent/-->\n`,
		},
	];
	assert.deepEqual(nestedSyncOrder(input, new Set(['parent', 'child'])), {
		ids: ['child', 'parent'],
		errors: [],
	});
	const initial = planSync(input, {}, {}, new Set(['parent']));
	assert.deepEqual(initial.errors, []);
	assert.deepEqual(initial.patches, []);
	assert.equal(initial.next.parent, contentFingerprint(referenceForm));

	const changed = input.map((file, index) =>
		index === 0
			? { ...file, text: file.text.replace('Before', 'Edited') }
			: file,
	);
	const plan = planSync(
		changed,
		initial.next,
		{ 'Copy.md\u0000parent\u00000': true },
		new Set(['parent']),
		new Set([sourceChangeKey('Parent.md', 'parent')]),
	);
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 1);
	assert.equal(plan.patches[0]?.path, 'Copy.md');
	assert.match(plan.patches[0]?.body ?? '', /<!--#child=-->/);
	assert.doesNotMatch(plan.patches[0]?.body ?? '', /<!--#child\+-->/);
});

test('a parent reference edit restores nested source markers in its source', () => {
	const sourceBody = 'Before\n<!--#child+-->\nChild\n<!--#child/-->\nAfter';
	const referenceForm = referenceBody(sourceBody);
	const input = [
		{
			path: 'Parent.md',
			text: `<!--#parent+-->\n${sourceBody}\n<!--#parent/-->\n`,
		},
		{
			path: 'Copy.md',
			text: `<!--#parent=-->\n${referenceForm.replace('Before', 'Edited')}\n<!--#parent/-->\n`,
		},
	];
	const plan = planSync(
		input,
		{ parent: contentFingerprint(referenceForm) },
		{ 'Copy.md\u0000parent\u00000': true },
		new Set(['parent']),
		new Set([referenceChangeKey('Copy.md', 'parent', 0)]),
	);
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 1);
	assert.equal(plan.patches[0]?.path, 'Parent.md');
	assert.match(plan.patches[0]?.body ?? '', /<!--#child\+-->/);
	assert.doesNotMatch(plan.patches[0]?.body ?? '', /<!--#child=-->/);
	const updated = applyPatches(input[0]!.text, plan.patches);
	const parsed = parseFile('Parent.md', updated);
	assert.deepEqual(parsed.errors, []);
	assert.equal(
		parsed.blocks.filter(
			(block) => block.id === 'child' && block.kind === '+',
		).length,
		1,
	);
});

test('nested references synchronize before their containing blocks', () => {
	const nestedBody = (inner: string) =>
		`Before\n<!--#inner=-->\n${inner}\n<!--#inner/-->\nAfter`;
	const input = [
		{
			path: 'Inner.md',
			text: '<!--#inner+-->\nNew\n<!--#inner/-->\n',
		},
		{
			path: 'Outer-source.md',
			text: `<!--#outer+-->\n${nestedBody('Old')}\n<!--#outer/-->\n`,
		},
		{
			path: 'Outer-ref.md',
			text: `<!--#outer=-->\n${nestedBody('Old')}\n<!--#outer/-->\n`,
		},
	];
	assert.deepEqual(nestedSyncOrder(input, new Set(['outer', 'inner'])), {
		ids: ['inner', 'outer'],
		errors: [],
	});
	const inner = planSync(
		input,
		{ inner: contentFingerprint('Old') },
		{
			'Outer-source.md\u0000inner\u00000': true,
			'Outer-ref.md\u0000inner\u00000': true,
		},
		new Set(['inner']),
	);
	assert.deepEqual(inner.errors, []);
	assert.equal(inner.patches.length, 2);
	const synchronized = input.map((file) => ({
		...file,
		text: applyPatches(
			file.text,
			inner.patches.filter((patch) => patch.path === file.path),
		),
	}));
	for (const file of synchronized.slice(1))
		assert.match(file.text, /<!--#inner=-->\nNew\n<!--#inner\/-->/);
});

test('a nested update and a simultaneous parent edit do not conflict', () => {
	const nestedBody = (prefix: string, kind: '+' | '=', inner: string) =>
		`${prefix}\n<!--#inner${kind}-->\n${inner}\n<!--#inner/-->\nAfter`;
	const files = [
		{
			path: 'Outer-source.md',
			text: `<!--#outer+-->\n${nestedBody('Edited before', '+', 'New')}\n<!--#outer/-->\n`,
		},
		{
			path: 'Outer-ref.md',
			text: `<!--#outer=-->\n${nestedBody('Before', '=', 'Old')}\n<!--#outer/-->\n`,
		},
	];
	const hashes = {
		inner: contentFingerprint('Old'),
		outer: contentFingerprint(nestedBody('Before', '=', 'Old')),
	};
	const known = {
		'Outer-ref.md\u0000inner\u00000': true,
		'Outer-ref.md\u0000outer\u00000': true,
	};
	const inner = planSync(
		files,
		hashes,
		known,
		new Set(['inner']),
		new Set([sourceChangeKey('Outer-source.md', 'inner')]),
	);
	assert.deepEqual(inner.errors, []);
	const byPath = new Map<string, typeof inner.patches>();
	for (const patch of inner.patches)
		byPath.set(patch.path, [...(byPath.get(patch.path) ?? []), patch]);
	const afterInner = files.map((file) => ({
		...file,
		text: applyPatches(file.text, byPath.get(file.path) ?? []),
	}));
	rebaseContainingFingerprints(files, afterInner, byPath, inner.next);
	assert.equal(
		inner.next.outer,
		contentFingerprint(nestedBody('Before', '=', 'New')),
	);
	const outer = planSync(
		afterInner,
		inner.next,
		inner.nextRefs,
		new Set(['outer']),
		new Set([sourceChangeKey('Outer-source.md', 'outer')]),
	);
	assert.deepEqual(outer.errors, []);
	assert.equal(outer.patches.length, 1);
	assert.equal(outer.patches[0]?.path, 'Outer-ref.md');
	assert.match(outer.patches[0]?.body ?? '', /Edited before/);
	assert.match(outer.patches[0]?.body ?? '', /New/);
});

test('circular nested blocks are rejected', () => {
	assert.match(
		parseFile(
			'Self.md',
			'<!--#a+-->\n<!--#a=-->\nA\n<!--#a/-->\n<!--#a/-->\n',
		).errors[0],
		/cannot contain itself/,
	);
	const input = [
		{
			path: 'A.md',
			text: '<!--#a+-->\n<!--#b=-->\nB\n<!--#b/-->\n<!--#a/-->\n',
		},
		{
			path: 'B.md',
			text: '<!--#b+-->\n<!--#a=-->\nA\n<!--#a/-->\n<!--#b/-->\n',
		},
	];
	assert.match(
		nestedSyncOrder(input, new Set(['a', 'b'])).errors[0],
		/circular nested shared blocks/,
	);
});
test('partially typed marker is ignored until its HTML comment closes', () => {
	assert.deepEqual(parseFile('x.md', '<!--#exam').errors, []);
	assert.match(parseFile('x.md', '<!--#example-->').errors[0], /malformed/);
});
test('IDs enforce portable marker-safe names and length', () => {
	assert.equal(validId('a'), true);
	assert.equal(validId(`a${'1'.repeat(79)}`), true);
	for (const id of [
		'',
		'1starts-with-number',
		'has space',
		'has/slash',
		`a${'1'.repeat(80)}`,
	]) {
		assert.equal(validId(id), false, id);
	}
});
test('orphan closing marker identifies the invisible marker and its block ID', () => {
	const result = parseFile('Note.md', 'ordinary text\n<!--#example/-->\n');
	assert.match(
		result.errors[0],
		/Note\.md:2: orphan closing marker for example/,
	);
	assert.match(result.errors[0], /opening marker is missing/);
});
test('unclosed marker identifies the block and missing closing marker', () => {
	const result = parseFile('Note.md', '<!--#example+-->\ntext\n');
	assert.match(result.errors[0], /Note\.md:1: unclosed source block example/);
	assert.match(result.errors[0], /closing marker is missing/);
});
test('a reference can be removed and a source can be converted without losing its body', () => {
	const reference = `Before\n${ref('Shared **text**')}After\n`;
	const refBlock = parseFile('Ref.md', reference).blocks[0];
	assert.equal(removeBlock(reference, refBlock), 'Before\n# Ref\n\nAfter\n');

	const original = source('Shared **text**\n\n- item');
	const sourceBlock = parseFile('Source.md', original).blocks[0];
	assert.equal(
		unwrapBlock(original, sourceBlock),
		'# Source\n\nShared **text**\n\n- item\n',
	);
});
test('block transforms reject stale offsets instead of changing unrelated text', () => {
	const original = ref('Shared');
	const block = parseFile('Ref.md', original).blocks[0];
	const changed = `prefix\n${original}`;
	assert.throws(
		() => removeBlock(changed, block),
		/changed before it could be removed/,
	);
	assert.throws(
		() => unwrapBlock(changed, block),
		/changed before it could be converted/,
	);
});
test('CRLF files retain CRLF and block offsets', () => {
	const input = files('New', 'Old').map((f) => ({
		...f,
		text: f.text.replace(/\n/g, '\r\n'),
	}));
	const plan = planSync(
		input,
		{ example: 'Old' },
		{ 'Ref.md\u0000example\u00000': true },
	);
	const changed = applyPatches(input[1].text, plan.patches);
	assert.ok(changed.includes('New\r\n<!--#example/-->'));
	assert.equal(changed.replace(/\r\n/g, '\n'), ref('New'));
});
test('multiple references in one file patch from the end', () => {
	const input = [
		{ path: 'a.md', text: source('New') },
		{ path: 'b.md', text: ref('Old') + '\n' + ref('Old') },
	];
	const plan = planSync(
		input,
		{ example: 'Old' },
		{ 'b.md\u0000example\u00000': true, 'b.md\u0000example\u00001': true },
	);
	assert.equal(plan.patches.length, 2);
	assert.equal(
		applyPatches(input[1].text, plan.patches),
		ref('New') + '\n' + ref('New'),
	);
});
test('patches reject a concurrent file edit', () => {
	const input = files('New', 'Old');
	const plan = planSync(
		input,
		{ example: 'Old' },
		{ 'Ref.md\u0000example\u00000': true },
	);
	assert.throws(
		() => applyPatches(`prefix\n${input[1].text}`, plan.patches),
		/Concurrent edit detected/,
	);
});

test('compact markers parse both kinds with exact body offsets', () => {
	for (const kind of ['+', '=']) {
		for (const newline of ['\n', '\r\n']) {
			const text = `Before${newline}<!--#a-1${kind}--> \t${newline}Body${newline}<!--#a-1/-->\t`;
			const result = parseFile('Note.md', text);
			assert.deepEqual(result.errors, []);
			assert.equal(result.blocks.length, 1);
			const block = result.blocks[0];
			assert.equal(block.id, 'a-1');
			assert.equal(block.kind, kind);
			assert.equal(block.body, 'Body');
			assert.equal(
				text.slice(block.bodyStart, block.bodyEnd),
				`Body${newline}`,
			);
			assert.equal(removeBlock(text, block), `Before${newline}`);
			assert.equal(
				unwrapBlock(text, block),
				`Before${newline}Body${newline}`,
			);
		}
	}
});

test('invalid compact markers pause all synchronization writes', () => {
	for (const marker of [
		'<!--#example-->',
		'<!--#example source-->',
		'<!--#example ref-->',
		'<!--#example++-->',
		'<!--#example==-->',
		'<!--#/example-->',
		'<!--#example /-->',
		'<!--#1example+-->',
	]) {
		const plan = planSync(
			[...files('New', 'Old'), { path: 'Bad.md', text: marker }],
			{ example: 'Old' },
		);
		assert.ok(plan.errors.length, marker);
		assert.deepEqual(plan.patches, [], marker);
	}
});

test('closing marker must match the opening block ID', () => {
	const result = parseFile(
		'Note.md',
		'<!--#example=-->\nBody\n<!--#other/-->',
	);
	assert.equal(result.blocks.length, 0);
	assert.match(result.errors[0], /orphan closing marker for other/);
	assert.match(result.errors[1], /unclosed reference block example/);
});

test('block transforms reject changed marker IDs and kinds at unchanged offsets', () => {
	const original = ref('Shared');
	const block = parseFile('Ref.md', original).blocks[0];
	for (const changed of [
		original.replace('example=', 'example+'),
		original.replace('example=', 'another='),
		original.replace('example/', 'another/'),
	]) {
		assert.throws(() => removeBlock(changed, block), /changed before/);
		assert.throws(() => unwrapBlock(changed, block), /changed before/);
	}
});

test('legacy markers remain ordinary text without automatic migration', () => {
	const text =
		'<!-- shared-block:example source -->\nBody\n<!-- /shared-block:example -->';
	assert.deepEqual(parseFile('Note.md', text), { blocks: [], errors: [] });
});

test('synchronization persists fingerprints instead of full block content', () => {
	const privateText =
		'A long block body that should not be copied to data.json';
	const plan = planSync(files(privateText, privateText), {});
	assert.equal(plan.next.example, contentFingerprint(privateText));
	assert.ok(!JSON.stringify(plan.next).includes(privateText));
});

test('targeted synchronization retains state for inactive blocks', () => {
	const otherSource = source('Other').replaceAll('example', 'other');
	const otherRef = ref('Other').replaceAll('example', 'other');
	const known = {
		'Ref.md\u0000example\u00000': true,
		'Other-ref.md\u0000other\u00000': true,
	};
	const plan = planSync(
		[
			...files('New', 'Old'),
			{ path: 'Other-source.md', text: otherSource },
			{ path: 'Other-ref.md', text: otherRef },
		],
		{ example: 'Old', other: contentFingerprint('Other') },
		known,
		new Set(['example']),
	);
	assert.deepEqual(plan.errors, []);
	assert.equal(plan.patches.length, 1);
	assert.equal(plan.next.other, contentFingerprint('Other'));
	assert.equal(plan.nextRefs['Other-ref.md\u0000other\u00000'], true);
});
