const Crypto = require('crypto');

module.exports = function() {
	if (!Crypto.generateKeyPairSync) {
		process.stderr.write("Error: Node.js 10.12.0 or later is required to generate a keypair.");
		process.exit(1);
	}
	
	return Crypto.generateKeyPairSync('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem'
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem'
		}
	});
};
