const Crypto = require('crypto');
const FS = require('fs');

if (!Crypto.generateKeyPairSync) {
	process.stderr.write("Error: Node.js 10.12.0 or later is required to generate a keypair.");
	process.exit(1);
}

let publicKeyOutputFile = process.argv[3];
let privateKeyOutputFile = process.argv[4];
if (!publicKeyOutputFile || !privateKeyOutputFile) {
	process.stderr.write("Usage: b2ens generate-keypair <public key output file path> <private key output file path>\n");
	process.exit(2);
}

let keypair = Crypto.generateKeyPairSync('rsa', {
	"modulusLength": 4096,
	"publicKeyEncoding": {
		"type": "spki",
		"format": "pem"
	},
	"privateKeyEncoding": {
		"type": "pkcs8",
		"format": "pem"
	}
});

FS.writeFileSync(publicKeyOutputFile, keypair.publicKey);
console.log(`Public key written to ${publicKeyOutputFile}`);
FS.writeFileSync(privateKeyOutputFile, keypair.privateKey);
console.log(`Private key written to ${privateKeyOutputFile}`);
