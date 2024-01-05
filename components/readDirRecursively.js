const FS = require('fs').promises;
const Path = require('path');

async function readDirRecursively(dir) {
	let files = [];

	let dirListing = await FS.readdir(dir);
	for (let i = 0; i < dirListing.length; i++) {
		let filename = dirListing[i];

		let fullFilePath = Path.join(dir, filename);
		let stat = await FS.stat(fullFilePath);
		if (stat.isDirectory()) {
			files = files.concat(await readDirRecursively(fullFilePath));
		} else {
			files.push({
				path: fullFilePath,
				stat
			});
		}
	}

	return files;
}

module.exports = readDirRecursively;
