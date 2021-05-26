# B2ENS

*B2 Encrypt-n-Sync*

This is a utility that is designed to back up (synchronize) a local directory to a [Backblaze B2](https://www.backblaze.com)
bucket, encrypting the files along the way.

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

$ b2ens generate-syncfile
    Interactively guides you through creating a syncfile

$ b2ens encrypt-file <path to public or private key> <input file path> [output file path]

$ b2ens decrypt-file <path to private key> <input file path> [output file path] 

$ b2ens decrypt-folder <path to private key> <input folder path> <output folder path>
```

# Syncfiles

A *syncfile* is a JSON file containing the configuration for a sync. It should look like this:

```json
{
	"local": {
		"directory": "/path/to/directory/to/backup",
		"exclude": ["/optional/array", "/of/files/or/directories", "/to/exclude"]
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
	- `exclude` - An optional array of files and/or directories to exclude
		- For example, if you are backing up `/var/www/html`, then you would set `local.directory` = `/var/www/html`
		- If you wanted to exclude `/var/www/html/some-dir` and `/var/www/html/some-file`, then you would set `local.exclude` to `["/var/www/html/some-dir", "/var/www/html/some-file"]`
		- As of v1.5.0, it is possible to use wildcards in exclusions
			- To signal that an exclusion contains wildcards, prefix it with `!`
			- `*` is interpreted as zero or more characters, excluding slashes
			- `**` is interpreted as zero or more characters, including slashes
			- If you want to exclude an entire directory and all its subdirectories, you should end your string with `/**`
			- Examples:
				- `!/var/www/html/some-dir/**` will match all files and subdirectories in `/var/www/html/some-dir`
				- `!/var/www/html/users/*/some-file` will match all files by name `some-file` contained within all directories in `/var/www/html/users`
				- `!/var/www/html/users/*/some-dir/**` will match all files and subdirectories in the `some-dir` directory contained within all directories in `/var/www/html/users`
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

Files under 100 MB are streamed from disk, encrypted as a stream, and uploaded in a single part.
Files larger than 100 MB will be uploaded in chunks at most 50 MB in size.
**Please note:** Due to the nature of multi-threaded encrypted uploads, each chunk in a large file must be loaded into
memory prior to being uploaded. Therefore, a large-file upload will consume at least `uploadThreads` × 50 MB. Please
take this into consideration on a device with limited RAM (e.g. a Raspberry Pi).

# Decryption

There is no functionality implemented in B2ENS to download and decrypt files. You will need to download either an
individual file or some number of files and use either `decrypt-file` or `decrypt-folder` to decrypt them.

If you wanted to decrypt an entire bucket, you might want to either
[create and download a bucket snapshot](https://help.backblaze.com/hc/en-us/articles/115002731014-Snapshot-information)
or use the [B2 command line tool](https://www.backblaze.com/b2/docs/quick_command_line.html) to download your bucket
contents. Once downloaded, you can use the `decrypt-folder` command to decrypt the entire bucket's contents.

**Please note that the `decrypt-folder` command will delete input files after they are successfully decrypted to the
output folder.** This is to prevent it being necessary to have enough free disk space to hold two copies of the files.
Additionally, this makes it apparent if any files were unable to be decrypted, since they will be all that's left in
the input folder after the process completes.
