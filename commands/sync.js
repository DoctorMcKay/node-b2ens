const B2 = require('../b2/client.js');
const Crypto = require('crypto');
const FS = require('fs');
const StdLib = require('@doctormckay/stdlib');

const Encryption = require('../components/encryption.js');
const PassThroughProgressStream = require('../components/PassThroughProgressStream.js');
const debugLog = require('../components/logging.js');

const LAST_MODIFIED_KEY = 'src_last_modified_millis';
const MAX_CONCURRENT_UPLOADS = 5; // used only for large files at the moment

let g_UploadDetails;

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
		console.log('Syncfile is corrupt.');
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

let b2 = new B2(syncfile.accountId || syncfile.keyId, syncfile.applicationKey || syncfile.appKey, syncfile.debug);

let startTime = Date.now();
main().then(() => {
	console.log(`Done in ${Date.now() - startTime} milliseconds`);
	process.exit(0);
}).catch(err => console.error(err));

async function main() {
	let publicKey = null;
	await new Promise((resolve) => {
		if (syncfile.encryptionKey.publicKey) {
			publicKey = syncfile.encryptionKey.publicKey;
			resolve();
		} else {
			FS.readFile(syncfile.encryptionKey.publicKeyPath, (err, file) => {
				if (err) {
					console.error(`Cannot read public key from ${syncfile.encryptionKey.publicKeyPath}: ${err.message}`);
					process.exit(4);
				}

				publicKey = file.toString('ascii');
				resolve();
			});
		}
	});

	if (!publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
		console.error('Malformed public key: should be in PEM format');
		process.exit(4);
	}

	await b2.authorize();
	console.log(`Authorized with B2 account ${b2.authorization.accountId}; using API URL ${b2.authorization.apiUrl}`);

	let bucket;
	try {
		bucket = await b2.getBuckets({bucketName: syncfile.remote.bucket});
	} catch (ex) {
		if (ex.body && ex.body.code) {
			console.error(`Invalid bucket: ${ex.body.code}`);
		} else {
			console.error(`Invalid bucket: ${ex.message}`);
		}
		process.exit(5);
	}

	if (!bucket || !bucket.buckets || !bucket.buckets[0]) {
		console.error('Cannot get bucket data: unknown error');
		process.exit(5);
	}

	bucket = bucket.buckets[0];
	let prefixMsg = syncfile.remote.prefix ? ` prefix ${syncfile.remote.prefix}` : '';
	console.log(`Syncing local directory ${syncfile.local.directory} with remote bucket ${bucket.bucketName} (${bucket.bucketId})${prefixMsg}`);

	console.log('Listing files in bucket...');
	let {files} = await b2.listAllFileNames(bucket.bucketId, {prefix: syncfile.remote.prefix || ''});
	let bucketFiles = {};
	files.forEach((file) => {
		if (syncfile.remote.prefix) {
			file.fileName = file.fileName.replace(syncfile.remote.prefix, ''); // replaces the first occurrence only
		}

		bucketFiles[file.fileName] = file;
	});

	console.log('Examining local directory...');
	let localFiles = listLocalFiles(syncfile.local.directory, syncfile.local.exclude || []);

	try {
		for (let i in localFiles) {
			if (!bucketFiles[i]) {
				// Missing in remote
				await uploadLocalFile(bucket.bucketId, localFiles[i], publicKey, 'new', syncfile.remote.prefix || '');
			} else {
				if (!bucketFiles[i].fileInfo || !bucketFiles[i].fileInfo[LAST_MODIFIED_KEY]) {
					console.log(`Warning: File ${i} is missing a modification time`);
				} else if (bucketFiles[i].fileInfo[LAST_MODIFIED_KEY] != Math.floor(localFiles[i].stat.mtimeMs)) {
					await uploadLocalFile(bucket.bucketId, localFiles[i], publicKey, 'modified', syncfile.remote.prefix || '');
				}
			}
		}

		for (let i in bucketFiles) {
			if (!localFiles[i]) {
				// Missing locally
				await hideRemoteFile(bucketFiles[i], syncfile.remote.prefix || '');
			}
		}

		await cancelUnfinishedLargeFiles(bucket.bucketId, syncfile.remote.prefix || '');
	} catch (ex) {
		console.error('FATAL ERROR');
		console.error(ex);
		process.exit(1000);
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

async function uploadLocalFile(bucketId, file, publicKey, why, prefix, retryCount = 0) {
	if (file.stat.size > 100 * 1000 * 1000) {
		// More than 100 MB
		return await uploadLargeLocalFile(bucketId, file, publicKey, prefix);
	}

	let eol = process.stdout.isTTY ? '' : '\n';
	process.stdout.write(`Uploading ${why} file ${file.fileName}... ${eol}`);

	try {
		let read = FS.createReadStream(file.fullPath);
		let encrypt = Encryption.createEncryptStream(publicKey);
		read.pipe(encrypt);

		let uploadDetails = await getUploadDetails(bucketId);
		let uploadStartTime = Date.now();
		let response = await b2.uploadFile(uploadDetails, {
			filename: prefix + file.fileName,
			contentLength: file.stat.size + encrypt.overheadLength,
			b2Info: {
				[LAST_MODIFIED_KEY]: Math.floor(file.stat.mtimeMs)
			}
		}, encrypt, (progress) => {
			if (process.stdout.isTTY) {
				let pct = Math.floor((progress.processedBytes / file.stat.size) * 100);
				process.stdout.clearLine(0);
				process.stdout.write(`\rUploading ${why} file ${file.fileName}... ${pct}% (${StdLib.Units.humanReadableBytes(progress.processedBytes, false, true)}) `);
			}
		});

		let host = (new URL(uploadDetails.uploadUrl)).host;
		let fileSize = StdLib.Units.humanReadableBytes(file.stat.size);
		debugLog(`Uploaded ${file.fileName} (${fileSize}) successfully. Average speed to ${host} was ${StdLib.Units.humanReadableBytes(file.stat.size / ((Date.now() - uploadStartTime) / 1000))}/s`);

		console.log(`complete`);

		return response;
	} catch (ex) {
		if (retryCount < 5) {
			g_UploadDetails = null;
			return await uploadLocalFile(bucketId, file, publicKey, why, prefix, retryCount + 1);
		} else {
			throw ex;
		}
	}
}

async function uploadLargeLocalFile(bucketId, file, publicKey, prefix, retries = 0) {
	let eol = process.stdout.isTTY ? '' : '\n';
	process.stdout.write(`Uploading large file ${file.fileName}... preparing ${eol}`);

	let chunkSize = Math.max(50 * 1000 * 1000, Math.ceil(file.stat.size / 10000)); // minimum 50 MB for each chunk
	let readStream = FS.createReadStream(file.fullPath);
	let encrypt = Encryption.createEncryptStream(publicKey, {highWaterMark: chunkSize * 2});
	readStream.pipe(encrypt);

	// TODO handle stream errors

	let response;
	try {
		response = await b2.startLargeFile(bucketId, {
			filename: prefix + file.fileName,
			b2Info: {
				[LAST_MODIFIED_KEY]: Math.floor(file.stat.mtimeMs).toString()
			}
		});
	} catch (ex) {
		if (process.stdout.isTTY) {
			process.stdout.clearLine(0);
			process.stdout.write('\r');
		}
		process.stdout.write(`Uploading large file ${file.fileName}... ${ex.message} \n`);

		if (retries >= 5) {
			console.log(`Large file ${file.fileName} failed fatally`);
			return;
		}

		await StdLib.Promises.sleepAsync(2000);
		return await uploadLargeLocalFile(bucketId, file, publicKey, prefix, retries + 1);
	}

	if (!response.fileId) {
		console.error(`Did not get a file ID uploading large file ${file.fileName}`);
		process.exit(5);
	}

	let fileId = response.fileId;

	let partHashes = [];
	let processedChunks = 0;
	let bytesUploaded = 0; // this won't be exact because we're counting encrypted bytes, but it's close enough

	let ended = false;
	encrypt.on('end', () => ended = true);

	if (process.stdout.isTTY) {
		process.stdout.clearLine(0);
		process.stdout.write(`\rUploading large file ${file.fileName}... 0% ${eol}`);
	}

	let printUploadStatus = () => {
		if (process.stdout.isTTY) {
			let pct = Math.floor((bytesUploaded / file.stat.size) * 100);
			process.stdout.clearLine(0);
			process.stdout.write(`\rUploading large file ${file.fileName}... ${pct}% (${StdLib.Units.humanReadableBytes(bytesUploaded)}) `);
		}
	};

	// Spin up some "threads" (promises) to handle uploading
	let uploadThreads = [];
	let threadStatuses = {};
	for (let i = 0; i < (syncfile.uploadThreads || MAX_CONCURRENT_UPLOADS); i++) {
		let threadId = i;

		uploadThreads.push(new Promise(async (resolve) => {
			let uploadDetails, data;

			while ((data = await getNextChunk()) !== null) {
				let chunkId = processedChunks++;

				let attempts = 0;
				let err = null;
				let dataStream;
				do {
					// Reset err or else we will think we had an error even if this succeeds
					err = null;

					try {
						threadStatuses[threadId] = {
							chunkId,
							startTime: Date.now(),
							bytes: 0,
							totalBytes: data.length
						};

						if (!uploadDetails) {
							uploadDetails = await b2.getLargeFilePartUploadDetails(fileId);
							debugLog(`Thread ${threadId} got large file part upload details`);
						}

						let host = (new URL(uploadDetails.uploadUrl)).host;
						debugLog(`Thread ${threadId} starting chunk ${chunkId} on attempt ${attempts + 1} (${host})`);

						dataStream = new PassThroughProgressStream(data);

						let hash = Crypto.createHash('sha1');
						hash.update(data);
						hash = hash.digest('hex');

						let uploadStartTime = Date.now();
						let observedProcessedBytes = 0;

						let uploadResult = await b2.uploadLargeFilePart(uploadDetails, {
							partNumber: chunkId + 1,
							contentLength: data.length,
							sha1: hash
						}, dataStream, (progress) => {
							bytesUploaded += progress.processedBytes - threadStatuses[threadId].bytes;
							threadStatuses[threadId].bytes = progress.processedBytes;
						});

						// part upload succeeded
						let bytesPerSecond = Math.round(data.length / ((Date.now() - uploadStartTime) / 1000));
						debugLog(`Thread ${threadId} finished uploading chunk ${chunkId} successfully on attempt ${attempts + 1}. Average speed to ${host} is ${StdLib.Units.humanReadableBytes(bytesPerSecond)}/s`);

						bytesUploaded += data.length - threadStatuses[threadId].bytes;
						threadStatuses[threadId] = null;
						partHashes[chunkId] = uploadResult.contentSha1;
						break;
					} catch (ex) {
						dataStream.destroy();
						let exCode = ex.body && ex.body.code;
						if (
							ex.code == 'ECONNRESET' ||
							(exCode && ['internal_error', 'bad_auth_token', 'expired_auth_token', 'service_unavailable'].includes(exCode))
						) {
							// we'll get a new upload url and try again
							uploadDetails = null;
						} else {
							err = ex;
						}

						// Remove this chunk from bytesUploaded
						bytesUploaded -= threadStatuses[threadId].bytes;
						threadStatuses[threadId] = null;

						debugLog(`Thread ${threadId} got an error uploading large file chunk ${chunkId}: ${ex.message}`);
						console.error(`\nError uploading large file: ${ex.message}`);
						await StdLib.Promises.sleepAsync(5000); // wait 5 seconds
					}
				} while (++attempts <= 10);

				if (err) {
					// Fatal error
					console.error(`\nFatal error uploading large file ${file.fileName}`);
					console.error(err);
					process.exit(5);
				}

				printUploadStatus();
			} // get next chunk

			// No more data; we're done
			resolve();
		}));
	}

	let uploadStatusInterval = setInterval(printUploadStatus, 500);

	let threadStatusLoggingInterval = setInterval(() => {
		let threadStatusFormatted = uploadThreads.map((_, i) => {
			let threadStatus = `T${i}: `;
			if (!threadStatuses[i]) {
				threadStatus += '---';
			} else {
				threadStatus += `C${threadStatuses[i].chunkId} ${threadStatuses[i].bytes}/${threadStatuses[i].totalBytes} ` +
					Math.floor((threadStatuses[i].bytes / threadStatuses[i].totalBytes) * 100) + '% ' +
					StdLib.Units.humanReadableBytes(Math.round(threadStatuses[i].bytes / ((Date.now() - threadStatuses[i].startTime) / 1000))) + '/s';
			}

			return threadStatus;
		}).join(' | ');

		debugLog(threadStatusFormatted);
	}, 2000);

	debugLog(`Starting ${uploadThreads.length} upload threads for large file ${file.fileName}`);

	await Promise.all(uploadThreads);

	clearInterval(uploadStatusInterval);
	clearInterval(threadStatusLoggingInterval);

	debugLog(`Large file ${file.fileName} uploaded all parts successfully`);

	if (process.stdout.isTTY) {
		process.stdout.clearLine(0);
		process.stdout.write("\r");
		process.stdout.write(`Uploading large file ${file.fileName}... finalizing `);
	}

	try {
		await b2.finishLargeFile(fileId, partHashes);
	} catch (ex) {
		if (process.stdout.isTTY) {
			process.stdout.clearLine(0);
			process.stdout.write("\r");
		}

		console.log(`Uploading large file ${file.fileName}... ERROR: ${ex.message}`);

		if (retries >= 5) {
			console.log(`Large file ${file.fileName} failed fatally`);
		} else {
			await StdLib.Promises.sleepAsync(2000);
			return await uploadLargeLocalFile(bucketId, file, publicKey, prefix, retries + 1);
		}
	}

	if (process.stdout.isTTY) {
		process.stdout.clearLine(0);
		process.stdout.write("\r");
	}

	console.log(`Uploading large file ${file.fileName}... complete`);

	async function getNextChunk() {
		if (ended) {
			return null;
		}

		let chunk = encrypt.read(chunkSize);
		if (chunk !== null) {
			return chunk;
		} else {
			await new Promise(resolve => setTimeout(resolve, 500));
			return await getNextChunk();
		}
	}
}

async function hideRemoteFile(file, prefix) {
	console.log(`Hiding missing remote file ${file.fileName}`);
	await b2.hideFile(file.bucketId, prefix + file.fileName);
}

async function getUploadDetails(bucketId) {
	if (g_UploadDetails) {
		return g_UploadDetails;
	}

	g_UploadDetails = await b2.getUploadDetails(bucketId);
	return g_UploadDetails;
}

function sha1(data) {
	let hash = Crypto.createHash('sha1');
	hash.update(data);
	return hash.digest('hex');
}

async function cancelUnfinishedLargeFiles(bucketId, namePrefix) {
	let {files} = await b2.listAllUnfinishedLargeFiles(bucketId, {namePrefix});

	console.log(`Found ${files.length} unfinished large files to cancel`);
	for (let i = 0; i < files.length; i++) {
		await b2.cancelUnfinishedLargeFile(files[i].fileId);
		console.log(`Canceled large file ${files[i].fileId}`);
	}
}
