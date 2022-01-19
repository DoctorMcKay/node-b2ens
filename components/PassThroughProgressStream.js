const Stream = require('stream');

const WRITE_CHUNK_SIZE = 1024; // Write 1 KB at a time to the stream until it fills up

class PassThroughProgressStream extends Stream.Transform {
	constructor(data, options) {
		super(options);
		this._data = data;
		this._offset = 0;

		this._doWrite();
		this.on('drain', () => this._doWrite());
	}

	_doWrite() {
		while (true) {
			if (this._offset >= this._data.length) {
				this.end();
				break;
			}

			let result = this.write(this._data.slice(this._offset, Math.min(this._offset + WRITE_CHUNK_SIZE, this._data.length)));
			this._offset += WRITE_CHUNK_SIZE;
			if (!result) {
				break;
			}
		}
	}

	_transform(chunk, encoding, callback) {
		this.push(chunk, encoding);
		setImmediate(callback);
	}
}

module.exports = PassThroughProgressStream;
