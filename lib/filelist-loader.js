'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadFilelist(filelistPath) {
  if (!fs.existsSync(filelistPath)) {
    throw new Error(`filelist not found: ${filelistPath}`);
  }
  const raw = fs.readFileSync(filelistPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in filelist: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('filelist must be a JSON array');
  }
  const baseDir = path.dirname(path.resolve(filelistPath));
  return parsed.map(entry => {
    const enriched = {
      ...entry,
      savePath: path.resolve(baseDir, entry.path)
    };
    if (!entry.spreadsheetId || String(entry.spreadsheetId).trim() === '') {
      enriched.incomplete = true;
      enriched.incompleteReason = 'spreadsheetId is empty';
    }
    return enriched;
  });
}

module.exports = { loadFilelist };
