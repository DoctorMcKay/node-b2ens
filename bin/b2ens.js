#!/usr/bin/env node

let command = process.argv[2];
switch (command) {
	case 'sync':
		require('../commands/sync.js');
		break;

	case 'decrypt-file':
		require('../commands/decrypt-file.js');
		break;

	case 'encrypt-file':
		require('../commands/encrypt-file.js');
		break;

	case 'generate-keypair':
		require('../commands/generate-keypair.js');
		break;
		
	case 'generate-syncfile':
		require('../commands/generate-syncfile.js');
		break;

	default:
		console.error('B2 Encrypt-n-Sync ' + require('../package.json').version + '\nUsage: b2ens <command>\n  Available commands:\n    - sync\n    - decrypt-file\n    - encrypt-file\n    - generate-keypair\n    - generate-syncfile\n');
		process.exit(1);
}
