import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { contentFingerprint } from '../src/blocks.ts';
import type * as SyncStateModule from '../src/sync-state.ts';

const { createStoredSyncData, loadSyncState } = await createJiti(
	import.meta.url,
).import<typeof SyncStateModule>('../src/sync-state.ts');

test('disk cache includes structural metadata and synchronization hashes', () => {
	const privateBody = 'Body content belongs only in the Markdown note';
	const hash = contentFingerprint(privateBody);
	const stored = createStoredSyncData(
		{ example: hash },
		{ 'Reference.md\u0000example\u00000': true },
		{ example: 'Source.md' },
		new Map([
			[
				'Source.md',
				{
					mtime: 123,
					size: 456,
					ids: new Set(['example']),
					sourceIds: new Set(['example']),
				},
			],
			[
				'Ordinary.md',
				{
					mtime: 789,
					size: 12,
					ids: new Set<string>(),
					sourceIds: new Set<string>(),
				},
			],
		]),
	);

	assert.equal(stored.version, 3);
	assert.equal(stored.hashes.example, hash);
	assert.deepEqual(stored.files['Source.md'], {
		mtime: 123,
		size: 456,
		ids: ['example'],
		sourceIds: ['example'],
	});
	assert.equal(stored.files['Ordinary.md'], undefined);
	assert.ok(!JSON.stringify(stored).includes(privateBody));
	assert.deepEqual(loadSyncState(stored), {
		hashes: { example: hash },
		knownRefs: { 'Reference.md\u0000example\u00000': true },
		sourcePaths: { example: 'Source.md' },
		files: stored.files,
	});
});

test('legacy full-content baselines migrate to hashes without a startup index', () => {
	const loaded = loadSyncState({
		revisions: { example: 'Legacy private body' },
	});
	assert.equal(
		loaded.hashes.example,
		contentFingerprint('Legacy private body'),
	);
	assert.equal(loaded.files, undefined);
});
