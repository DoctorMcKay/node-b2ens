const FS = require('fs');

let publicKeyOutputFile = process.argv[3];
let privateKeyOutputFile = process.argv[4];
if (!publicKeyOutputFile || !privateKeyOutputFile) {
	process.stderr.write("Usage: b2ens generate-keypair <public key output file path> <private key output file path>\n");
	process.exit(2);
}

const generateKeypair = require('../components/generateKeypair.js');
let keypair = generateKeypair();

FS.writeFileSync(publicKeyOutputFile, keypair.publicKey);
console.log(`Public key written to ${publicKeyOutputFile}`);
FS.writeFileSync(privateKeyOutputFile, keypair.privateKey);
console.log(`Private key written to ${privateKeyOutputFile}`);
