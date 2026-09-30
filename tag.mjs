import { execFileSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

execFileSync(
	'git',
	['tag', '-a', pkg.version, '-m', `Release ${pkg.version}`],
	{
		stdio: 'inherit',
	},
);
