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
	
	/**
	 * Authorize your account with B2. Once authorized, if your auth token expires the client will attempt
	 * to automatically reauth.
	 * @returns {Promise}
	 */
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
	
	/**
	 * List all buckets, or get info about a specific bucket.
	 * @param {{bucketId?: string, bucketName?: string, bucketTypes?: string[]}} [options]
	 * @returns {Promise<{buckets: [{accountId, bucketId, bucketName, bucketType, bucketInfo, corsRules, lifecycleRules, revision, options}]}>}
	 */
	async getBuckets(options) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_list_buckets',
			body: {
				accountId: this.authorization.accountId,
				...(options || {})
			}
		});
		
		return res.body;
	}
	
	/**
	 * Get parameters needed to upload a file. These parameters can be reused until an upload fails.
	 * If an upload fails, you need to get new upload details and try again.
	 * Each set of upload parameters can only be used by one thread at a time. For concurrent uploads, you
	 * need to retrieve multiple sets of upload details.
	 * @param {string} bucketId
	 * @returns {Promise}
	 */
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
	 * Upload a file.
	 * @param {object} uploadDetails - Should be the full object returned by getUploadDetails
	 * @param {{filename: string, contentLength: int, contentType?: string, b2Info?: object}} fileDetails
	 * @param {string|Buffer|Stream.Readable} file
	 * @param {function} [onUploadProgress]
	 * @returns {Promise<{accountId, action, bucketId, contentLength, contentSha1, contentMd5?, contentType, fileId, fileInfo, fileName, uploadTimestamp}>}
	 */
	async uploadFile(uploadDetails, fileDetails, file, onUploadProgress) {
		let headers = {
			authorization: uploadDetails.authorizationToken,
			'x-bz-file-name': fileDetails.filename,
			'content-type': fileDetails.contentType || 'b2/x-auto',
			'content-length': fileDetails.contentLength
		};
		
		for (let i in (fileDetails.b2Info || {})) {
			headers['x-bz-info-' + i] = fileDetails.b2Info[i];
		}
		
		return await this._uploadFileOrPart(uploadDetails.uploadUrl, headers, file, onUploadProgress);
	}
	
	/**
	 *
	 * @param {string} bucketId
	 * @param {{filename: string, contentType?: string, b2Info?: object}} fileDetails
	 * @returns {Promise<{accountId, action, bucketId, contentLength, contentSha1, contentMd5?, contentType, fileId, fileInfo, fileName, uploadTimestamp}>}
	 */
	async startLargeFile(bucketId, fileDetails) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_start_large_file',
			body: {
				bucketId,
				fileName: fileDetails.filename,
				contentType: fileDetails.contentType || 'b2/x-auto',
				fileInfo: fileDetails.b2Info || {}
			}
		});
		
		return res.body;
	}
	
	/**
	 * Finalize a large file for which you have uploaded all parts.
	 * @param {string} fileId
	 * @param {string[]} partSha1Array - Array of SHA1 hashes of uploaded parts, in order
	 * @returns {Promise<{accountId, action, bucketId, contentLength, contentSha1, contentMd5?, contentType, fileId, fileInfo, fileName, uploadTimestamp}>}
	 */
	async finishLargeFile(fileId, partSha1Array) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_finish_large_file',
			body: {
				fileId,
				partSha1Array
			}
		});
		
		return res.body;
	}
	
	/**
	 * Get parameters needed to upload a large file part. These parameters can be reused until an upload fails.
	 * If an upload fails, you need to get new upload details and try again.
	 * Each set of upload parameters can only be used by one thread at a time. For concurrent uploads, you
	 * need to retrieve multiple sets of upload details.
	 * @param {string} fileId
	 * @returns {Promise}
	 */
	async getLargeFilePartUploadDetails(fileId) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_get_upload_part_url',
			body: {
				fileId
			}
		});
		
		return res.body;
	}
	
	/**
	 *
	 * @param {object} uploadDetails - Should be the full object returned from getPartUploadDetails
	 * @param {{partNumber: int, contentLength: int}} partDetails
	 * @param {string|Buffer|Stream.Readable} part
	 * @param {function} [onUploadProgress]
	 * @returns {Promise<{fileId, partNumber, contentLength, contentSha1, contentMd5?, uploadTimestamp}>}
	 */
	async uploadLargeFilePart(uploadDetails, partDetails, part, onUploadProgress) {
		let headers = {
			authorization: uploadDetails.authorizationToken,
			'x-bz-part-number': partDetails.partNumber,
			'content-length': partDetails.contentLength
		};
		
		return await this._uploadFileOrPart(uploadDetails.uploadUrl, headers, part, onUploadProgress);
	}
	
	/**
	 * Returns a list of unfinished large files in a bucket.
	 * @param {string} bucketId
	 * @param {{namePrefix?: string, startFileId?: string, maxFileCount?: int}} [options]
	 * @returns {Promise<{files: array, nextFileId: string|null}>}
	 */
	async listUnfinishedLargeFiles(bucketId, options) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_list_unfinished_large_files',
			body: {
				bucketId,
				...(options || {}),
			}
		});
		
		return res.body;
	}
	
	/**
	 * Returns a list of all unfinished large files in a bucket.
	 * @param {string} bucketId
	 * @param {{namePrefix?: string, startFileId?: string, maxFileCount?: int}} [options]
	 * @returns {Promise<{files: *[]}>}
	 */
	async listAllUnfinishedLargeFiles(bucketId, options) {
		let opts = Object.assign({}, options);
		opts.maxFileCount = 100;
		return await this._listAll(this.listUnfinishedLargeFiles, bucketId, opts);
	}
	
	/**
	 * Cancel an unfinished large file upload.
	 * @param {string} fileId
	 * @returns {Promise<{fileId, accountId, bucketId, fileName}>}
	 */
	async cancelUnfinishedLargeFile(fileId) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_cancel_large_file',
			body: {
				fileId
			}
		});
		
		return res.body;
	}
	
	/**
	 *
	 * @param {string} url
	 * @param {object} headers
	 * @param {string|Buffer|Stream.Readable} file
	 * @param {function} [onUploadProgress]
	 * @returns {Promise}
	 * @private
	 */
	async _uploadFileOrPart(url, headers, file, onUploadProgress) {
		headers['x-bz-content-sha1'] = 'hex_digits_at_end';
		
		// For some reason B2 doesn't like having hex_digits_at_end for small files.
		// If this file is small (<= 1 MB), go ahead and load it all into memory and just hash it now.
		if (headers['content-length'] <= 1000000) {
			file = await new Promise((resolve, reject) => {
				let buf = Buffer.alloc(headers['content-length']);
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
		
		if (typeof file.pipe != 'function') {
			let hash = Crypto.createHash('sha1');
			hash.update(file);
			headers['x-bz-content-sha1'] = hash.digest('hex');
		} else {
			// We are uploading a stream, which wil go through B2UploadStream, so we need to add 40 bytes for the sha1 trailer
			headers['content-length'] += 40;
		}
		
		let res = await this._req({
			method: 'POST',
			url,
			headers,
			onUploadProgress,
			body: file
		});
		
		return res.body;
	}
	
	/**
	 * List files in bucket by name.
	 * @param {string} bucketId
	 * @param {{startFileName?: string, maxFileCount?: int, prefix?: string, delimiter?: string}} [options]
	 * @returns {Promise<{files: array, nextFileName: string|null}>}
	 */
	async listFileNames(bucketId, options) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_list_file_names',
			body: {
				bucketId,
				...(options || {})
			}
		});
		
		return res.body;
	}
	
	/**
	 * List all files in bucket by name.
	 * @param {string} bucketId
	 * @param {{startFileName?: string, maxFileCount?: int, prefix?: string, delimiter?: string}} [options]
	 * @returns {Promise<{files: array}>}
	 */
	async listAllFileNames(bucketId, options) {
		return await this._listAll(this.listFileNames, bucketId, options);
	}
	
	/**
	 * Hide a file.
	 * @param {string} bucketId
	 * @param {string} filename
	 * @returns {Promise<{fileId, partNumber, contentLength, contentSha1, contentMd5?, uploadTimestamp}>}
	 */
	async hideFile(bucketId, filename) {
		let res = await this._req({
			method: 'POST',
			url: this.authorization.apiUrl + B2_API_PATH + '/b2_hide_file',
			body: {
				bucketId,
				fileName: filename
			}
		});
		
		return res.body;
	}
	
	async _listAll(method, bucketId, options) {
		let opts = Object.assign({maxFileCount: 10000}, options);
		delete opts.startFileId;
		delete opts.startFileName;
		
		let files = [];
		let startKeyName;
		do {
			let res = await method.call(this, bucketId, opts);
			files = files.concat(res.files);
			let nextKeyName = Object.keys(res).find(key => key.startsWith('next'));
			startKeyName = nextKeyName.replace('next', 'start');
			opts[startKeyName] = res[nextKeyName];
		} while (opts[startKeyName]);
		
		return {files};
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
						try {
							data = JSON.parse(data);
						} catch (ex) {
							// invalid json I guess
						}
						
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
							
							let err = new Error(data.message || data.code || `HTTP error ${res.statusCode}`);
							err.requestUrl = params.url;
							err.status = res.statusCode;
							err.headers = res.headers;
							err.body = data;
							return reject(err);
						}
						
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: data
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
			
			if (params.body && typeof params.body == 'object' && typeof params.body.pipe == 'function') {
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
