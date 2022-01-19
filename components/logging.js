const FS = require('fs');
const StdLib = require('@doctormckay/stdlib');

let g_LogFileFd = null;

if (process.env.B2ENS_DEBUG_LOG_FILE) {
	g_LogFileFd = FS.openSync(process.env.B2ENS_DEBUG_LOG_FILE, 'a');
	console.log(`Opened debug log file: ${process.env.B2ENS_DEBUG_LOG_FILE}`);
}

module.exports = function debugLog(msg) {
	if (g_LogFileFd) {
		FS.write(g_LogFileFd, StdLib.Time.timestampString() + ' - ' + msg + '\n', () => {});
	}
}
