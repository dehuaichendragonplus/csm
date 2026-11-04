'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadSidecar(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return {};
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function saveSidecar(sidecarPath, data) {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const sorted = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key];
  fs.writeFileSync(sidecarPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

function updateSidecar(sidecarPath, key, modifiedTime) {
  const sidecar = loadSidecar(sidecarPath);
  sidecar[key] = modifiedTime;
  saveSidecar(sidecarPath, sidecar);
  return sidecar;
}

module.exports = { loadSidecar, saveSidecar, updateSidecar };
