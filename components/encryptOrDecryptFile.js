const FS = require('fs');
const StdLib = require('@doctormckay/stdlib');

const Encryption = require('./encryption.js');

function encryptOrDecryptFile(mode, key, filePath, outputFilePath) {
	return new Promise((resolve, reject) => {
		let stat = FS.statSync(filePath);
		let readStream = FS.createReadStream(filePath);
		let cryptoStream = Encryption[mode == 'encrypt' ? 'createEncryptStream' : 'createDecryptStream'](key);
		let outStream = FS.createWriteStream(outputFilePath);
		
		let titleMode = mode.substring(0, 1).toUpperCase() + mode.substring(1);
		readStream.pipe(cryptoStream).pipe(outStream);
		
		let errored = false;
		
		cryptoStream.on('error', (err) => {
			errored = true;
			
			if (process.stdout.isTTY) {
				process.stdout.write('\n');
			}
			
			outStream.end();
			FS.unlinkSync(outputFilePath);
			return reject(err);
		});
		
		let interval = null;
		if (process.stdout.isTTY) {
			interval = setInterval(printBar, 100);
		}
		
		outStream.on('finish', () => {
			if (interval) {
				clearInterval(interval);
			}
			
			if (!errored && process.stdout.isTTY) {
				printBar(true);
				process.stdout.write('\n');
			}
			
			resolve();
		});
		
		function printBar(final) {
			let prefix = `\r${titleMode}ing... `;
			let barWidth = Math.min(40, process.stdout.columns - prefix.length - 1);
			let bar = StdLib.Rendering.progressBar(final ? stat.size : cryptoStream.processedBytes, stat.size, barWidth, true);
			process.stdout.write(`\r${titleMode}ing... ${bar} `);
		}
	});
}

module.exports = encryptOrDecryptFile;
