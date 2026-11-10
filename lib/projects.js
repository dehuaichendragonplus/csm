'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG_FILENAME, loadConfig } = require('./config');

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
function generateConfig(dir, filelistPath) {
  const configPath = path.join(dir, CONFIG_FILENAME);
  const cfg = {
    title: path.basename(dir),
    filelist: path.relative(dir, filelistPath).split(path.sep).join('/'),
    allowUpload: true,
    actions: []
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return configPath;
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

  let configPath = path.join(dir, CONFIG_FILENAME);
  let generated = false;
  if (!fs.existsSync(configPath)) {
    const filelist = detectFilelist(dir);
    if (!filelist) {
      throw new Error(`该目录下没有 ${CONFIG_FILENAME}，也没找到 filelist.json（已查找: ${FILELIST_CANDIDATES.join('、')}）`);
    }
    configPath = generateConfig(dir, filelist);
    generated = true;
  }
  const cfg = loadConfig(configPath); // 校验配置合法，不合法直接抛错、不入库
  const name = (nameInput || '').trim() || cfg.title;
  const project = { id: makeId(dir), name, dir };
  projects.push(project);
  saveProjects(registryPath, projects);
  return { project, generated };
}

function removeProject(registryPath, id) {
  const projects = loadProjects(registryPath);
  const next = projects.filter(p => p.id !== id);
  if (next.length === projects.length) return false;
  saveProjects(registryPath, next);
  return true;
}

function renameProject(registryPath, id, nameInput) {
  const name = (nameInput || '').trim();
  if (!name) throw new Error('项目名不能为空');
  const projects = loadProjects(registryPath);
  const p = projects.find(x => x.id === id);
  if (!p) return null;
  p.name = name;
  saveProjects(registryPath, projects);
  return p;
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

module.exports = { loadProjects, saveProjects, addProject, removeProject, renameProject, moveProject, findProject, detectFilelist, makeId };
