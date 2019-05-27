let command = process.argv[2];
switch (command) {
	case 'sync':
		require('./commands/sync.js');
		break;

	case 'decrypt-file':
		require('./commands/decrypt-file.js');
		break;

	case 'encrypt-file':
		require('./commands/encrypt-file.js');
		break;

	default:
		console.error('Usage: b2cns <command>\n  Available commands:\n    - sync\n    - decrypt-file');
		process.exit(1);
}
