const B2 = require('backblaze-b2');
const FS = require('fs');

const Encryption = require('../components/encryption.js');

const LAST_MODIFIED_KEY = 'src_last_modified_millis';

let g_UploadUrl;

let syncfile = process.argv[3];
if (!syncfile) {
	console.error('Usage: b2cns sync <syncfile>');
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

let b2 = new B2({
	"accountId": syncfile.accountId || syncfile.keyId,
	"applicationKey": syncfile.applicationKey || syncfile.appKey
});

main().then(() => console.log('Done')).catch(err => console.error(err));

async function main() {
	let publicKey;
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
	console.log(`Authorized with B2 account ${b2.accountId}; using API URL ${b2.apiUrl}`);

	let bucket;
	try {
		bucket = await b2.getBucket({"bucketName": syncfile.remote.bucket});
	} catch (ex) {
		if (ex.response && ex.response.data && ex.response.data.code) {
			console.error(`Invalid bucket: ${ex.response.data.code}`);
		} else {
			console.error(`Invalid bucket: ${ex.message}`);
		}
		process.exit(5);
	}

	if (!bucket || !bucket.data.buckets || !bucket.data.buckets[0]) {
		console.error('Cannot get bucket data: unknown error');
		process.exit(5);
	}

	bucket = bucket.data.buckets[0];
	let prefixMsg = syncfile.remote.prefix ? ` prefix ${syncfile.remote.prefix}` : '';
	console.log(`Syncing local directory ${syncfile.local.directory} with remote bucket ${bucket.bucketName} (${bucket.bucketId})${prefixMsg}`);

	console.log('Listing files in bucket...');
	let bucketFiles = await listBucketFiles(bucket.bucketId, syncfile.remote.prefix || '');

	console.log('Examining local directory...');
	let localFiles = listLocalFiles(syncfile.local.directory);

	for (let i in localFiles) {
		if (!bucketFiles[i]) {
			// Missing in remote
			await uploadLocalFile(bucket.bucketId, localFiles[i], publicKey, 'new');
		} else {
			if (!bucketFiles[i].fileInfo || !bucketFiles[i].fileInfo[LAST_MODIFIED_KEY]) {
				console.log(`Warning: File ${i} is missing a modification time`);
			} else if (bucketFiles[i].fileInfo[LAST_MODIFIED_KEY] != localFiles[i].stat.mtimeMs) {
				await uploadLocalFile(bucket.bucketId, localFiles[i], publicKey, 'modified');
			}
		}
	}

	for (let i in bucketFiles) {
		if (!localFiles[i]) {
			// Missing locally
			await hideRemoteFile(bucketFiles[i]);
		}
	}
}

async function listBucketFiles(bucketId, prefix) {
	let files = {};
	let startFileName = '';

	do {
		let response = await b2.listFileNames({
			bucketId,
			startFileName,
			prefix,
			maxFileCount: 10000
		});

		if (!response.data.files) {
			console.error('Unknown error listing bucket files');
			process.exit(5);
		}

		response.data.files.forEach((file) => {
			files[file.fileName] = file;
		});

		startFileName = response.data.nextFileName;
	} while (startFileName);

	return files;
}

/**
 * List and stat the local files on disk.
 * @param {string} directory - The full directory on the local disk
 * @param {string} [prefix] - The prefix we're examining local to the root
 * @param {object} [files]
 */
function listLocalFiles(directory, prefix, files) {
	prefix = prefix || '';
	files = files || {};

	FS.readdirSync(directory).forEach((file) => {
		let filename = directory + '/' + file;
		let relativeFilename = prefix + (prefix ? '/' : '') + file;
		let stat = FS.statSync(filename);
		if (stat.isDirectory()) {
			listLocalFiles(filename, relativeFilename, files);
		} else {
			files[relativeFilename] = {"fullPath": filename, "fileName": relativeFilename, stat};
		}
	});

	return files;
}

async function uploadLocalFile(bucketId, file, publicKey, why) {
	if (file.stat.size > 10000000) {
		// More than 10 MB
		return uploadLargeLocalFile(bucketId, file, publicKey);
	}

	let eol = process.stdout.isTTY ? '' : '\n';
	process.stdout.write(`Encrypting ${file.fileName}... ${eol}`);

	let data = await new Promise((resolve) => {
		let encrypt = Encryption.createEncryptStream(publicKey);
		FS.createReadStream(file.fullPath).pipe(encrypt);
		let fileChunks = [];
		encrypt.on('data', chunk => fileChunks.push(chunk));
		encrypt.on('end', () => {
			resolve(Buffer.concat(fileChunks));
		});
	});

	if (process.stdout.isTTY) {
		process.stdout.clearLine(0);
		process.stdout.write("\r");
	}
	process.stdout.write(`Uploading ${why} file ${file.fileName}... ${eol}`);

	try {
		let uploadUrl = await getUploadUrl(bucketId);
		let response = await b2.uploadFile({
			uploadUrl: uploadUrl.uploadUrl,
			uploadAuthToken: uploadUrl.uploadAuthToken,
			fileName: file.fileName,
			data,
			// Workaround for backblaze-b2 bug #68 - https://github.com/yakovkhalinsky/backblaze-b2/issues/68
			axios: {
				headers: {
					[`X-Bz-Info-${LAST_MODIFIED_KEY}`]: file.stat.mtimeMs
				}
			}
		});

		console.log(`complete`);

		return response.data;
	} catch (ex) {
		if (ex.response && ex.response.data && ex.response.data.code && ['bad_auth_token', 'expired_auth_token', 'service_unavailable'].includes(ex.response.data.code)) {
			g_UploadUrl = null;
			return await uploadLocalFile(bucketId, file, publicKey);
		} else {
			throw ex;
		}
	}
}

async function uploadLargeLocalFile(bucketId, file, publicKey) {
	let eol = process.stdout.isTTY ? '' : '\n';
	process.stdout.write(`Preparing large file ${file.fileName}... ${eol}`);

	let chunkSize = Math.max(5000000, Math.ceil(file.stat.size / 10000)); // minimum 5 MB for each chunk
	let readStream = FS.createReadStream(file.fullPath);
	let encrypt = Encryption.createEncryptStream(publicKey, {"highWaterMark": chunkSize * 2});
	readStream.pipe(encrypt);

	let response = await b2.startLargeFile({
		bucketId,
		"fileName": file.fileName,
		"fileInfo": {
			[LAST_MODIFIED_KEY]: file.stat.mtimeMs
		}
	});

	if (!response.data.fileId) {
		console.error(`Did not get a file ID uploading large file ${file.fileName}`);
		process.exit(5);
	}

	let fileId = response.data.fileId;
	response = await b2.getUploadPartUrl({fileId});
	if (!response.data || !response.data.uploadUrl || !response.data.authorizationToken) {
		console.error(`Did not get upload URL for uploading large file ${file.fileName}`);
		process.exit(5);
	}

	let uploadUrl = response.data.uploadUrl;
	let uploadAuthToken = response.data.authorizationToken;
	let partNumber = 1;
	let bytesUploaded = 0; // this won't be exact because we're counting encrypted bytes, but it's close enough

	let ended = false;
	encrypt.on('end', () => ended = true);
	while (!ended) {
		if (process.stdout.isTTY) {
			let pct = Math.round((bytesUploaded / file.stat.size) * 100);
			process.stdout.clearLine(0);
			process.stdout.write(`\rUploading large file ${file.fileName}... ${pct}% `);
		}

		let data = await getNextChunk();
		response = await b2.uploadPart({
			partNumber,
			uploadUrl,
			uploadAuthToken,
			data
		});

		partNumber++;
		bytesUploaded += data.length;
	}

	if (process.stdout.isTTY) {
		process.stdout.clearLine(0);
		process.stdout.write("\r");
	}

	console.log(`Uploading large file ${file.fileName}... complete`);

	async function getNextChunk() {
		let chunk = encrypt.read(chunkSize);
		if (chunk !== null) {
			return chunk;
		} else {
			await new Promise(resolve => setTimeout(resolve, 500));
			return await getNextChunk();
		}
	}
}

async function hideRemoteFile(file) {
	console.log(`Hiding missing remote file ${file.fileName}`);
	await b2.hideFile({
		"bucketId": file.bucketId,
		"fileName": file.fileName
	});
}

async function getUploadUrl(bucketId) {
	if (g_UploadUrl) {
		return g_UploadUrl;
	}

	let response = await b2.getUploadUrl(bucketId);
	if (!response.data || !response.data.uploadUrl || !response.data.authorizationToken) {
		throw new Error('Malformed response when getting upload URL');
	}

	g_UploadUrl = {"uploadUrl": response.data.uploadUrl, "uploadAuthToken": response.data.authorizationToken};
	return g_UploadUrl;
}
