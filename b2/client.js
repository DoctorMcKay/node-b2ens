const Crypto = require('crypto');
const HTTPS = require('https');
const Stream = require('stream');
const URL = require('url');
const QueryString = require('querystring');

const B2UploadStream = require('./uploadstream.js');

const B2_API_PATH = '/b2api/v2';

class B2 {
	constructor(appKeyId, appKey) {
		this._appKeyId = appKeyId;
		this._appKey = appKey;
		
		this.authorization = null;
	}
	
	async authorize() {
		let res = await this._req({
			method: 'POST',
			url: `https://api.backblazeb2.com${B2_API_PATH}/b2_authorize_account`,
			headers: {
				authorization: 'Basic ' + Buffer.from(this._appKeyId + ':' + this._appKey, 'utf8').toString('base64')
			},
			body: {}
		});
		
		['authorizationToken', 'apiUrl', 'downloadUrl'].forEach((field) => {
			if (!res.body[field]) {
				let err = new Error(`No ${field} in b2_authorize_account resposne`);
				err.res = res;
				throw err;
			}
		});
		
		this.authorization = res.body;
		this.authorization.time = Date.now();
	}
	
	async getUploadDetails(bucketId) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_get_upload_url',
			body: {
				bucketId
			}
		});
		
		return res.body;
	}
	
	/**
	 *
	 * @param {object} uploadDetails - Should be the full object returned by getUploadDetails
	 * @param {{filename: string, contentLength: int, contentType?: string, b2Info?: object}} fileDetails
	 * @param {string|Buffer|Stream.Readable} file
	 * @param {function} [onUploadProgress]
	 * @returns {Promise<void>}
	 */
	async uploadFile(uploadDetails, fileDetails, file, onUploadProgress) {
		let sha1 = 'hex_digits_at_end';
		
		// For some reason B2 doesn't like having hex_digits_at_end for small files.
		// If this file is small (<= 1 MB), go ahead and load it all into memory and just hash it now.
		if (fileDetails.contentLength <= 1000000) {
			file = await new Promise((resolve, reject) => {
				let buf = Buffer.alloc(fileDetails.contentLength);
				let offset = 0;
				file.on('data', (chunk) => {
					if (!Buffer.isBuffer(chunk)) {
						chunk = Buffer.from(chunk);
					}
					
					chunk.copy(buf, offset);
					offset += chunk.length;
				});
				
				file.on('end', () => resolve(buf));
				file.on('error', reject);
			});
		}
		
		if (!(file instanceof Stream.Readable)) {
			let hash = Crypto.createHash('sha1');
			hash.update(file);
			sha1 = hash.digest('hex');
		}
		
		let headers = {
			authorization: uploadDetails.authorizationToken,
			'x-bz-file-name': fileDetails.filename,
			'content-type': fileDetails.contentType || 'b2/x-auto',
			'content-length': fileDetails.contentLength + (sha1 == 'hex_digits_at_end' ? 40 : 0), // add 40 bytes for the hex-encoded sha1 trailer
			'x-bz-content-sha1': sha1
		};
		
		for (let i in (fileDetails.b2Info || {})) {
			headers['x-bz-info-' + i] = fileDetails.b2Info[i];
		}
		
		let res = await this._req({
			method: 'POST',
			url: uploadDetails.uploadUrl,
			headers,
			onUploadProgress,
			body: file
		});
		
		return res.body;
	}
	
	/**
	 * Returns the response as a stream, or parsed JSON.
	 * @param {{method?: string, url: string, headers?: object, qs?: object, onUploadProgress?: function, body?: string|object|Stream.Readable}} params
	 * @returns {Promise<Stream.Readable>}
	 * @private
	 */
	async _req(params) {
		return new Promise((resolve, reject) => {
			let headers = params.headers || {};
			
			// Encode JSON bodies
			if (!headers['content-type'] && params.body && typeof params.body == 'object' && !Buffer.isBuffer(params.body)) {
				headers['content-type'] = 'application/json';
				params.body = JSON.stringify(params.body);
			}
			
			// Add content-length if it's known
			if (typeof params.body == 'string') {
				headers['content-length'] = Buffer.byteLength(params.body);
			}
			
			// Encode query string
			if (params.qs && typeof params.qs == 'object') {
				params.url += (params.url.includes('?') ? '&' : '?') + QueryString.stringify(params.qs);
			}
			
			// Add auth header
			if (this.authorization && this.authorization.authorizationToken && !headers.authorization) {
				headers.authorization = this.authorization.authorizationToken;
			}
			
			let url = URL.parse(params.url);
			
			headers['user-agent'] = 'node-b2ens/' + require('../package.json').version;
			
			console.log({
				protocol: 'https:',
				method: params.method || 'GET',
				hostname: url.hostname,
				port: url.port,
				path: url.path,
				headers,
			});
			
			let req = HTTPS.request({
				protocol: 'https:',
				method: params.method || 'GET',
				hostname: url.hostname,
				port: url.port,
				path: url.path,
				headers,
			}, (res) => {
				if (res.headers['content-type'] && res.headers['content-type'].match(/^application\/json/i)) {
					let data = '';
					res.on('error', reject);
					res.on('data', chunk => data += chunk.toString('utf8'));
					res.on('end', async () => {
						if (res.statusCode > 300) {
							if (['bad_auth_token', 'expired_auth_token'].includes(data.code) && !url.path.match(/\/b2_upload_(file|part)/) && !params._authRetry) {
								// Our auth token is expired, so get a new one
								try {
									await this.authorize();
									return resolve(await this._req(Object.assign({_authRetry: true}, params)));
								} catch (ex) {
									return reject(ex);
								}
							}
							
							let err = new Error(data.message || `HTTP error ${res.statusCode}`);
							err.status = res.statusCode;
							err.headers = res.headers;
							err.body = data;
							return reject(err);
						}
						
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: JSON.parse(data)
						});
					});
				} else {
					if (res.statusCode >= 300) {
						let err = new Error(`HTTP error ${res.statusCode}`);
						err.status = res.statusCode;
						err.headers = res.headers;
						err.stream = res;
						
						return reject(err);
					}
					
					resolve({
						status: res.statusCode,
						headers: res.headers,
						stream: res
					});
				}
			});
			
			req.on('error', reject);
			
			if (params.body && params.body instanceof Stream.Readable) {
				let uploadStream = new B2UploadStream(params.onUploadProgress);
				Stream.pipeline(
					params.body,
					uploadStream,
					req,
					(err) => {
						if (err) {
							reject(err);
						}
					}
				);
			} else {
				req.end(params.body);
			}
		});
	}
}

module.exports = B2;
