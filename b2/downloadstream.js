const Crypto = require('crypto');
const Stream = require('stream');

class B2DownloadStream extends Stream.Transform {
	/**
	 * @param {string} expectedHash
	 * @param {function} [onDownloadProgress]
	 * @param {object} [options]
	 */
	constructor(expectedHash, onDownloadProgress, options) {
		if (typeof onDownloadProgress == 'object') {
			options = onDownloadProgress;
			onDownloadProgress = null;
		}

		super(options);

		this.processedBytes = 0;
		this._hash = Crypto.createHash('sha1');
		this._expectedHash = expectedHash.toLowerCase();
		this._onUploadProgress = onDownloadProgress || (() => {});
		this._progressInterval = setInterval(() => {
			this._onUploadProgress({
				processedBytes: this.processedBytes,
				ended: false
			});
		}, 500);
	}

	_transform(chunk, encoding, callback) {
		this.processedBytes += chunk.length;
		this._hash.update(chunk, encoding);
		this.push(chunk);
		callback();
	}

	_flush(callback) {
		let fileHash = this._hash.digest('hex').toLowerCase();
		if (this._expectedHash && this._expectedHash.length == fileHash.length && this._expectedHash != fileHash) {
			this.destroy(new Error('Hash mismatch'));
			return;
		}

		callback();

		clearInterval(this._progressInterval);
		this._onUploadProgress({
			processedBytes: this.processedBytes,
			ended: true
		});
	}
}

module.exports = B2DownloadStream;
