#!/usr/bin/env node

const AVAILABLE_COMMANDS = [
	'sync',
	'decrypt-file',
	'decrypt-folder',
	'download',
	'encrypt-file',
	'generate-keypair',
	'generate-syncfile'
];

let command = process.argv[2];
if (AVAILABLE_COMMANDS.includes(command)) {
	require(`../commands/${command}.js`);
} else {
	let {version} = require('../package.json');
	console.error(`B2 Encrypt-n-Sync ${version}`);
	console.error('Usage: b2ens <command>');
	console.error('Available commands:');
	console.error(AVAILABLE_COMMANDS.map(c => `  - ${c}`).join('\n'));
	process.exit(1);
}
