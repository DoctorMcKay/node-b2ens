const FS = require('fs');

const Encryption = require('../components/encryption.js');

module.exports = function(mode) {
	let keyPath = process.argv[3];
	let filePath = process.argv[4];
	let outputFilePath = process.argv[5] || filePath + `.${mode}ed`;
	if (!filePath || !keyPath) {
		let args = [
			mode == 'encrypt' ? '<path to PEM-encoded public or private key>' : '<path to PEM-encoded private key>',
			mode == 'encrypt' ? '<path to file>' : '<path to encrypted file>',
			'[path to output file]'
		];

		console.error('Usage: b2ens decrypt-file ' + args.join(' '));
		process.exit(2);
	}

	let stat = FS.statSync(filePath);
	let readStream = FS.createReadStream(filePath);
	let cryptoStream = Encryption[mode == 'encrypt' ? 'createEncryptStream' : 'createDecryptStream'](FS.readFileSync(keyPath).toString('ascii'));
	let outStream = FS.createWriteStream(outputFilePath);

	let titleMode = mode.substring(0, 1).toUpperCase() + mode.substring(1);
	console.log(`${titleMode}ing to output file ${outputFilePath}`);
	readStream.pipe(cryptoStream).pipe(outStream);

	cryptoStream.on('error', (err) => {
		outStream.end();
		FS.unlinkSync(outputFilePath);
		process.stderr.write(`\n${titleMode}ion error: ${err.message}\n`);
		process.exit(3);
	});

	let interval = null;
	if (process.stdout.isTTY) {
		interval = setInterval(() => {
			let pct = Math.round((cryptoStream.processedBytes / stat.size) * 100);
			process.stdout.clearLine(0);
			process.stdout.write(`\r${titleMode}ing... ${pct}% `);
		}, 100);
	}

	outStream.on('finish', () => {
		if (interval) {
			clearInterval(interval);
		}

		if (process.stdout.isTTY) {
			process.stdout.clearLine(0);
			process.stdout.write(`\r${titleMode}ing... 100% \n`);
		}

		console.log(`File successfully ${mode}ed`);
	});
};
