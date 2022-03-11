const B2 = require('../b2/client.js');
const Crypto = require('crypto');
const FS = require('fs');
const StdLib = require('@doctormckay/stdlib');

const Encryption = require('../components/encryption.js');
const PassThroughProgressStream = require('../components/PassThroughProgressStream.js');
const debugLog = require('../components/logging.js');

const LAST_MODIFIED_KEY = 'src_last_modified_millis';
const MAX_CONCURRENT_UPLOADS = 5;

let g_UploadDetails;
let g_ProgressDetails = {
	bytesSent: 0,
	filesSent: 0,
	totalBytes: 0,
	totalFiles: 0,
	activeUploads: 0,
	lastRollingByteCount: 0,
	rollingByteCounts: []
};
let g_ConsoleLogLines = [];
let g_ConsoleInDynamicMode = false;

function log(msg) {
	let output = StdLib.Time.timestampString() + ' - ' + msg;

	if (!process.stdout.isTTY) {
		console.log(output);
	} else {
		g_ConsoleLogLines.push(StdLib.Time.timestampString() + ' - ' + msg);

		if (g_ConsoleLogLines.length > 400) {
			g_ConsoleLogLines = g_ConsoleLogLines.slice(-400);
		}

		if (!g_ConsoleInDynamicMode) {
			console.log(output);
		} else {
			// The console is in dynamic mode
			flushLogLines();
		}
	}
}

function flushLogLines() {
	process.stdout.cursorTo(0, 0);
	process.stdout.clearScreenDown();
	getLogLinesForFlush().forEach(line => process.stdout.write(line + '\n'));
	printProgressLine();
}

function getLogLinesForFlush() {
	let availableRows = process.stdout.rows - 1;
	let lines = [];
	for (let i = g_ConsoleLogLines.length - 1; i >= 0 && lines.length < availableRows; i--) {
		let line = g_ConsoleLogLines[i];
		let lineChunks = [];
		for (let j = 0; j < line.length; j += process.stdout.columns) {
			lineChunks.push(line.substring(j, j + process.stdout.columns));
		}

		// We've now chunkified this line into however many overflow lines it takes. Push them onto our lines array backwards
		lineChunks.reverse();
		lines = lines.concat(lineChunks);
	}

	lines.reverse();
	return lines;
}

function printProgressLine() {
	let now = Math.floor(Date.now() / 1000);
	if (now > g_ProgressDetails.lastRollingByteCount) {
		g_ProgressDetails.lastRollingByteCount = now;
		g_ProgressDetails.rollingByteCounts.push(g_ProgressDetails.bytesSent);
		if (g_ProgressDetails.rollingByteCounts.length > 10) {
			g_ProgressDetails.rollingByteCounts = g_ProgressDetails.rollingByteCounts.slice(-10);
		}
	}

	let averageSpeed = 0;
	if (g_ProgressDetails.rollingByteCounts.length > 0) {
		let first = g_ProgressDetails.rollingByteCounts[0];
		let last = g_ProgressDetails.rollingByteCounts[g_ProgressDetails.rollingByteCounts.length - 1];
		averageSpeed = (last - first) / g_ProgressDetails.rollingByteCounts.length;
	}

	process.stdout.cursorTo(0, process.stdout.rows - 1);
	process.stdout.clearLine(0);

	let etaSeconds = Math.max(0, Math.round((g_ProgressDetails.totalBytes - g_ProgressDetails.bytesSent) / averageSpeed));
	let etaHours = Math.floor(etaSeconds / (60 * 60));
	etaSeconds -= etaHours * 60 * 60;
	let etaMinutes = Math.floor(etaSeconds / 60);
	etaSeconds -= etaMinutes * 60;

	let infoTags = [
		`${g_ProgressDetails.activeUploads} cxns`,
		`${g_ProgressDetails.filesSent}/${g_ProgressDetails.totalFiles} files`,
		`${StdLib.Units.humanReadableBytes(g_ProgressDetails.bytesSent, false, true)}/${StdLib.Units.humanReadableBytes(g_ProgressDetails.totalBytes)}`,
		`${StdLib.Units.humanReadableBytes(averageSpeed, false, true)}/s`,
		isNaN(etaSeconds) ? 'ETA -:--' : `ETA ${etaHours > 0 ? `${etaHours}:` : ''}${etaMinutes}:${etaSeconds.toString().padStart(2, '0')}`
	];

	let infoTagPriority = [
		2, // bytes
		3, // speed
		4, // ETA
		0, // connections
		1  // files
	];

	let filteredInfoTags = new Array(infoTags.length);
	for (let i = 0; i < infoTagPriority.length; i++) {
		let tag = infoTags[infoTagPriority[i]];

		// reserve 15 columns for the progress bar and 1 column on each side of the progress bar

		if (filteredInfoTags.filter(v => v).join(' | ').length + tag.length + 3 >= process.stdout.columns - 17) {
			break;
		}

		filteredInfoTags[infoTagPriority[i]] = tag;
	}

	let progressLine = filteredInfoTags.filter(v => v).join(' | ');
	let progressBar = StdLib.Rendering.progressBar(
		// prevent 101%, since bytesSent can be more than totalBytes due to encryption overhead
		Math.min(g_ProgressDetails.bytesSent, g_ProgressDetails.totalBytes),
		g_ProgressDetails.totalBytes,
		process.stdout.columns - progressLine.length - 2,
		true
	);
	progressLine += ' ' + progressBar + ' ';

	process.stdout.write(progressLine);
}

let syncfile = process.argv[3];
if (!syncfile) {
	console.error('Usage: b2ens sync <syncfile>');
	process.exit(2);
}

// Try to read the syncfile
try {
	syncfile = JSON.parse(FS.readFileSync(syncfile).toString('utf8'));
} catch (ex) {
	if (ex.code == 'ENOENT') {
		console.error('Invalid path to syncfile.');
		process.exit(3);
	} else {
		console.error('Syncfile is corrupt.');
		process.exit(4);
	}
}

// Make sure the syncfile contains what we expect
let err;
if (!syncfile.accountId && !syncfile.keyId) {
	err = 'Missing keyId';
} else if (!syncfile.applicationKey && !syncfile.appKey) {
	err = 'Missing applicationKey';
} else if (!syncfile.local || !syncfile.local.directory) {
	err = 'Missing local.directory';
} else if (!syncfile.remote || !syncfile.remote.bucket) {
	err = 'Missing remote.bucket';
} else if (!syncfile.encryptionKey || (!syncfile.encryptionKey.publicKeyPath && !syncfile.encryptionKey.publicKey)) {
	err = 'Missing encryptionKey.publicKeyPath and encryptionKey.publicKey (one of the two is required)';
}

if (err) {
	console.error(err);
	process.exit(4);
}

let g_Bucket;
let g_PublicKey = null;
let g_UploadQueue = new StdLib.DataStructures.AsyncQueue(processUpload, syncfile.uploadThreads || MAX_CONCURRENT_UPLOADS);

let b2 = new B2(syncfile.accountId || syncfile.keyId, syncfile.applicationKey || syncfile.appKey, syncfile.debug);

let startTime = Date.now();
main().then(() => {
	let timeMs = Date.now() - startTime;
	let timeHours = Math.floor(timeMs / (1000 * 60 * 60));
	timeMs -= timeHours * (1000 * 60 * 60);
	let timeMinutes = Math.floor(timeMs / (1000 * 60));
	timeMs -= timeMinutes * (1000 * 60);
	let timeSeconds = Math.floor(timeMs / 1000);

	log(`Done in ${timeHours.toString().padStart(2, '0')}:${timeMinutes.toString().padStart(2, '0')}:${timeSeconds.toString().padStart(2, '0')}`);
	process.exit(0);
}).catch(err => console.error(err));

async function main() {
	await new Promise((resolve) => {
		if (syncfile.encryptionKey.publicKey) {
			g_PublicKey = syncfile.encryptionKey.publicKey;
			resolve();
		} else {
			FS.readFile(syncfile.encryptionKey.publicKeyPath, (err, file) => {
				if (err) {
					console.error(`Cannot read public key from ${syncfile.encryptionKey.publicKeyPath}: ${err.message}`);
					process.exit(4);
				}

				g_PublicKey = file.toString('ascii');
				resolve();
			});
		}
	});

	if (!g_PublicKey.includes('-----BEGIN PUBLIC KEY-----')) {
		console.error('Malformed public key: should be in PEM format');
		process.exit(4);
	}

	await b2.authorize();
	log(`Authorized with B2 account ${b2.authorization.accountId}; using API URL ${b2.authorization.apiUrl}`);

	try {
		g_Bucket = await b2.getBuckets({bucketName: syncfile.remote.bucket});
	} catch (ex) {
		if (ex.body && ex.body.code) {
			console.error(`Invalid bucket: ${ex.body.code}`);
		} else {
			console.error(`Invalid bucket: ${ex.message}`);
		}
		process.exit(5);
	}

	if (!g_Bucket || !g_Bucket.buckets || !g_Bucket.buckets[0]) {
		console.error('Cannot get bucket data: unknown error');
		process.exit(5);
	}

	g_Bucket = g_Bucket.buckets[0];
	let prefixMsg = syncfile.remote.prefix ? ` prefix ${syncfile.remote.prefix}` : '';
	log(`Syncing local directory ${syncfile.local.directory} with remote bucket ${g_Bucket.bucketName} (${g_Bucket.bucketId})${prefixMsg}`);

	log('Listing files in bucket...');
	let {files} = await b2.listAllFileNames(g_Bucket.bucketId, {prefix: syncfile.remote.prefix || ''});
	let bucketFiles = {};
	files.forEach((file) => {
		if (syncfile.remote.prefix) {
			file.fileName = file.fileName.replace(syncfile.remote.prefix, ''); // replaces the first occurrence only
		}

		bucketFiles[file.fileName] = file;
	});

	log('Examining local directory...');
	let localFiles = listLocalFiles(syncfile.local.directory, syncfile.local.exclude || []);

	try {
		for (let i in localFiles) {
			if (
				!bucketFiles[i] ||
				(
					bucketFiles[i].fileInfo &&
					bucketFiles[i].fileInfo[LAST_MODIFIED_KEY]
					&& bucketFiles[i].fileInfo[LAST_MODIFIED_KEY] != Math.floor(localFiles[i].stat.mtimeMs)
				)
			) {
				// Missing or different in remote
				g_ProgressDetails.totalFiles++;
				g_ProgressDetails.totalBytes += localFiles[i].stat.size;

				g_UploadQueue.push(localFiles[i]);
			}
		}

		if (g_UploadQueue.length == 0) {
			log('Nothing to upload');
		} else {
			log('Starting uploads');

			// Start up our progress display interval
			let progressOutputInterval = null;
			if (process.stdout.isTTY) {
				flushLogLines();
				process.stdout.on('resize', flushLogLines);
				progressOutputInterval = setInterval(printProgressLine, 500);
				g_ConsoleInDynamicMode = true;
			}

			await new Promise((resolve) => g_UploadQueue.drain = resolve);

			clearInterval(progressOutputInterval);
			g_ConsoleInDynamicMode = false;
			process.stdout.removeListener('resize', flushLogLines);

			// Clear the progress line
			process.stdout.cursorTo(0, process.stdout.rows - 1);
			process.stdout.clearLine(0);

			// Figure out where we need to move the cursor to
			process.stdout.cursorTo(0, getLogLinesForFlush().length);
		}

		let hideQueue = new StdLib.DataStructures.AsyncQueue(({file, prefix}, callback) => {
			hideRemoteFile(file, prefix).then(() => callback()).catch(callback);
		}, 10);

		for (let i in bucketFiles) {
			if (!localFiles[i]) {
				// Missing locally
				hideQueue.push({file: bucketFiles[i], prefix: syncfile.remote.prefix || ''});
			}
		}

		if (hideQueue.length > 0) {
			await new Promise((resolve) => hideQueue.drain = resolve);
		}

		await cancelUnfinishedLargeFiles(g_Bucket.bucketId, syncfile.remote.prefix || '');
	} catch (ex) {
		console.error('FATAL ERROR');
		console.error(ex);
		process.exit(1000);
	}
}

async function processUpload(file, callback) {
	try {
		if (file.chunk) {
			await processChunkUpload(file);
		} else if (file.stat.size > 100 * 1000 * 1000) {
			// File is more than 100 MB. Upload it as a large file
			await processLargeUpload(file);
		} else {
			await processSmallUpload(file);
		}
	} catch (ex) {
		return callback(ex);
	}

	callback();
}

async function processSmallUpload(file) {
	await uploadLocalFile(g_Bucket.bucketId, file, g_PublicKey, syncfile.remote.prefix || '');
	log(`Upload ${file.fileName}`);
}

async function processLargeUpload(file) {
	let chunkSize = Math.max(50 * 1000 * 1000, Math.ceil(file.stat.size / 10000)); // minimum 50 MB for each chunk
	let readStream = FS.createReadStream(file.fullPath);
	let encryptStream = Encryption.createEncryptStream(g_PublicKey, {highWaterMark: chunkSize * 2});
	readStream.pipe(encryptStream);

	let largeFileDetails = {
		fileName: file.fileName,
		chunkSize,
		encryptStream,
		readChunks: 0,
		partHashes: new Array(Math.ceil(file.stat.size / chunkSize)),
		availableUploadDetails: [],
		ended: false
	};

	let response = await b2.startLargeFile(g_Bucket.bucketId, {
		filename: syncfile.remote.prefix + file.fileName,
		b2Info: {
			[LAST_MODIFIED_KEY]: Math.floor(file.stat.mtimeMs).toString()
		}
	});

	if (!response.fileId) {
		throw new Error(`Did not get a file ID for uploading large file ${file.fileName}`);
	}

	largeFileDetails.fileId = response.fileId;

	encryptStream.on('end', () => largeFileDetails.ended = true);

	// Go ahead and insert the first chunk into the queue
	await enqueueLargeFileChunk(largeFileDetails);
}

async function enqueueLargeFileChunk(largeFileDetails) {
	if (largeFileDetails.ended) {
		return;
	}

	let chunk = largeFileDetails.encryptStream.read(largeFileDetails.chunkSize);
	if (chunk === null) {
		// No data available yet, waiting on the disk
		await StdLib.Promises.sleepAsync(500);
		return await enqueueLargeFileChunk(largeFileDetails);
	}

	g_UploadQueue.insert({
		largeFileDetails,
		chunk,
		chunkId: ++largeFileDetails.readChunks
	});
}

async function processChunkUpload({largeFileDetails, chunk, chunkId}) {
	// Since we just pulled a chunk from the queue, let's go ahead and insert a chunk into the queue, if we have one
	enqueueLargeFileChunk(largeFileDetails);

	let attempts = 0;
	let err = null;
	let dataStream;

	do {
		// Reset err or else we will think we had an error even if this succeeds
		err = null;
		dataStream = null;
		let observedProcessedBytes = 0;

		try {
			let uploadDetails;
			if (largeFileDetails.availableUploadDetails.length == 0) {
				uploadDetails = await b2.getLargeFilePartUploadDetails(largeFileDetails.fileId);
			} else {
				uploadDetails = largeFileDetails.availableUploadDetails.splice(0, 1)[0];
			}

			let host = (new URL(uploadDetails.uploadUrl)).host;
			debugLog(`Starting chunk ${chunkId} on attempt ${attempts + 1} (${host})`);

			dataStream = new PassThroughProgressStream(chunk);

			let hash = Crypto.createHash('sha1');
			hash.update(chunk);
			hash = hash.digest('hex');

			let uploadStartTime = Date.now();

			g_ProgressDetails.activeUploads++;

			let uploadResult = await b2.uploadLargeFilePart(uploadDetails, {
				partNumber: chunkId,
				contentLength: chunk.length,
				sha1: hash
			}, dataStream, (progress) => {
				g_ProgressDetails.bytesSent += progress.processedBytes - observedProcessedBytes;
				observedProcessedBytes = progress.processedBytes;
			});

			// part upload succeeded
			largeFileDetails.availableUploadDetails.push(uploadDetails);
			g_ProgressDetails.activeUploads--;
			let bytesPerSecond = Math.round(chunk.length / ((Date.now() - uploadStartTime) / 1000));
			debugLog(`Finished uploading chunk ${chunkId} successfully on attempt ${attempts + 1}. Average speed to ${host} is ${StdLib.Units.humanReadableBytes(bytesPerSecond)}/s`);

			largeFileDetails.partHashes[chunkId - 1] = uploadResult.contentSha1;

			// Is the file finished?
			let fileIsFinished = true;
			for (let i = 0; i < largeFileDetails.partHashes.length; i++) {
				if (typeof largeFileDetails.partHashes[i] != 'string') {
					fileIsFinished = false;
					break;
				}
			}

			if (fileIsFinished) {
				await b2.finishLargeFile(largeFileDetails.fileId, largeFileDetails.partHashes);
				g_ProgressDetails.filesSent++;
				log(`Upload ${largeFileDetails.fileName}`);
			}

			break;
		} catch (ex) {
			log(ex);
			g_ProgressDetails.activeUploads--;

			// noinspection PointlessBooleanExpressionJS
			if (dataStream) {
				// noinspection JSObjectNullOrUndefined
				dataStream.destroy();
			}

			let exCode = ex.body && ex.body.code;
			if (
				ex.code == 'ECONNRESET' ||
				(exCode && ['internal_error', 'bad_auth_token', 'expired_auth_token', 'service_unavailable'].includes(exCode))
			) {
				// we'll get a new upload url and try again
			} else {
				err = ex;
			}

			// Remove this chunk from bytesUploaded
			g_ProgressDetails.bytesSent -= observedProcessedBytes;

			await StdLib.Promises.sleepAsync(5000); // wait 5 seconds
		}
	} while (++attempts <= 10);

	if (err) {
		// Fatal error
		let ex = new Error(`Fatal error uploading large file ${largeFileDetails.fileName}: ${err.message}`);
		ex.inner = err;
		throw ex;
	}
}

/**
 * List and stat the local files on disk.
 * @param {string} directory - The full directory on the local disk
 * @param {array} exclude
 * @param {string} [prefix] - The prefix we're examining local to the root
 * @param {object} [files]
 */
function listLocalFiles(directory, exclude, prefix, files) {
	prefix = prefix || '';
	files = files || {};

	FS.readdirSync(directory).forEach((file) => {
		let filename = directory + '/' + file;
		let relativeFilename = prefix + (prefix ? '/' : '') + file;
		let stat = FS.statSync(filename);
		if (stat.isDirectory()) {
			listLocalFiles(filename, exclude, relativeFilename, files);
		} else {
			// Is this file excluded?
			// noinspection RedundantIfStatementJS
			let isExcluded = exclude.some((exclusion) => {
				let normalizedFilename = normalize(filename);
				let normalizedExclusion = normalize(exclusion);

				if (normalizedExclusion[0] == '!') {
					// This is a wildcard exclusion. Turn the string into a regexp.
					// We use the \0 null character in place of * asterisk in our first two replacements in order to
					// avoid replacing the asterisks generated by the first replacement in the second one. We use
					// null as a standin since it's illegal in filenames.
					normalizedExclusion = normalizedExclusion
						.substring(1)
						.replace(/\*\*/g, '.\0')
						.replace(/\*/g, '[^/]\0')
						.replace(/\0/g, '*');

					return (new RegExp(`^${normalizedExclusion}$`)).test(normalizedFilename);
				}

				if (normalizedFilename == normalizedExclusion) {
					return true;
				}

				// noinspection RedundantIfStatementJS
				if (normalizedFilename.startsWith(normalizedExclusion + '/')) {
					return true;
				}

				return false;
			});

			if (!isExcluded) {
				files[relativeFilename] = {fullPath: filename, fileName: relativeFilename, stat};
			}
		}
	});

	return files;

	function normalize(filepath) {
		return filepath.replace(/\\/g, '/');
	}
}

async function uploadLocalFile(bucketId, file, publicKey, prefix, retryCount = 0) {
	let observedProcessedBytes = 0;

	try {
		let read = FS.createReadStream(file.fullPath);
		let encrypt = Encryption.createEncryptStream(publicKey);
		read.pipe(encrypt);

		g_ProgressDetails.activeUploads++;

		let uploadDetails = await getUploadDetails(bucketId);
		let uploadStartTime = Date.now();
		let response = await b2.uploadFile(uploadDetails, {
			filename: prefix + file.fileName,
			contentLength: file.stat.size + encrypt.overheadLength,
			b2Info: {
				[LAST_MODIFIED_KEY]: Math.floor(file.stat.mtimeMs)
			}
		}, encrypt, (progress) => {
			g_ProgressDetails.bytesSent += progress.processedBytes - observedProcessedBytes;
			observedProcessedBytes = progress.processedBytes;
		});

		let host = (new URL(uploadDetails.uploadUrl)).host;
		let fileSize = StdLib.Units.humanReadableBytes(file.stat.size);
		debugLog(`Uploaded ${file.fileName} (${fileSize}) successfully. Average speed to ${host} was ${StdLib.Units.humanReadableBytes(file.stat.size / ((Date.now() - uploadStartTime) / 1000))}/s`);

		g_ProgressDetails.activeUploads--;
		g_ProgressDetails.filesSent++;

		return response;
	} catch (ex) {
		g_ProgressDetails.activeUploads--;
		g_ProgressDetails.bytesSent -= observedProcessedBytes;

		if (retryCount < 5) {
			g_UploadDetails = null;
			return await uploadLocalFile(bucketId, file, publicKey, prefix, retryCount + 1);
		} else {
			throw ex;
		}
	}
}

async function hideRemoteFile(file, prefix) {
	log(`Hide ${file.fileName}`);
	await b2.hideFile(file.bucketId, prefix + file.fileName);
}

async function getUploadDetails(bucketId) {
	if (g_UploadDetails) {
		return g_UploadDetails;
	}

	g_UploadDetails = await b2.getUploadDetails(bucketId);
	return g_UploadDetails;
}

async function cancelUnfinishedLargeFiles(bucketId, namePrefix) {
	let {files} = await b2.listAllUnfinishedLargeFiles(bucketId, {namePrefix});

	log(`Found ${files.length} unfinished large files to cancel`);
	for (let i = 0; i < files.length; i++) {
		await b2.cancelUnfinishedLargeFile(files[i].fileId);
		log(`Canceled large file ${files[i].fileId}`);
	}
}
