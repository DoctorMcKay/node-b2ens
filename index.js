let command = process.argv[2];
switch (command) {
	case 'sync':
		require('./commands/sync.js');
		break;

	default:
		console.error('Usage: b2cns <command>\n  Available commands:\n    - sync');
		process.exit(1);
}
