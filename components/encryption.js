const Crypto = require('crypto');
const Stream = require('stream');

const CIPHER_ALGO = 'aes-256-ctr';
const HMAC_ALGO = 'sha1';
const HMAC_LENGTH = 20;

/**
 * Return a stream that can be used to encrypt a stream.
 * @param {string} publicKey - The RSA public key we're using to encrypt the stream
 * @param {object} [options]
 * @returns {EncryptStream}
 */
exports.createEncryptStream = function(publicKey, options) {
	return new EncryptStream(publicKey, options);
};

/**
 * Return a stream that can be used to decrypt a stream.
 * CAUTION: The returned stream may emit an error event if the encrypted stream is malformed in some way.
 * @param {string} privateKey - The RSA private key we're using to decrypt the stream
 * @param {object} [options]
 * @returns {DecryptStream}
 */
exports.createDecryptStream = function(privateKey, options) {
	return new DecryptStream(privateKey, options);
};

class EncryptStream extends Stream.Transform {
	constructor(publicKey, options) {
		super(options);

		this.processedBytes = 0;

		let header = Buffer.alloc(3);
		let keyAndIv = Crypto.randomBytes(32 + 16);
		let encryptedKey = Crypto.publicEncrypt(publicKey, keyAndIv);

		header.writeUInt8(1, 0); // version
		header.writeUInt16LE(encryptedKey.length, 1);

		this.push(Buffer.concat([header, encryptedKey]));

		let key = keyAndIv.slice(0, 32);
		let iv = keyAndIv.slice(32);

		this._cipher = Crypto.createCipheriv(CIPHER_ALGO, key, iv);
		this._hmac = Crypto.createHmac(HMAC_ALGO, key.slice(0, 16));

		this._hmac.update(encryptedKey);
	}

	_transform(chunk, encoding, callback) {
		this.processedBytes += chunk.length;
		let encoded = this._cipher.update(chunk, encoding);
		if (encoded && encoded.length > 0) {
			this._hmac.update(encoded);
			this.push(encoded);
		}
		callback();
	}

	_flush(callback) {
		let encoded = this._cipher.final();
		if (encoded && encoded.length > 0) {
			this._hmac.update(encoded);
			this.push(encoded);
		}

		let mac = this._hmac.digest();
		this.push(mac);
		callback();
	}
}

class DecryptStream extends Stream.Transform {
	constructor(privateKey, options) {
		super(options);

		this.processedBytes = 0;

		this._privateKey = privateKey;
		this._headerBuffer = Buffer.alloc(0);
		this._buffer = new BufferList();
	}

	_transform(chunk, encoding, callback) {
		if (!Buffer.isBuffer(chunk)) {
			chunk = Buffer.from(chunk, encoding);
		}

		if (!this._version || !this._decipher) {
			// We still need our version
			this._headerBuffer = Buffer.concat([this._headerBuffer, chunk]);
		}

		if (!this._version) {
			if (this._headerBuffer.length < 1) {
				// Version data isn't available yet
				callback();
				return;
			}

			this._version = this._headerBuffer.readUInt8(0);
			if (this._version != 1) {
				this.destroy(new Error('Unexpected version ' + this._version));
				return;
			}

			this._headerBuffer = this._headerBuffer.slice(1);
		}

		if (!this._decipher) {
			// We still need our symmetric key
			if (this._headerBuffer.length < 2) {
				// Key length isn't available yet
				callback();
				return;
			}

			let keyLength = this._headerBuffer.readUInt16LE(0);
			if (this._headerBuffer.length < 2 + keyLength) {
				// The encrypted key isn't available yet
				callback();
				return;
			}

			// We have the encrypted key
			let encryptedKey = this._headerBuffer.slice(2, 2 + keyLength);
			this._headerBuffer = this._headerBuffer.slice(2 + keyLength);
			let keyAndIv = Crypto.privateDecrypt(this._privateKey, encryptedKey);
			delete this._privateKey;

			if (keyAndIv.length != 32 + 16) {
				this.destroy(new Error('Key + IV are not the expected length'));
				return;
			}

			let key = keyAndIv.slice(0, 32);
			let iv = keyAndIv.slice(32);

			this._decipher = Crypto.createDecipheriv(CIPHER_ALGO, key, iv);
			this._hmac = Crypto.createHmac(HMAC_ALGO, key.slice(0, 16));

			this._hmac.update(encryptedKey);
			chunk = this._headerBuffer;
			delete this._headerBuffer;
		}

		if (chunk.length == 0) {
			callback();
			return;
		}

		// We have our decipher and hmac, so we can now process this chunk via the buffer. We don't want to blindly
		// process all data that comes in, because the last 20 bytes are our HMAC and we want to catch that.
		this._buffer.push(chunk);
		this._buffer.flush().forEach(buf => this._processBuffer(buf));
		callback();
	}

	_flush(callback) {
		let flushed = this._buffer.flushFinal();
		if (flushed.data && flushed.data.length > 0) {
			this._processBuffer(flushed.data);
		}

		let mac = this._hmac.digest();
		if (!mac.equals(flushed.hmac)) {
			this.destroy(new Error('HMAC does not validate'));
		}

		callback(); // everything is done
	}

	_processBuffer(buf) {
		this.processedBytes += buf.length;
		let decoded = this._decipher.update(buf);
		if (decoded && decoded.length > 0) {
			this.push(decoded);
		}
		this._hmac.update(buf);
	}
}

class BufferList {
	constructor() {
		this._head = null;
		this._tail = null;
	}

	push(data) {
		let node = {data, "next": null};
		if (this._tail) {
			this._tail.next = node;
		}

		this._tail = node;
		if (!this._head) {
			this._head = node;
		}
	}

	getTotalBytes() {
		let bytes = 0;
		for (let node = this._head; node; node = node.next) {
			bytes += node.data.length;
		}
		return bytes;
	}

	flush() {
		// We want to flush all but the last 20 bytes
		let output = [];
		let totalBytes = this.getTotalBytes();
		while (this._head && totalBytes - this._head.data.length >= HMAC_LENGTH) {
			totalBytes -= this._head.data.length;
			output.push(this._head.data);
			this._head = this._head.next;
		}
		return output;
	}

	flushFinal() {
		let buffers = [];
		for (let node = this._head; node; node = node.next) {
			buffers.push(node.data);
		}
		let buf = Buffer.concat(buffers);
		return {
			"data": buf.slice(0, buf.length - 20),
			"hmac": buf.slice(buf.length - 20)
		};
	}
}
