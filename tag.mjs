import { execFileSync } from 'node:child_process';
import { version } from '../package.json' with { type: 'json' };

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { version } = require(path.join(__dirname, '..', 'package.json'));

execFileSync('git', ['tag', '-a', version, '-m', `Release ${version}`], {
	stdio: 'inherit',
});
