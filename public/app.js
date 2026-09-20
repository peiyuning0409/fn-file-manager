'use strict';

/* ===== 飞牛文件管理器 - 前端逻辑 ===== */

let TOKEN = localStorage.getItem('fnfm_token') || '';
let currentPath = '';       // 相对 ROOT 的路径
let entries = [];
let selectedPath = null;
let clipboard = null;
let searchMode = false;
let volumeNames = {};       // vol key -> 友好名
let viewMode = localStorage.getItem('fnfm_view') || 'list';
let filterType = 'all';
let navHistory = [];
let navIndex = -1;
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const $ = (id) => document.getElementById(id);

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
}
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}
async function api(path, opts = {}) {
  const headers = Object.assign({ 'X-Auth-Token': TOKEN }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { showLogin(); throw new Error('未授权'); }
  return res;
}

/* ---------- 文件类型判断 ---------- */
function getExt(name) { return (name.split('.').pop() || '').toLowerCase(); }
function isImage(name) { return ['png','jpg','jpeg','gif','webp','svg','bmp','ico','heic'].includes(getExt(name)); }
function isVideo(name) { return ['mp4','mkv','mov','avi','webm','flv','wmv','m4v','ts','m3u8'].includes(getExt(name)); }
function isAudio(name) { return ['mp3','wav','flac','m4a','aac','ogg','opus','wma'].includes(getExt(name)); }
function isPdf(name) { return getExt(name) === 'pdf'; }
function isText(name) {
  const ext = getExt(name);
  return ['txt','md','json','xml','yml','yaml','csv','log','js','ts','jsx','tsx','css','scss','html','htm','sh','py','go','rs','java','c','cpp','h','hpp','sql','conf','ini','env','properties','srt','vtt','ass'].includes(ext);
}
function previewKind(name) {
  if (isImage(name)) return 'image';
  if (isVideo(name)) return 'video';
  if (isAudio(name)) return 'audio';
  if (isPdf(name)) return 'pdf';
  if (isText(name)) return 'text';
  return null;
}

/* ---------- 登录 ---------- */
function showLogin() {
  $('app').style.display = 'none';
  $('login-layer').style.display = 'flex';
  TOKEN = '';
  localStorage.removeItem('fnfm_token');
}
function enterApp() {
  $('login-layer').style.display = 'none';
  $('app').style.display = 'flex';
  loadDir(currentPath);
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('login-password').value;
  const err = $('login-error');
  err.textContent = '';
  $('login-btn').textContent = '验证中…';
  $('login-btn').disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.ok) {
      TOKEN = data.token;
      localStorage.setItem('fnfm_token', TOKEN);
      $('login-password').value = '';
      enterApp();
    } else {
      err.textContent = data.error || '密码错误';
    }
  } catch (ex) {
    err.textContent = '网络错误，请重试';
  }
  $('login-btn').textContent = '进入';
  $('login-btn').disabled = false;
});
$('btn-logout').addEventListener('click', showLogin);

/* ---------- 图标 ---------- */
function isDoc(name) {
  return ['pdf','doc','docx','txt','md','ppt','pptx','xls','xlsx','csv','rtf','odt'].includes(getExt(name));
}
function fileCategory(name) {
  const ext = getExt(name);
  if (['png','jpg','jpeg','gif','webp','svg','bmp','ico','heic','raw'].includes(ext)) return 'img';
  if (['mp4','mkv','mov','avi','flv','wmv','m4v','ts'].includes(ext)) return 'video';
  if (['mp3','wav','flac','m4a','aac','ogg','opus'].includes(ext)) return 'audio';
  if (isDoc(name)) return 'doc';
  if (['zip','rar','7z','tar','gz','bz2','xz','iso','img','dmg'].includes(ext)) return 'zip';
  if (['js','ts','py','java','c','cpp','go','rs','html','css','json','sh','yml','yaml','sql','rb','php'].includes(ext)) return 'code';
  return 'file';
}
function iconFor(name, type, size) {
  const s = size || 34;
  if (type === 'dir') {
    return `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="#f0b429"/></svg>`;
  }
  const cat = fileCategory(name);
  const glyph = {
    img: `<rect x="3" y="4" width="18" height="16" rx="5" fill="#4f8cff"/><circle cx="9" cy="10" r="1.8" fill="#fff"/><path d="M4.5 17l4-3.6 2.8 2.4 3.2-2.9 5 4.4v1H4.5Z" fill="#fff" opacity=".95"/>`,
    video: `<rect x="3" y="4" width="18" height="16" rx="5" fill="#ff6b81"/><path d="M10 9l5.5 3-5.5 3Z" fill="#fff"/>`,
    audio: `<rect x="3" y="4" width="18" height="16" rx="5" fill="#f472b6"/><path d="M10 16.4V8.6l6-1.2v7.8M10 16.4a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0Zm6-1.8a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0Z" fill="#fff"/>`,
    doc: `<path d="M6 3h7l5 5v13H6Z" fill="#38bdf8"/><path d="M13 3v5h5" fill="#1d6fa5"/><path d="M9 12.5h6M9 15.5h6M9 18.5h4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`,
    zip: `<rect x="4" y="5" width="16" height="14" rx="4" fill="#4ade80"/><path d="M4 10h16" stroke="#166534" stroke-width="2"/><path d="M9 5v2.5M15 5v2.5M9 14.5V17M15 14.5V17" stroke="#166534" stroke-width="1.7"/>`,
    code: `<rect x="3" y="4" width="18" height="16" rx="5" fill="#a78bfa"/><path d="M9.5 9.5L6.5 12l3 2.5M14.5 9.5l3 2.5-3 2.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    file: `<path d="M6 3h8l4 4v14H6Z" fill="#8b98b3"/><path d="M14 3v4h4" fill="#5f6c86"/>`,
  }[cat];
  return `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}">${glyph}</svg>`;
}

/* ---------- 目录加载 ---------- */
async function loadDir(path, recordHistory = true) {
  try {
    if (!path) {
      const res = await api('/api/volumes');
      const data = await res.json();
      if (!data.ok) { toast(data.error || '加载失败', true); return; }
      currentPath = '';
      selectedPath = null;
      searchMode = false;
      $('search-input').value = '';
      renderBreadcrumb('');
      renderVolumes(data.volumes || []);
      renderSidebar(data.volumes || []);
      setToolbarEnabled(false);
      if (recordHistory) recordNav('');
      return;
    }
    const res = await api('/api/list?path=' + encodeURIComponent(path));
    const data = await res.json();
    if (!data.ok) { toast(data.error || '加载失败', true); return; }
    currentPath = data.path;
    selectedPath = null;
    searchMode = false;
    $('search-input').value = '';
    renderBreadcrumb(data.path);
    renderList(data.entries);
    setToolbarEnabled(true);
    if (recordHistory) recordNav(data.path);
  } catch (e) {
    toast('加载失败：' + e.message, true);
  }
}

function recordNav(path) {
  navHistory = navHistory.slice(0, navIndex + 1);
  if (navHistory[navIndex] !== path) {
    navHistory.push(path);
    navIndex = navHistory.length - 1;
  }
  updateNavButtons();
}
function updateNavButtons() {
  const back = $('btn-back'), fwd = $('btn-forward');
  back.disabled = navIndex <= 0;
  fwd.disabled = navIndex >= navHistory.length - 1;
  back.style.opacity = back.disabled ? '0.4' : '1';
  fwd.style.opacity = fwd.disabled ? '0.4' : '1';
}

/* 文件夹大小：懒加载（只计算滚动到视口内的文件夹，避免大目录卡顿） */
const _dirSizeCache = new Map();
let _sizeObserver = null;
function loadDirSizes(parentPath, list) {
  const dirs = list.filter((e) => e.type === 'dir');
  if (_sizeObserver) _sizeObserver.disconnect();
  if (!dirs.length || !('IntersectionObserver' in window)) return;
  _sizeObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        _sizeObserver.unobserve(en.target);
        computeDirSize(en.target.dataset.path);
      }
    });
  }, { root: document.querySelector('.content'), rootMargin: '160px' });
  dirs.forEach((d) => {
    const rel = parentPath + '/' + d.name;
    const el = document.querySelector(`[data-path="${CSS.escape(rel)}"]`);
    if (el) _sizeObserver.observe(el);
  });
}
async function computeDirSize(rel) {
  if (_dirSizeCache.has(rel)) { updateSizeCell(rel, _dirSizeCache.get(rel)); return; }
  try {
    const res = await api('/api/size?path=' + encodeURIComponent(rel));
    const data = await res.json();
    if (data.ok) { _dirSizeCache.set(rel, data); updateSizeCell(rel, data); }
  } catch (e) {}
}
function updateSizeCell(rel, data) {
  const txt = data.truncated ? `${fmtSize(data.size)}+` : fmtSize(data.size);
  const listEl = document.querySelector(`.file-item[data-path="${CSS.escape(rel)}"] .file-size`);
  if (listEl) listEl.textContent = txt;
  const gridEl = document.querySelector(`.grid-item[data-path="${CSS.escape(rel)}"] .grid-size`);
  if (gridEl) gridEl.textContent = txt;
}

function renderBreadcrumb(path) {
  const bc = $('breadcrumb');
  const parts = path ? path.split('/').filter(Boolean) : [];
  let html = `<span class="crumb" data-path="">此电脑</span>`;
  let acc = '';
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : p;
    const label = (i === 0 && volumeNames[p]) ? volumeNames[p] : p;
    html += `<span class="crumb-sep">›</span>`;
    if (i === parts.length - 1) html += `<span class="crumb current">${esc(label)}</span>`;
    else html += `<span class="crumb" data-path="${esc(acc)}">${esc(label)}</span>`;
  });
  bc.innerHTML = html;
  bc.querySelectorAll('.crumb[data-path]').forEach((el) => {
    el.addEventListener('click', () => loadDir(el.dataset.path));
  });
}

function renderVolumes(vols) {
  vols.forEach((v) => { volumeNames[v.path] = v.name; });
  const wrap = $('file-list');
  wrap.className = 'file-list';  // 防止套在上一次切到网格视图的窄列里
  if (!vols.length) { wrap.innerHTML = '<div class="empty">未检测到存储空间</div>'; return; }
  wrap.innerHTML = vols.map((v) => {
    const pct = Math.min(100, Math.max(0, v.usePct || 0));
    const danger = pct >= 90 ? ' danger' : '';
    return `<div class="vol-card" data-path="${esc(v.path)}">
      <div class="vol-icon"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M4 4 H14 L16 6 H20 A1 1 0 0 1 21 7 V17 A1 1 0 0 1 20 18 H4 A1 1 0 0 1 3 17 V5 A1 1 0 0 1 4 4 Z" fill="none" stroke="url(#vd)" stroke-width="1.6" stroke-linejoin="round"/><circle cx="17" cy="12" r="1.6" fill="#6ea8ff"/><defs><linearGradient id="vd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8ab6ff"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs></svg></div>
      <div class="vol-info">
        <div class="vol-name">${esc(v.name)}</div>
        <div class="vol-bar"><div class="vol-bar-fill${danger}" style="width:${pct}%"></div></div>
        <div class="vol-meta">已用 ${fmtSize(v.used)} / ${fmtSize(v.total)} · 剩余 ${fmtSize(v.free)}</div>
      </div>
      <div class="vol-arrow"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6 L15 12 L9 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.vol-card').forEach((el) => {
    el.addEventListener('click', () => loadDir(el.dataset.path));
  });
}

function renderSidebar(vols) {
  const box = $('side-vols');
  box.innerHTML = vols.map((v) => {
    const pct = Math.min(100, Math.max(0, v.usePct || 0));
    const cls = pct >= 90 ? 'danger' : (pct >= 75 ? 'warn' : '');
    return `<div class="side-vol" data-path="${esc(v.path)}" title="点击进入 ${esc(v.name)}">
      <div class="side-vol-head"><span class="side-vol-name">${esc(v.name)}</span><span class="side-vol-pct">${pct}%</span></div>
      <div class="side-vol-bar"><div class="side-vol-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="side-vol-meta">${fmtSize(v.used)} / ${fmtSize(v.total)}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.side-vol').forEach((el) => {
    el.addEventListener('click', () => loadDir(el.dataset.path));
  });
}

function applyFilter(list) {
  const MAP = { image: 'img', video: 'video', audio: 'audio', doc: 'doc' };
  const cat = MAP[filterType];
  if (!cat) return list;
  return list.filter((e) => e.type === 'dir' || fileCategory(e.name) === cat);
}

function renderList(list) {
  entries = list;
  const wrap = $('file-list');
  const shown = applyFilter(list);
  if (!shown.length) {
    wrap.className = 'file-list';
    wrap.innerHTML = `<div class="empty">${list.length ? '当前筛选条件下没有文件' : '此目录为空，拖拽文件到此处或点击上方按钮上传'}</div>`;
    return;
  }
  if (viewMode === 'grid') {
    wrap.className = 'file-list grid';
    wrap.innerHTML = shown.map(renderGridItem).join('');
  } else {
    wrap.className = 'file-list';
    wrap.innerHTML = shown.map(renderListItem).join('');
  }
  loadDirSizes(currentPath, shown);
}

function renderListItem(e) {
  const rel = currentPath ? currentPath + '/' + e.name : e.name;
  const isDir = e.type === 'dir';
  const sel = selectedPath === rel ? ' selected' : '';
  const canPrev = !isDir && previewKind(e.name);
  const sizeCell = isDir ? '<span class="file-size file-size-loading">—</span>' : `<span class="file-size">${fmtSize(e.size)}</span>`;
  return `<div class="file-item${sel}" data-path="${esc(rel)}" data-type="${e.type}" data-canprev="${canPrev ? '1' : '0'}">
    <div class="file-icon">${iconFor(e.name, e.type)}</div>
    <div class="file-info"><span class="file-name">${esc(e.name)}</span></div>
    <div class="file-meta">
      ${sizeCell}
      <span class="file-date">${fmtTime(e.mtime)}</span>
    </div>
    <div class="file-actions">
      ${!isDir && canPrev ? '<button class="mini-btn" data-act="preview" title="预览"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M2 12 C5 7 9 5 12 5 C15 5 19 7 22 12 C19 17 15 19 12 19 C9 19 5 17 2 12 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg></button>' : ''}
      <button class="mini-btn" data-act="download" title="下载"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 4 V14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 11 L12 16 L17 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20 H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      <button class="mini-btn" data-act="rename" title="重命名"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 20 H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 16 L14 7 L17 10 L8 19 H5 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
      <button class="mini-btn danger" data-act="delete" title="删除"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 7 H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 7 V4 A1 1 0 0 1 10 3 H14 A1 1 0 0 1 15 4 V7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 7 L7 20 A2 2 0 0 0 9 22 H15 A2 2 0 0 0 17 20 L18 7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
    </div>
  </div>`;
}

function renderGridItem(e) {
  const rel = currentPath ? currentPath + '/' + e.name : e.name;
  const isDir = e.type === 'dir';
  const sel = selectedPath === rel ? ' selected' : '';
  const meta = isDir ? '<span class="grid-size">—</span>' : `<span class="grid-size">${fmtSize(e.size)}</span>`;
  const isImg = !isDir && isImage(e.name);
  const thumb = isImg
    ? `<div class="grid-thumb"><img src="/api/download?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(TOKEN)}&inline=1" loading="lazy" alt="${esc(e.name)}" draggable="false"></div>`
    : `<div class="grid-icon">${iconFor(e.name, e.type, 44)}</div>`;
  return `<div class="grid-item${sel}" data-path="${esc(rel)}" data-type="${e.type}">
    ${thumb}
    <div class="grid-name">${esc(e.name)}</div>
    <div class="grid-meta">${meta}</div>
  </div>`;
}

function select(rel, type) {
  selectedPath = rel;
  document.querySelectorAll('.file-item, .grid-item').forEach((el) => {
    el.classList.toggle('selected', el.dataset.path === rel);
  });
}

/* 事件委托：列表所有文件只绑定一次，大目录不再卡顿 */
function initListDelegation() {
  const wrap = $('file-list');
  let pressTimer = null;
  wrap.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.file-item, .grid-item');
    if (!item) return;
    pressTimer = setTimeout(() => {
      const rel = item.dataset.path, type = item.dataset.type;
      select(rel, type);
      const t = e.touches[0];
      showContextMenu(t.clientX, t.clientY, rel, type, rel.split('/').pop());
    }, 600);
  }, { passive: true });
  wrap.addEventListener('touchend', () => clearTimeout(pressTimer));
  wrap.addEventListener('touchmove', () => clearTimeout(pressTimer));

  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.file-actions')) {
      const btn = e.target.closest('.mini-btn');
      const item = e.target.closest('.file-item, .grid-item');
      if (btn && item) {
        e.stopPropagation();
        const rel = item.dataset.path, type = item.dataset.type;
        const name = rel.split('/').pop();
        const act = btn.dataset.act;
        if (act === 'preview') openPreview(rel, name);
        else if (act === 'download') download(rel, name, type);
        else if (act === 'rename') promptRename(rel, name);
        else if (act === 'delete') confirmDelete(rel, name, type);
      }
      return;
    }
    const item = e.target.closest('.file-item, .grid-item');
    if (item) select(item.dataset.path, item.dataset.type);
  });

  wrap.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.file-item, .grid-item');
    if (!item) return;
    const rel = item.dataset.path, type = item.dataset.type;
    const name = rel.split('/').pop();
    if (type === 'dir') loadDir(rel);
    else if (previewKind(name)) openPreview(rel, name);
    else download(rel, name);
  });

  wrap.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.file-item, .grid-item');
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    const rel = item.dataset.path, type = item.dataset.type;
    select(rel, type);
    showContextMenu(e.clientX, e.clientY, rel, type, rel.split('/').pop());
  });
}

/* ---------- 文件预览 ---------- */
let _previewBlobUrl = null;
function openPreview(rel, name) {
  const kind = previewKind(name);
  if (!kind) { toast('此文件不支持预览', true); return; }
  const url = `/api/download?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(TOKEN)}&inline=1`;
  $('preview-title').textContent = name;
  const body = $('preview-body');
  body.innerHTML = '';
  if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
  $('preview-mask').style.display = 'flex';
  $('preview-download').onclick = () => download(rel, name, 'file');
  $('preview-fullscreen').onclick = () => {
    const el = body.firstElementChild;
    if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  };
  $('preview-close').onclick = closePreview;

  if (kind === 'image') {
    body.innerHTML = `<img src="${url}" alt="${esc(name)}">`;
  } else if (kind === 'video') {
    body.innerHTML = `<video src="${url}" controls autoplay playsinline preload="metadata"></video>`;
    const v = body.querySelector('video');
    // 错误兜底：长时间视频/大电影如出错可重新加载
    v.onerror = () => toast('视频加载失败，请重试', true);
  } else if (kind === 'audio') {
    body.innerHTML = `<audio src="${url}" controls autoplay preload="metadata"></audio>`;
  } else if (kind === 'pdf') {
    body.innerHTML = `<iframe src="${url}#toolbar=1" title="${esc(name)}"></iframe>`;
  } else if (kind === 'text') {
    fetch(url).then((r) => r.text()).then((text) => {
      body.innerHTML = `<pre>${esc(text.slice(0, 500000))}${text.length > 500000 ? '\n\n…(内容过长已截断)' : ''}</pre>`;
    }).catch((e) => {
      body.innerHTML = `<div class="preview-unsupported">加载失败：${esc(e.message)}</div>`;
    });
  }
}
function closePreview() {
  $('preview-mask').style.display = 'none';
  const body = $('preview-body');
  body.innerHTML = '';
  if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('preview-mask').style.display !== 'none') closePreview();
  }
});



/* ---------- 上传（直接弹系统文件选择器，上传到当前文件夹） ---------- */
$('btn-upload-file').addEventListener('click', () => {
  if (!currentPath) { toast('请先进入存储空间', true); return; }
  $('file-input').dataset.target = currentPath;
  $('file-input').click();
});
$('btn-upload-folder').addEventListener('click', () => {
  if (!currentPath) { toast('请先进入存储空间', true); return; }
  if (IS_MOBILE) {
    // 手机浏览器不支持选文件夹，降级为多选文件上传
    $('file-input').dataset.target = currentPath;
    $('file-input').click();
  } else {
    $('folder-input').dataset.target = currentPath;
    $('folder-input').click();
  }
});

$('file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length) uploadFiles(files, null, $('file-input').dataset.target || currentPath);
  e.target.value = '';
});
$('folder-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length) uploadFiles(files, 'folder', $('folder-input').dataset.target || currentPath);
  e.target.value = '';
});

async function uploadFiles(files, mode, targetDir) {
  const panel = $('upload-panel');
  panel.style.display = 'block';
  $('upload-title').textContent = mode === 'folder' ? '上传文件夹' : '上传文件';

  const total = files.length;
  let done = 0, failed = 0;
  const CONCURRENCY = 4;
  const queue = files.slice();

  function update() {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('upload-bar').style.width = pct + '%';
    $('upload-count').textContent = `${done}/${total}`;
  }
  update();

  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;
      let rel = file.name;
      if (file._relPath) rel = file._relPath;
      else if (mode === 'folder' && file.webkitRelativePath) rel = file.webkitRelativePath;
      const targetPath = targetDir ? targetDir + '/' + rel : rel;
      $('upload-current').textContent = '上传中：' + rel;
      let ok = await uploadOne(targetPath, file);
      if (!ok) { await sleep(500); ok = await uploadOne(targetPath, file); }
      if (!ok) failed++;
      done++;
      update();
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) workers.push(worker());
  await Promise.all(workers);

  $('upload-current').textContent = failed ? `完成（${failed} 个失败）` : '全部完成';
  toast(failed ? `上传完成，${failed} 个文件失败` : '上传完成');
  setTimeout(() => { panel.style.display = 'none'; $('upload-bar').style.width = '0%'; }, 1600);
  // 失效目标目录的 size 缓存
  _dirSizeCache.delete(targetDir);
  // 刷新视图
  if (targetDir === currentPath) loadDir(currentPath);
  else if (targetDir && currentPath.startsWith(targetDir)) loadDir(currentPath);
}

async function uploadOne(targetPath, file) {
  try {
    const res = await fetch('/api/upload?path=' + encodeURIComponent(targetPath), {
      method: 'POST',
      headers: { 'X-Auth-Token': TOKEN, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    return !!(data && data.ok);
  } catch (e) {
    return false;
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 下载 ---------- */
function download(rel, name, type) {
  const url = '/api/download?path=' + encodeURIComponent(rel) + '&token=' + encodeURIComponent(TOKEN);
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
  toast('开始下载：' + name);
}

/* ---------- 新建文件夹 ---------- */
$('btn-new-folder').addEventListener('click', () => {
  openModal('新建文件夹', '<input id="modal-input" placeholder="文件夹名称" autocomplete="off">', [
    { text: '取消', cls: 'btn-ghost', fn: closeModal },
    { text: '创建', cls: 'btn-confirm', fn: async () => {
      const name = $('modal-input').value.trim();
      if (!name) return toast('请输入名称', true);
      const p = currentPath ? currentPath + '/' + name : name;
      const res = await api('/api/mkdir?path=' + encodeURIComponent(p), { method: 'POST' });
      const data = await res.json();
      if (data.ok) { closeModal(); toast('已创建'); loadDir(currentPath); }
      else toast(data.error || '创建失败', true);
    } },
  ]);
  setTimeout(() => $('modal-input') && $('modal-input').focus(), 50);
});

function promptRename(rel, name) {
  openModal('重命名', `<input id="modal-input" value="${esc(name)}" autocomplete="off">`, [
    { text: '取消', cls: 'btn-ghost', fn: closeModal },
    { text: '确定', cls: 'btn-confirm', fn: async () => {
      const nn = $('modal-input').value.trim();
      if (!nn || nn === name) return closeModal();
      const parent = rel.split('/').slice(0, -1).join('/');
      const to = parent ? parent + '/' + nn : nn;
      const res = await api('/api/rename?from=' + encodeURIComponent(rel) + '&to=' + encodeURIComponent(to), { method: 'POST' });
      const data = await res.json();
      if (data.ok) { closeModal(); toast('已重命名'); loadDir(currentPath); }
      else toast(data.error || '重命名失败', true);
    } },
  ]);
  setTimeout(() => { const i = $('modal-input'); i.focus(); i.select(); }, 50);
}

function confirmDelete(rel, name, type) {
  openModal('删除确认', `<p>确定要删除 ${type === 'dir' ? '文件夹' : '文件'}「${esc(name)}」吗？<br>此操作不可恢复。</p>`, [
    { text: '取消', cls: 'btn-ghost', fn: closeModal },
    { text: '删除', cls: 'btn-danger', fn: async () => {
      const res = await api('/api/delete?path=' + encodeURIComponent(rel), { method: 'POST' });
      const data = await res.json();
      if (data.ok) { closeModal(); toast('已删除'); loadDir(currentPath); }
      else toast(data.error || '删除失败', true);
    } },
  ]);
}

/* ---------- 右键/长按菜单 ---------- */
function showContextMenu(x, y, rel, type, name) {
  const menu = $('context-menu');
  const items = [];
  if (type !== 'dir' && previewKind(name)) items.push({ icon: '👁', text: '预览', fn: () => openPreview(rel, name) });
  items.push({ icon: '⬇', text: '下载', fn: () => download(rel, name, type) });
  if (type === 'dir') items.push({ icon: '📐', text: '计算大小', fn: () => computeSizeNow(rel) });
  items.push({ icon: '✂', text: '剪切', fn: () => { clipboard = { from: rel }; toast('已剪切，到目标目录粘贴'); } });
  items.push({ icon: '✏', text: '重命名', fn: () => promptRename(rel, name) });
  items.push('sep');
  items.push({ icon: '🗑', text: '删除', danger: true, fn: () => confirmDelete(rel, name, type) });

  menu.innerHTML = items.map((it) => it === 'sep' ? '<div class="ctx-sep"></div>' : `<div class="ctx-item${it.danger ? ' danger' : ''}">${it.icon} ${esc(it.text)}</div>`).join('');
  menu.style.display = 'block';
  menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px';
  const actions = items.filter((it) => it !== 'sep');
  menu.querySelectorAll('.ctx-item').forEach((el, i) => el.addEventListener('click', () => { hideContextMenu(); actions[i].fn(); }));
}
function hideContextMenu() { $('context-menu').style.display = 'none'; }

document.querySelector('.content').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.file-item, .grid-item') || e.target.closest('.vol-card')) return;
  e.preventDefault();
  const menu = $('context-menu');
  let html = '';
  if (clipboard) html += '<div class="ctx-item">📋 粘贴到此处</div>';
  html += '<div class="ctx-item">📁 新建文件夹</div><div class="ctx-item">🔄 刷新</div>';
  menu.innerHTML = html;
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
  const items = menu.querySelectorAll('.ctx-item');
  const n = clipboard ? 1 : 0;
  if (clipboard) items[0].addEventListener('click', () => { hideContextMenu(); doPaste(); });
  items[n].addEventListener('click', () => { hideContextMenu(); $('btn-new-folder').click(); });
  items[n + 1].addEventListener('click', () => { hideContextMenu(); loadDir(currentPath); });
});

async function doPaste() {
  if (!clipboard) return;
  const from = clipboard.from;
  const name = from.split('/').pop();
  const to = currentPath;
  if (to === from.split('/').slice(0, -1).join('/')) { toast('已在该目录'); return; }
  const res = await api('/api/move?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to || ''), { method: 'POST' });
  const data = await res.json();
  if (data.ok) { clipboard = null; toast('已移动'); loadDir(currentPath); }
  else toast(data.error || '移动失败', true);
}


async function computeSizeNow(rel) {
  toast('计算中…');
  const res = await api('/api/size?path=' + encodeURIComponent(rel));
  const data = await res.json();
  if (data.ok) {
    _dirSizeCache.set(rel, data);
    updateSizeCell(rel, data);
    toast(`大小：${fmtSize(data.size)} · ${data.files} 个文件${data.truncated ? '（已截断）' : ''}`);
  } else toast(data.error || '计算失败', true);
}

/* ---------- 搜索 ---------- */
$('search-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = $('search-input').value.trim();
  if (!q) { loadDir(currentPath); return; }
  searchMode = true;
  const res = await api('/api/search?path=' + encodeURIComponent(currentPath) + '&q=' + encodeURIComponent(q));
  const data = await res.json();
  if (!data.ok) return toast(data.error, true);
  const list = (data.results || []).map((r) => ({ name: r.name, type: r.type || 'file', size: r.size || 0, mtime: r.mtime || 0, _searchPath: r.path }));
  const wrap = $('file-list');
  wrap.className = 'file-list';
  if (!list.length) { wrap.innerHTML = '<div class="empty">未找到匹配项</div>'; return; }
  // 搜索结果也用 data-path，交给事件委托统一处理（点击选中、双击打开/预览/下载、右键菜单）
  wrap.innerHTML = list.map((r) => {
    return `<div class="file-item" data-path="${esc(r._searchPath)}" data-type="${r.type}">
      <div class="file-icon">${iconFor(r.name, r.type)}</div>
      <div class="file-info"><span class="file-name">${esc(r.name)}</span></div>
      <div class="file-meta"><span class="file-size">${r.type === 'dir' ? '—' : fmtSize(r.size)}</span><span class="file-date">${fmtTime(r.mtime)}</span></div>
    </div>`;
  }).join('');
});

$('btn-refresh').addEventListener('click', () => { _dirSizeCache.clear(); loadDir(currentPath, false); });

/* ---------- 弹窗 ---------- */
function openModal(title, bodyHtml, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const box = $('modal-actions');
  box.innerHTML = '';
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = a.cls; b.textContent = a.text;
    b.addEventListener('click', a.fn);
    box.appendChild(b);
  });
  $('modal-mask').style.display = 'flex';
}
function closeModal() { $('modal-mask').style.display = 'none'; }
$('modal-mask').addEventListener('click', (e) => { if (e.target === $('modal-mask')) closeModal(); });

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) hideContextMenu();
});

/* ---------- 拖拽上传 ---------- */
const content = document.querySelector('.content');
content.addEventListener('dragover', (e) => { e.preventDefault(); content.classList.add('drag-over'); });
content.addEventListener('dragleave', () => content.classList.remove('drag-over'));
content.addEventListener('drop', async (e) => {
  e.preventDefault();
  content.classList.remove('drag-over');
  if (!currentPath) { toast('请先进入存储空间再上传', true); return; }
  const items = e.dataTransfer.items;
  const files = [];
  if (items) {
    for (const it of items) {
      if (it.kind === 'file') {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) { const c = await readEntry(entry); files.push(...c); }
      }
    }
  } else if (e.dataTransfer.files) { files.push(...Array.from(e.dataTransfer.files)); }
  if (files.length) uploadFiles(files, 'folder', currentPath);
});

async function readEntry(entry, basePath) {
  basePath = basePath || '';
  if (entry.isFile) {
    return await new Promise((resolve) => entry.file((f) => { f._relPath = basePath ? basePath + '/' + f.name : f.name; resolve([f]); }, () => resolve([])));
  } else if (entry.isDirectory) {
    const dirPath = basePath ? basePath + '/' + entry.name : entry.name;
    const reader = entry.createReader();
    const all = [];
    while (true) {
      const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (!batch.length) break;
      for (const en of batch) { const sub = await readEntry(en, dirPath); all.push(...sub); }
    }
    return all;
  }
  return [];
}

function setToolbarEnabled(enabled) {
  ['btn-upload-file', 'btn-upload-folder', 'btn-new-folder'].forEach((id) => {
    $(id).disabled = !enabled;
    $(id).style.opacity = enabled ? '1' : '0.45';
  });
  $('search-input').disabled = !enabled;
}

initListDelegation();

/* ---------- 视图切换 ---------- */
function setView(mode) {
  viewMode = mode;
  localStorage.setItem('fnfm_view', mode);
  $('view-grid').classList.toggle('active', mode === 'grid');
  $('view-list').classList.toggle('active', mode === 'list');
  if (entries.length) renderList(entries);
}
$('view-grid').addEventListener('click', () => setView('grid'));
$('view-list').addEventListener('click', () => setView('list'));
setView(viewMode);

/* ---------- 前进/后退导航 ---------- */
$('btn-back').addEventListener('click', () => {
  if (navIndex <= 0) return;
  navIndex--;
  updateNavButtons();
  loadDir(navHistory[navIndex] || '', false);
});
$('btn-forward').addEventListener('click', () => {
  if (navIndex >= navHistory.length - 1) return;
  navIndex++;
  updateNavButtons();
  loadDir(navHistory[navIndex] || '', false);
});

/* ---------- 快捷筛选 ---------- */
document.querySelectorAll('.side-item[data-filter]').forEach((el) => {
  el.addEventListener('click', () => {
    filterType = el.dataset.filter;
    document.querySelectorAll('.side-item[data-filter]').forEach((x) => x.classList.toggle('active', x === el));
    if (entries.length) renderList(entries);
  });
});

/* ---------- 启动 ---------- */
if (TOKEN) {
  fetch('/api/ping', { headers: { 'X-Auth-Token': TOKEN } })
    .then((r) => r.json())
    .then((d) => { if (d.ok) enterApp(); else showLogin(); })
    .catch(() => showLogin());
} else {
  showLogin();
}
