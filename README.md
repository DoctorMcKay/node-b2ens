# B2ENS

*B2 Encrypt-n-Sync*

This is a utility that is designed to back up (synchronize) a local directory to a [Backblaze B2](https://www.backblaze.com)
bucket, encrypting the files along the way.

**This is a work-in-progress.**

# Sync Rules

The application compares the local directory and the remote bucket, and for each file:

- If the file exists locally but not remotely, uploads it
- If the file exists remotely but not locally, hides it on B2
- If the file exists both locally and remotely but the modification times are different, uploads the local copy and overwrites the remote copy
	- **Note:** It will still upload the local copy even if the remote modification time is newer!
	
Local files will **never** be modified. This tool is intended to allow you to backup a local directory to Backblaze B2,
not to use B2 as a sort of Dropbox.

B2ENS assumes it has exclusive control over the bucket you configure it to use. If you upload files without using B2ENS,
they will be hidden (deleted) the next time B2ENS runs. 

# Usage

Install it from npm by running `npm install -g b2ens` in an administrator command prompt (on Windows) or as root (on Linux).

Use it by running `b2ens <command>` on the command line. Available commands:

```
$ b2ens sync <path to syncfile>
    See "Syncfiles" section below

$ b2ens generate-keypair <public key output file path> <private key output file path>

$ b2ens encrypt-file <path to public or private key> <input file path> [output file path]

$ b2ens decrypt-file <path to private key> <input file path> [output file path] 
```

# Syncfiles

A *syncfile* is a JSON file containing the configuration for a sync. It should look like this:

```json
{
	"local": {
		"directory": "/path/to/directory/to/backup"
	},
	"remote": {
		"bucket": "name-of-bucket",
		"prefix": "somefolder/"
	},
	"keyId": "backblaze key id",
	"applicationKey": "backblaze application key",
	"encryptionKey": {
		"publicKeyPath": "/path/to/pem/encoded/rsa/key",
		"publicKey": "-----BEGIN PUBLIC KEY-----\nblahblah\n-----END PUBLIC KEY-----"
	}
}
```

- `local`
	- `directory` - The local directory to be backed up to Backblaze
- `remote`
	- `bucket` - The name of the bucket (not the bucket ID) you want to back up to
	- `prefix` - If you want your backup root in the remote bucket to be in a folder, put the full path to the folder relative to the bucket root here. No leading slash, trailing slash required. Example: "somefolder/" or "some/folder/". If you omit the trailing slash, then all files will be uploaded to the bucket root, but with this value prefixed to their filenames. For example, a prefix of "foo" will cause a file named "test.txt" to be uploaded as "footest.txt".
- `keyId` - The key ID you want to use to authenticate with Backblaze. For security reasons, this should be an application key that can only access your one bucket.
- `applicationKey` - The Backblaze application key
- `uploadThreads` - The number of threads to use when uploading large files (default 5). Lower this if you're having network issues.
- `encryptionKey` - You only need to specify **one** of the following
	- `publicKeyPath` - The path to a PEM-encoded file contaning an RSA public key
	- `publicKey` - A PEM-encoded RSA public key

# Encryption

Each file is encrypted using `AES-256-CTR` with a per-file key. The symmetric key is RSA-encrypted and stored in the
uploaded file alongside the encrypted data. The final 20 bytes of each uploaded file are a HMAC.

Files under 10 MB in size are encrypted in memory and then uploaded whole. Files larger than 10 MB are encrypted as a
stream and uploaded in chunks at least 5 MB in size.

Currently it is not possible to decrypt files. That's expected to be added in a future release. The code is already
written, there just isn't a way to invoke it yet.
