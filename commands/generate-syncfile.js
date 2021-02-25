const FS = require('fs');
const ReadLine = require('readline');

const generateKeypair = require('../components/generateKeypair.js');
let keypair = generateKeypair();

(async function() {
	let questions = [
		{
			jsonKey: 'local.directory',
			prompt: 'Local directory to back up',
		},
		{
			jsonKey: 'remote.bucket',
			prompt: 'Remote B2 bucket name'
		},
		{
			jsonKey: 'remote.prefix',
			prompt: 'Prefix for B2 filenames (optional)',
			optional: true
		},
		{
			jsonKey: 'keyId',
			prompt: 'Backblaze key ID',
			hint: 'Make sure this key has access to the "{remote.prefix}" prefix in the "{remote.bucket}" bucket.'
		},
		{
			jsonKey: 'applicationKey',
			prompt: 'Backblaze application key'
		},
		{
			internalKey: 'privateKeyFilePath',
			prompt: 'Output file path for private key'
		},
		{
			internalKey: 'syncfileFilePath',
			prompt: 'Output file path for syncfile'
		}
	];
	
	let rl = ReadLine.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	
	let syncfileJson = {};
	let answers = {};
	
	for (let i = 0; i < questions.length; i++) {
		await new Promise(function exec(resolve) {
			let q = questions[i];
			rl.question(q.prompt + ': ', (answer) => {
				if (!answer && !q.optional) {
					return exec(resolve);
				}
				
				answers[q.internalKey || q.jsonKey] = answer;
				if (q.jsonKey) {
					let parts = q.jsonKey.split('.');
					let obj = syncfileJson;
					for (let j = 0; j < parts.length; j++) {
						if (j < parts.length - 1) {
							// Create intermediate objects as necessary
							obj[parts[j]] = obj[parts[j]] || {};
							obj = obj[parts[j]];
						} else {
							obj[parts[j]] = answer;
						}
					}
				}
				
				resolve();
			});
		});
	}
	
	rl.close();
	
	syncfileJson.encryptionKey = {publicKey: keypair.publicKey};
	FS.writeFileSync(answers.privateKeyFilePath, keypair.privateKey);
	console.log(`Private key written to ${answers.privateKeyFilePath}`);
	FS.writeFileSync(answers.syncfileFilePath, JSON.stringify(syncfileJson, undefined, '\t'));
	console.log(`Syncfile written to ${answers.syncfileFilePath}`);
})();
