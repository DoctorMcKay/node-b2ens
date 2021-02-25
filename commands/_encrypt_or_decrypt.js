const FS = require('fs');

const encryptOrDecryptFile = require('../components/encryptOrDecryptFile.js');

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

	let key = FS.readFileSync(keyPath).toString('ascii');

	let titleMode = mode.substring(0, 1).toUpperCase() + mode.substring(1);
	console.log(`${titleMode}ing to output file ${outputFilePath}`);
	encryptOrDecryptFile(mode, key, filePath, outputFilePath).then(() => {
		console.log(`File successfully ${mode}ed`);
	}).catch((err) => {
		process.stderr.write(`${titleMode}ion error: ${err.message}\n`);
		process.exit(3);
	});
};
