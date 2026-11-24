'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG_FILENAME, loadConfig } = require('./config');
const { generateLegacyFilelist } = require('./legacy-import');

// 目录里没有 syncmanager.config.json 时，按这些位置自动寻找表格清单
const FILELIST_CANDIDATES = ['filelist.json', 'Input/filelist.json', 'input/filelist.json', 'Configs/Input/filelist.json'];

function loadProjects(registryPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveProjects(registryPath, projects) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(projects, null, 2) + '\n', 'utf8');
}

function makeId(dir) {
  const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `${slug}-${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 6)}`;
}

function detectFilelist(dir) {
  for (const rel of FILELIST_CANDIDATES) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

// 为只有 filelist.json 的目录生成最小配置（Drive 导出、无自定义动作），用户之后可自行补充
// Configs、Res 这类通用目录名不适合当项目名，往上找第一个有辨识度的目录名（如 SmashBlast1/Res/Configs → SmashBlast1）
const GENERIC_DIR_NAMES = new Set(['config', 'configs', 'input', 'inputs', 'res', 'resource', 'resources', 'data', 'datas',
  'table', 'tables', 'excel', 'excels', 'xlsx', 'sheet', 'sheets', 'assets']);
function guessTitle(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 4; i++) {
    const name = path.basename(d);
    if (!name) break;
    if (!GENERIC_DIR_NAMES.has(name.toLowerCase())) return name;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return path.basename(path.resolve(dir));
}

function generateConfig(dir, filelistPath) {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const cfg = {
    title: guessTitle(dir),
    filelist: path.relative(dir, filelistPath).split(path.sep).join('/'),
    allowUpload: true,
    actions: []
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return configPath;
}

/**
 * 确保目录里有可用的项目配置：
 * 1. 已有 syncmanager.config.json → 直接用
 * 2. 找到 filelist.json → 生成最小配置
 * 3. 老项目（只有本地 xlsx / 附近导表脚本里有表格链接）→ 生成 filelist.json + 最小配置
 */
function ensureConfig(dir) {
  const configPath = path.join(dir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) return { configPath, generated: false, legacy: null };
  const filelist = detectFilelist(dir);
  if (filelist) return { configPath: generateConfig(dir, filelist), generated: true, legacy: null };
  const legacy = generateLegacyFilelist(dir);
  if (!legacy) {
    throw new Error(`该目录下没有 ${CONFIG_FILENAME}、filelist.json，也没有任何 xlsx 配置表（已查找: ${FILELIST_CANDIDATES.join('、')}）`);
  }
  try {
    return {
      configPath: generateConfig(dir, legacy.filelistPath),
      generated: true,
      legacy: { mapped: legacy.mapped, unmapped: legacy.unmapped, tables: legacy.tables, sources: legacy.sources }
    };
  } catch (err) {
    try { fs.unlinkSync(legacy.filelistPath); } catch (_) { /* 尽量回滚 */ }
    throw err;
  }
}

/**
 * 添加项目：dir 为项目的「配置表目录」。
 * 已有 syncmanager.config.json 就直接用；否则尝试自动识别 filelist.json 并生成配置。
 */
function addProject(registryPath, dirInput, nameInput) {
  const dir = path.resolve(dirInput);
  let st;
  try { st = fs.statSync(dir); } catch (_) { throw new Error(`目录不存在: ${dir}`); }
  if (!st.isDirectory()) throw new Error(`不是目录: ${dir}`);

  const projects = loadProjects(registryPath);
  if (projects.some(p => p.dir === dir)) {
    const err = new Error('该目录已经添加过了');
    err.code = 'DUPLICATE';
    throw err;
  }

  const { configPath, generated, legacy } = ensureConfig(dir);
  const cfg = loadConfig(configPath); // 校验配置合法，不合法直接抛错、不入库
  const name = (nameInput || '').trim() || cfg.title;
  const project = { id: makeId(dir), name, dir };
  projects.push(project);
  saveProjects(registryPath, projects);
  return { project, generated, legacy };
}

function removeProject(registryPath, id) {
  const projects = loadProjects(registryPath);
  const next = projects.filter(p => p.id !== id);
  if (next.length === projects.length) return false;
  saveProjects(registryPath, next);
  return true;
}

function renameProject(registryPath, id, nameInput) {
  const res = updateProject(registryPath, id, { name: nameInput });
  return res ? res.project : null;
}

function updateProject(registryPath, id, updates = {}) {
  const projects = loadProjects(registryPath);
  const p = projects.find(x => x.id === id);
  if (!p) return null;

  let generated = false;
  let legacy = null;

  if (updates.dir !== undefined) {
    const dir = path.resolve(updates.dir);
    let st;
    try { st = fs.statSync(dir); } catch (_) { throw new Error(`目录不存在: ${dir}`); }
    if (!st.isDirectory()) throw new Error(`不是目录: ${dir}`);

    if (projects.some(other => other.id !== id && other.dir === dir)) {
      const err = new Error('该目录已经被其他项目使用了');
      err.code = 'DUPLICATE';
      throw err;
    }

    const ensured = ensureConfig(dir);
    generated = ensured.generated;
    legacy = ensured.legacy;
    loadConfig(ensured.configPath); // 校验配置合法，不合法直接抛错、不入库
    p.dir = dir;
  }

  if (updates.name !== undefined) {
    const name = updates.name.trim();
    if (!name) throw new Error('项目名不能为空');
    p.name = name;
  }

  saveProjects(registryPath, projects);
  return { project: p, generated, legacy };
}

function moveProject(registryPath, id, targetId, position) {
  const projects = loadProjects(registryPath);
  const from = projects.findIndex(p => p.id === id);
  const target = projects.findIndex(p => p.id === targetId);
  if (from < 0 || target < 0) return null;
  if (from === target) return projects;

  const to = target + (position === 'after' ? 1 : 0) - (from < target ? 1 : 0);
  if (from !== to) {
    const [project] = projects.splice(from, 1);
    projects.splice(to, 0, project);
    saveProjects(registryPath, projects);
  }
  return projects;
}

function findProject(registryPath, id) {
  return loadProjects(registryPath).find(p => p.id === id) || null;
}

module.exports = { guessTitle, loadProjects, saveProjects, addProject, removeProject, renameProject, updateProject, moveProject, findProject, detectFilelist, makeId };
