const StdLib = require('@doctormckay/stdlib');
const {readFileSync, createWriteStream} = require('fs');
const FS = require('fs').promises;
const Path = require('path');
const Stream = require('stream');
const yargs = require('yargs');
const {hideBin} = require('yargs/helpers');

const B2 = require('../b2/client');
const B2DownloadStream = require('../b2/downloadstream');
const Encryption = require('../components/encryption');

const debugLog = require('../components/logging');

const MAX_CONCURRENT_DOWNLOADS = 10;

const {argv} = yargs(hideBin(process.argv))
	.command('download', 'Download and decrypt files from the B2 bucket', (yargs) => {
		return yargs
			.option('dir', {
				describe: 'Remote directory to download. Omit to download everything'
			})
			.option('output', {
				alias: 'o',
				describe: 'Path to output directory on local disk',
				demandOption: true
			})
			.option('syncfile', {
				alias: 's',
				describe: 'Optional path to syncfile. If provided, you don\'t need to separately pass --bucket, --key-id, or --app-key'
			})
			.option('bucket', {
				alias: 'b',
				describe: 'name of bucket to download files from'
			})
			.option('key-id', {
				describe: 'B2 key ID to use to access your bucket'
			})
			.option('app-key', {
				describe: 'B2 application key to use to access your bucket'
			})
			.option('private-key', {
				describe: 'Path to PEM-encoded private key used to decrypt files',
				demandOption: true
			});
	})
	.help();

if (!argv.syncfile && !(argv.bucket && argv.keyId && argv.appKey)) {
	console.error('You must specify either --syncfile or all of --bucket, --key-id, --app-key.');
	console.error('For help, see: b2ens download --help');
	process.exit(1);
}

// Make sure we can read the private key
let g_PrivateKeyPem = readFileSync(argv.privateKey).toString('utf8').trim();
if (!g_PrivateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')) {
	console.error('Error: Specified --private-key file does not appear to contain a PEM-encoded private key.');
	process.exit(2);
}

let g_ProgressDetails = {
	bytesReceived: 0,
	filesReceived: 0,
	totalBytes: 0,
	totalFiles: 0,
	activeDownloads: 0,
	lastRollingByteCount: 0,
	rollingByteCounts: []
};
let g_ConsoleLogLines = [];
let g_ConsoleInDynamicMode = false;

let g_BucketName = argv.bucket;
let g_Bucket = null;
let g_KeyId = argv.keyId;
let g_AppKey = argv.appKey;
let g_DownloadPrefix = argv.dir || '';

let g_BucketFiles = {};
let g_DirModTimes = {};
let g_DownloadQueue = new StdLib.DataStructures.AsyncQueue(processDownload, MAX_CONCURRENT_DOWNLOADS);

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
		g_ProgressDetails.rollingByteCounts.push(g_ProgressDetails.bytesReceived);
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

	let etaSeconds = Math.max(0, Math.round((g_ProgressDetails.totalBytes - g_ProgressDetails.bytesReceived) / averageSpeed));
	let etaHours = Math.floor(etaSeconds / (60 * 60));
	etaSeconds -= etaHours * 60 * 60;
	let etaMinutes = Math.floor(etaSeconds / 60);
	etaSeconds -= etaMinutes * 60;

	let infoTags = [
		`${g_ProgressDetails.activeDownloads.toString().padStart(2, ' ')} cxns`,
		`${g_ProgressDetails.filesReceived}/${g_ProgressDetails.totalFiles} files`,
		`${StdLib.Units.humanReadableBytes(g_ProgressDetails.bytesReceived, false, true)}/${StdLib.Units.humanReadableBytes(g_ProgressDetails.totalBytes)}`,
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
		Math.min(g_ProgressDetails.bytesReceived, g_ProgressDetails.totalBytes),
		g_ProgressDetails.totalBytes,
		process.stdout.columns - progressLine.length - 2,
		true
	);
	progressLine += ' ' + progressBar + ' ';

	process.stdout.write(progressLine);
}

// Here starts code

if (argv.syncfile) {
	log(`Reading bucket name, key ID, and app key from syncfile "${argv.syncfile}"`);
	let syncFile = JSON.parse(readFileSync(argv.syncfile).toString('utf8'));

	if (!syncFile.remote || !syncFile.remote.bucket || !syncFile.keyId || !syncFile.applicationKey) {
		console.error('Error: Provided syncfile is malformed or corrupt');
		process.exit(3);
	}

	g_BucketName = syncFile.remote.bucket;
	g_KeyId = syncFile.keyId || syncFile.accountId;
	g_AppKey = syncFile.applicationKey || syncFile.appKey;
	g_DownloadPrefix = g_DownloadPrefix || syncFile.remote.prefix || '';
}

let b2 = new B2(g_KeyId, g_AppKey, !!argv.debug);
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
	await b2.authorize();
	log(`Authorized with B2 account ${b2.authorization.accountId}; using API URL ${b2.authorization.apiUrl}`);

	try {
		g_Bucket = await b2.getBuckets({bucketName: g_BucketName});
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
	let prefixMsg = g_DownloadPrefix.length == 0 ? 'all files' : `files starting with "${g_DownloadPrefix}"`;
	log(`Downloading remote ${prefixMsg} from bucket with remote bucket ${g_Bucket.bucketName} (${g_Bucket.bucketId})`);

	log('Listing files in bucket...');

	let options = {};
	if (g_DownloadPrefix && g_DownloadPrefix.length > 0) {
		options.prefix = g_DownloadPrefix;
	}

	let {files} = await b2.listAllFileNames(g_Bucket.bucketId, options);
	g_BucketFiles = {};
	files.forEach((file) => {
		if (file.action != 'upload') {
			// this isn't a regular file, so ignore it
			return;
		}

		if (g_DownloadPrefix) {
			file.fileName = file.fileName.replace(g_DownloadPrefix, ''); // replaces the first occurrence only
		}

		if (file.fileName[0] == '/') {
			file.fileName = file.fileName.substring(1); // remove any leading slash
		}

		g_BucketFiles[file.fileName] = file;
	});

	if (Object.keys(g_BucketFiles).length == 0) {
		log('Nothing to download');
		return;
	}

	log(`Found ${Object.keys(g_BucketFiles).length} remote files`);

	for (let i in g_BucketFiles) {
		g_ProgressDetails.totalFiles++;
		g_ProgressDetails.totalBytes += g_BucketFiles[i].contentLength;
		g_DownloadQueue.push(g_BucketFiles[i]);
	}

	// Start up our progress display interval
	let progressOutputInterval = null;
	if (process.stdout.isTTY) {
		flushLogLines();
		process.stdout.on('resize', flushLogLines);
		progressOutputInterval = setInterval(printProgressLine, 500);
		g_ConsoleInDynamicMode = true;
	}

	await new Promise((resolve) => g_DownloadQueue.drain = resolve);

	log(`Updating ${Object.keys(g_DirModTimes).length} directory modification times`);
	for (let i in g_DirModTimes) {
		await FS.utimes(i, ...g_DirModTimes[i]);
	}

	if (process.stdout.isTTY) {
		clearInterval(progressOutputInterval);
		g_ConsoleInDynamicMode = false;
		process.stdout.removeListener('resize', flushLogLines);

		// Clear the progress line
		process.stdout.cursorTo(0, process.stdout.rows - 1);
		process.stdout.clearLine(0);

		// Figure out where we need to move the cursor to
		process.stdout.cursorTo(0, getLogLinesForFlush().length);
	}
}

async function processDownload(file, callback, retryCount = 0) {
	log(`Download ${file.fileName}`);

	let observedProcessedBytes = 0;

	try {
		g_ProgressDetails.activeDownloads++;
		let response = await b2.downloadFileById(file.fileId);

		let dlStream = new B2DownloadStream(file.contentSha1, ({processedBytes}) => {
			g_ProgressDetails.bytesReceived += processedBytes - observedProcessedBytes;
			observedProcessedBytes = processedBytes;
		});

		let decrypt = Encryption.createDecryptStream(g_PrivateKeyPem);

		// Make sure the parent directory exists
		let diskFilePath = Path.join(argv.output, file.fileName);
		await fixDirMtime(await FS.mkdir(Path.resolve(diskFilePath, '..'), {recursive: true}), diskFilePath);
		let outputFile = createWriteStream(diskFilePath);

		await new Promise((resolve, reject) => {
			Stream.pipeline(
				response.stream,
				dlStream,
				decrypt,
				outputFile,
				(err) => {
					if (err) {
						// dl has failed
						g_ProgressDetails.bytesReceived -= observedProcessedBytes;
						reject(err);
					} else {
						// success
						resolve();
					}
				}
			);
		});

		// we're finished successfully
		// update the file's mtime if we have it from b2
		if (file.fileInfo && file.fileInfo.src_last_modified_millis) {
			await FS.utimes(diskFilePath, new Date(), new Date(parseInt(file.fileInfo.src_last_modified_millis)));
		}

		g_ProgressDetails.activeDownloads--;
		g_ProgressDetails.filesReceived++;
		callback();
	} catch (ex) {
		g_ProgressDetails.activeDownloads--;
		g_ProgressDetails.bytesReceived -= observedProcessedBytes;

		debugLog(`Downloading "${file.fileName}" failed: ${ex.message} (retry ${retryCount})`);

		try {
			await FS.unlink(Path.join(argv.output, file.fileName));
		} catch (ex) {
			// ignore
		}

		if (retryCount < 5) {
			return await processDownload(file, callback, retryCount + 1);
		} else {
			log(`Error: Download "${file.fileName}" failed: ${ex.message}`)
			callback(); // give up on this file
		}
	}
}

async function fixDirMtime(dir, file) {
	if (!dir) {
		return;
	}

	// dir is the topmost directory that was just created
	// file is the full path to the file that prompted this directory creation
	// so all directories from dir up to the parent of file are brand new

	let topDir = trimLeadingDirSep(Path.resolve(dir).replace(Path.resolve(argv.output), ''));

	// chop off the output base path
	let bottomDir = trimLeadingDirSep(Path.resolve(file, '..').replace(Path.resolve(argv.output), ''));
	let subDirs = trimLeadingDirSep(bottomDir.substring(topDir.length)).split(Path.sep);

	// insert a meaningless element to represent the top dir that was created
	subDirs.unshift('');

	let cumulativePath = topDir;
	for (let i = 0; i < subDirs.length; i++) {
		if (i > 0) {
			cumulativePath = Path.join(cumulativePath, subDirs[i]);
		}

		// figure out which files belong to this directory
		let filesInPath = Object.values(g_BucketFiles)
			.filter(f => f.action == 'upload' && Path.normalize(f.fileName).startsWith(cumulativePath) && f.fileInfo && f.fileInfo.src_last_modified_millis);

		if (filesInPath.length == 0) {
			// no files matched that have modification timestamps
			continue;
		}

		// get the latest modification time of any of those files
		let maxModTime = Math.max(...filesInPath.map(f => parseInt(f.fileInfo.src_last_modified_millis)));

		// now save it to set later. if we set it now, it'll be overwritten when we write files inside.
		g_DirModTimes[Path.resolve(argv.output, cumulativePath)] = [new Date(), new Date(maxModTime)];
	}
}

function trimLeadingDirSep(str) {
	while (str[0] == Path.sep) {
		str = str.substring(1);
	}

	return str;
}

function unNormalizePath(path) {
	// I am not proud of this.
	let regex;
	if (Path.sep == '\\') {
		regex = /\\/g;
	} else {
		regex = new RegExp(Path.sep, 'g');
	}

	return path.replace(regex, '/');
}
