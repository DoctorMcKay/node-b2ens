const Crypto = require('crypto');
const Stream = require('stream');

class B2UploadStream extends Stream.Transform {
	/**
	 * @param {function} [onUploadProgress]
	 * @param {object} [options]
	 */
	constructor(onUploadProgress, options) {
		if (typeof onUploadProgress == 'object') {
			options = onUploadProgress;
			onUploadProgress = null;
		}
		
		super(options);
		
		this.processedBytes = 0;
		this._hash = Crypto.createHash('sha1');
		this._onUploadProgress = onUploadProgress || (() => {});
		this._progressInterval = setInterval(() => {
			this._onUploadProgress({
				processedBytes: this.processedBytes,
				ended: false
			});
		}, 100);
	}
	
	_transform(chunk, encoding, callback) {
		this.processedBytes += chunk.length;
		this._hash.update(chunk, encoding);
		this.push(chunk);
		callback();
	}
	
	_flush(callback) {
		this.push(this._hash.digest('hex'), 'ascii');
		callback();

		clearInterval(this._progressInterval);
		this._onUploadProgress({
			processedBytes: this.processedBytes,
			ended: true
		});
	}
}

module.exports = B2UploadStream;
