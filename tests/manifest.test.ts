import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const json = async (path: string): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

test('Obsidian and npm release metadata stay aligned', async () => {
	const [manifest, packageJson, versions] = await Promise.all([
		json('manifest.json'),
		json('package.json'),
		json('versions.json'),
	]);

	assert.equal(packageJson.name, manifest.id);
	assert.equal(packageJson.version, manifest.version);
	assert.equal(versions[String(manifest.version)], manifest.minAppVersion);
	assert.match(String(manifest.id), /^[a-z0-9-]+$/);
	assert.equal(typeof manifest.description, 'string');
	assert.notEqual(manifest.description, '');
	assert.match(String(manifest.description), /\.$/);
	assert.equal(manifest.fundingUrl, undefined);
});

test('license preserves current and upstream attribution', async () => {
	const [license, notices] = await Promise.all([
		readFile('LICENSE', 'utf8'),
		readFile('THIRD_PARTY_NOTICES.md', 'utf8'),
	]);

	for (const notice of [
		'Copyright (c) 2026 Matt Troncali',
		'See ./THIRD_PARTY_NOTICES.md for license notices and the upstream projects',
		'copyright (c) 2025 Verity, 2026 Siulved54',
	])
		assert.match(license, new RegExp(notice.replace(/[()]/g, '\\$&')));
	assert.match(notices, /github\.com\/uthvah\/sync-embeds/);
	assert.match(
		notices,
		/github\.com\/perezamadorluisenrique-gif\/shared-blocks/,
	);
});
