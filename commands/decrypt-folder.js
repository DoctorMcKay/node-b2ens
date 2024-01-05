const FS = require('fs');
const Path = require('path');

const encryptOrDecryptFile = require('../components/encryptOrDecryptFile.js');
const readDirRecursively = require('../components/readDirRecursively.js');

(async function() {
	let keyPath = process.argv[3];
	let folderPath = process.argv[4];
	let outputFolderPath = process.argv[5];

	if (!folderPath || !keyPath || !outputFolderPath) {
		console.error('Usage: b2ens decrypt-folder <path to PEM-encoded private key> <path to folder> <path to output folder>');
		process.exit(2);
	}

	folderPath = Path.normalize(folderPath);
	outputFolderPath = Path.normalize(outputFolderPath);
	let key = FS.readFileSync(keyPath).toString('ascii');

	let files = await readDirRecursively(folderPath);
	console.log(`Found ${files.length} files in folder`);

	let countSuccess = 0;
	let countFailure = 0;

	for (let i = 0; i < files.length; i++) {
		let file = files[i];

		console.log(`Decrypting ${file.path}`);

		try {
			let outputPath = outputFolderPath + file.path.substring(folderPath.length);
			let outputDir = Path.dirname(outputPath);
			FS.mkdirSync(outputDir, {recursive: true});
			await encryptOrDecryptFile('decrypt', key, file.path, outputPath);
			countSuccess++;

			FS.unlinkSync(file.path);
			let dir = file.path;

			// Delete the parent folders if they're empty
			while ((dir = Path.dirname(dir)) != folderPath) {
				if (FS.readdirSync(dir).length == 0) {
					FS.rmdirSync(dir);
				}
			}
		} catch (ex) {
			countFailure++;
			console.error(`Failed to decrypt ${file.path}: ${ex.message}`);
		}
	}

	console.log(`Process complete. ${countSuccess} files successfully decrypted. ${countFailure} files failed to decrypt.`);
})();
