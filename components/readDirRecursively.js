const FS = require('fs');
const Path = require('path');

function readDirRecursively(dir) {
	let files = [];
	
	FS.readdirSync(dir).forEach((filename) => {
		let fullFilePath = Path.join(dir, filename);
		let stat = FS.statSync(fullFilePath);
		if (stat.isDirectory()) {
			files = files.concat(readDirRecursively(fullFilePath));
		} else {
			files.push({
				path: fullFilePath,
				stat
			});
		}
	});
	
	return files;
}

module.exports = readDirRecursively;
