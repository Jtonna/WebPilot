'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SIZE = 1073741824; // 1 GB

class SizeManagedWriter {
  constructor(logPath) {
    this.logPath = logPath;
    // Truncate on startup (fresh each run)
    fs.writeFileSync(logPath, '', 'utf8');
    this.stream = fs.createWriteStream(logPath, { flags: 'a' });
    this.bytesWritten = 0;
  }

  write(data) {
    const str = typeof data === 'string' ? data : data.toString();
    // Strip ANSI escape codes so the log file is plain text
    const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
    const bytes = Buffer.byteLength(clean, 'utf8');
    this.stream.write(clean);
    this.bytesWritten += bytes;

    if (this.bytesWritten >= MAX_SIZE) {
      this._rotate();
    }
  }

  _rotate() {
    try {
      // Close current stream
      this.stream.end();

      // Read file, drop oldest 25%
      const content = fs.readFileSync(this.logPath, 'utf8');
      const quarter = Math.floor(content.length / 4);

      // Find next newline after 25% mark
      let cutIndex = content.indexOf('\n', quarter);
      if (cutIndex === -1) cutIndex = quarter;
      else cutIndex += 1; // include the newline

      const retained = content.slice(cutIndex);

      // Write retained to tmp, then replace
      const tmpPath = this.logPath + '.tmp';
      fs.writeFileSync(tmpPath, retained, 'utf8');
      fs.renameSync(tmpPath, this.logPath);

      // Reopen stream
      this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.bytesWritten = Buffer.byteLength(retained, 'utf8');
    } catch (e) {
      // If rotation fails, just reset counter to avoid infinite loop
      this.bytesWritten = 0;
    }
  }

  close() {
    try { this.stream.end(); } catch (e) { /* non-fatal */ }
  }
}

function initDaemonLog(logPath) {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  return new SizeManagedWriter(logPath);
}

function setupLogging(logPath) {
  const writer = initDaemonLog(logPath);

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, callback) => {
    writer.write(chunk);
    return origStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    writer.write(chunk);
    return origStderrWrite(chunk, encoding, callback);
  };

  return writer;
}

module.exports = { SizeManagedWriter, initDaemonLog, setupLogging };
