let publicConfig = null;
let adminConfig = null;
let currentPresetId = null;
const STORAGE_SESSIONS_KEY = 'easychat-sessions';
const STORAGE_CURRENT_ID_KEY = 'easychat-current-id';
let sessions = readLocalSessions();
let currentSessionId = localStorage.getItem(STORAGE_CURRENT_ID_KEY) || null;
let abortController = null;
let imageGenerating = false;
let currentImageTaskId = null;
let pendingImageDataUrl = '';
let sessionsSyncTimer = null;
let sessionsSyncInFlight = false;
const IMAGE_MAX_WIDTH = 1280;
const IMAGE_MAX_HEIGHT = 1280;
const IMAGE_QUALITY = 0.82;
const IMAGE_GENERATE_PRIMARY_SIZE = '3840x2160';
const IMAGE_GENERATE_FALLBACK_SIZES = ['2560x1440', '1920x1080', '1792x1024', '1024x1024'];
const IMAGE_TASK_POLL_INTERVAL_MS = 3000;
const IMAGE_TASK_MAX_WAIT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    const statusText = response?.status ? `HTTP ${response.status}` : '服务端响应异常';
    throw new Error(text ? `${statusText}，且返回了非 JSON 内容：${text.slice(0, 120)}` : `${statusText}，但响应体为空`);
  }
}

async function readJsonResponseOrThrow(response, fallbackMessage = '请求失败') {
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const detailMessage = typeof data?.details === 'string'
      ? data.details
      : data?.details?.error?.message || data?.details?.message || JSON.stringify(data?.details || '');
    throw new Error(detailMessage || data?.message || data?.error || `${fallbackMessage}：HTTP ${response.status}`);
  }
  return data;
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

async function pollImageTask(taskId, password, onProgress) {
  const started = Date.now();
  while (Date.now() - started < IMAGE_TASK_MAX_WAIT_MS) {
    await sleep(IMAGE_TASK_POLL_INTERVAL_MS);

    const response = await fetch(`/api/image-generate/${encodeURIComponent(taskId)}`, {
      headers: {
        'x-admin-password': password
      }
    });
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }

    onProgress?.(data, Date.now() - started);

    if (data.status === 'succeeded' && data.result?.url) {
      return data.result;
    }

    if (data.status === 'failed') {
      const detailMessage = typeof data?.details === 'string'
        ? data.details
        : data?.details?.error?.message || data?.details?.message || JSON.stringify(data?.details || '');
      throw new Error(detailMessage || data.error || '图片生成失败');
    }

    if (data.status === 'cancelled') {
      const error = new Error(data.error || '图片生成已取消');
      error.name = 'ImageTaskCancelled';
      throw error;
    }
  }

  throw new Error(`图片生成等待超时（${formatElapsed(IMAGE_TASK_MAX_WAIT_MS)}）`);
}

function readLocalSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_SESSIONS_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function syncSessionsToLocalStorage() {
  localStorage.setItem(STORAGE_SESSIONS_KEY, JSON.stringify(sessions));
  localStorage.setItem(STORAGE_CURRENT_ID_KEY, currentSessionId || '');
}

async function pushSessionsToServer() {
  if (sessionsSyncInFlight) return;
  const password = getAdminPassword();
  if (!password) return;

  sessionsSyncInFlight = true;
  try {
    await fetch('/api/sessions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password
      },
      body: JSON.stringify({ sessions, currentSessionId })
    });
  } catch (error) {
    console.warn('同步会话到服务端失败', error);
  } finally {
    sessionsSyncInFlight = false;
  }
}

function scheduleSessionsSync(immediate = false) {
  if (sessionsSyncTimer) {
    clearTimeout(sessionsSyncTimer);
    sessionsSyncTimer = null;
  }

  const delay = immediate ? 50 : 900;
  sessionsSyncTimer = setTimeout(() => {
    sessionsSyncTimer = null;
    pushSessionsToServer();
  }, delay);
}

async function loadSessionsFromServer() {
  const password = getAdminPassword();
  if (!password) return;

  try {
    const res = await fetch('/api/sessions', {
      headers: {
        'x-admin-password': password
      }
    });
    if (!res.ok) return;

    const data = await readJsonResponse(res);
    const remoteSessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const remoteCurrentId = String(data?.currentSessionId || '').trim();

    if (remoteSessions.length > 0) {
      sessions = remoteSessions;
      currentSessionId = remoteSessions.some((s) => s.id === remoteCurrentId) ? remoteCurrentId : remoteSessions[0].id;
      syncSessionsToLocalStorage();
      return;
    }

    if (sessions.length > 0) {
      scheduleSessionsSync(true);
    }
  } catch (error) {
    console.warn('从服务端加载会话失败，将继续使用本地会话', error);
  }
}

function buildImageFilename(url) {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const ext = /\.png($|\?)/i.test(url) ? 'png' : /\.webp($|\?)/i.test(url) ? 'webp' : /\.jpg($|\?)/i.test(url) || /\.jpeg($|\?)/i.test(url) ? 'jpg' : 'png';
  return `easychat-image-${date}-${Date.now()}.${ext}`;
}

async function downloadImage(url) {
  const safeUrl = sanitizeImageUrl(url);
  if (!safeUrl) {
    setStatus('图片地址无效，无法下载', 'error');
    return;
  }

  try {
    const res = await fetch(safeUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = buildImageFilename(safeUrl);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    setStatus('图片下载已开始', 'success');
  } catch (error) {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
    setStatus(`下载失败，已为你打开原图：${error.message}`, 'info');
  }
}

async function getImageDimensions(url) {
  const safeUrl = sanitizeImageUrl(url);
  if (!safeUrl) return null;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = Number(img.naturalWidth || 0);
      const height = Number(img.naturalHeight || 0);
      if (width > 0 && height > 0) {
        resolve({ width, height });
      } else {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = safeUrl;
  });
}

function isQuotaExceededError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('quota') || msg.includes('exceeded') || error?.name === 'QuotaExceededError';
}

function trimMessageForStorage(message, maxTextLen = 6000) {
  if (!message || typeof message !== 'object') return message;

  const cloned = { ...message };
  if (Array.isArray(cloned.content)) {
    cloned.content = cloned.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > maxTextLen) {
        return { ...part, text: `${part.text.slice(0, maxTextLen)}\n\n[内容过长，已截断以节省本地存储]` };
      }
      return part;
    });
  } else if (typeof cloned.content === 'string' && cloned.content.length > maxTextLen) {
    cloned.content = `${cloned.content.slice(0, maxTextLen)}\n\n[内容过长，已截断以节省本地存储]`;
  }

  return cloned;
}

function shrinkSessionsForStorage() {
  if (sessions.length > 10) {
    sessions = sessions.slice(0, 10);
    if (!sessions.some((s) => s.id === currentSessionId)) {
      currentSessionId = sessions[0]?.id || null;
    }
    return true;
  }

  const current = getCurrentSession();
  if (current?.history?.length > 24) {
    current.history = current.history.slice(-24);
    return true;
  }

  let changed = false;
  sessions = sessions.map((session) => {
    const oldHistory = Array.isArray(session.history) ? session.history : [];
    const newHistory = oldHistory.map((msg) => {
      const trimmed = trimMessageForStorage(msg);
      if (JSON.stringify(trimmed) !== JSON.stringify(msg)) changed = true;
      return trimmed;
    });
    return { ...session, history: newHistory };
  });

  return changed;
}

function saveSessions() {
  for (let i = 0; i < 6; i += 1) {
    try {
      syncSessionsToLocalStorage();
      scheduleSessionsSync();
      return;
    } catch (error) {
      if (!isQuotaExceededError(error)) {
        console.error('保存会话失败', error);
        return;
      }

      const shrunk = shrinkSessionsForStorage();
      if (!shrunk) {
        console.error('本地存储空间不足，且无法继续压缩会话数据');
        return;
      }
    }
  }

  console.error('本地存储空间不足，保存会话未完全成功');
}

function sanitizeHtml(html) {
  return DOMPurify.sanitize(html);
}

function markdownToHtml(content) {
  return sanitizeHtml(marked.parse(content || ''));
}

async function copyTextToClipboard(text, successMessage = '已复制到剪贴板') {
  const value = String(text || '');
  if (!value) {
    setStatus('没有可复制内容', 'info');
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setStatus(successMessage, 'success');
    return true;
  } catch (error) {
    setStatus(`复制失败：${error.message}`, 'error');
    return false;
  }
}

function enhanceCodeBlocks(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.copyEnhanced === 'true') return;
    pre.dataset.copyEnhanced = 'true';
    pre.classList.add('relative', 'group');

    const code = pre.querySelector('code');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'absolute top-2 right-2 z-10 px-2 py-1 rounded-lg bg-slate-900/80 text-slate-100 text-[10px] font-semibold opacity-80 hover:opacity-100 transition shadow border border-white/10';
    button.textContent = '复制代码';
    button.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ok = await copyTextToClipboard(code?.innerText || pre.innerText, '代码已复制');
      if (ok) {
        button.textContent = '已复制';
        setTimeout(() => {
          button.textContent = '复制代码';
        }, 1200);
      }
    };

    pre.appendChild(button);
  });
}

function sanitizeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^\/uploads\//i.test(value)) return value;
  if (/^data:image\//i.test(value)) return value;
  return '';
}

function dataUrlSizeKB(dataUrl) {
  return Math.round((String(dataUrl || '').length * 3) / 4 / 1024);
}

async function uploadImageDataUrl(dataUrl) {
  const password = requireAdminPasswordOrThrow();
  const res = await fetch('/api/upload-image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': password
    },
    body: JSON.stringify({ dataUrl })
  });

  const data = await readJsonResponse(res);
  if (!res.ok || !data?.ok || !data?.url) {
    throw new Error(data?.error || `上传失败 HTTP ${res.status}`);
  }

  return sanitizeImageUrl(data.url);
}

async function compressImageDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const ratio = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height, 1);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
      resolve(compressed || dataUrl);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function extractImageUrl(part) {
  if (!part || part.type !== 'image_url') return '';
  if (typeof part.image_url === 'string') return sanitizeImageUrl(part.image_url);
  if (part.image_url && typeof part.image_url === 'object') {
    return sanitizeImageUrl(part.image_url.url);
  }
  return '';
}

function normalizeMessageContent(content) {
  if (Array.isArray(content)) {
    const textParts = [];
    const images = [];

    content.forEach((part) => {
      if (!part) return;
      if (part.type === 'text' && part.text) textParts.push(String(part.text));
      const imageUrl = extractImageUrl(part);
      if (imageUrl) images.push(imageUrl);
    });

    return {
      text: textParts.join('\n\n').trim(),
      images
    };
  }

  return {
    text: String(content || ''),
    images: []
  };
}

function renderBubbleContent(bubble, content) {
  bubble.__content = content;
  const normalized = normalizeMessageContent(content);
  bubble.innerHTML = '';

  if (normalized.text) {
    const textBlock = document.createElement('div');
    textBlock.innerHTML = markdownToHtml(normalized.text);
    bubble.appendChild(textBlock);
  }

  normalized.images.forEach((url) => {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'user-image';
    img.className = 'mt-3 rounded-xl max-h-72 w-auto border border-white/20 dark:border-slate-700';
    bubble.appendChild(img);

    const actions = document.createElement('div');
    actions.className = 'mt-1';
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'text-[11px] text-blue-500 hover:text-blue-600 transition';
    downloadBtn.textContent = '下载图片';
    downloadBtn.onclick = () => downloadImage(url);
    actions.appendChild(downloadBtn);
    bubble.appendChild(actions);
  });

  bubble.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
  enhanceCodeBlocks(bubble);
}

function updateImagePreview() {
  const wrap = document.getElementById('image-preview-wrap');
  const img = document.getElementById('image-preview');
  if (!wrap || !img) return;

  const imageUrl = sanitizeImageUrl(pendingImageDataUrl);
  if (!imageUrl) {
    img.removeAttribute('src');
    wrap.classList.add('hidden');
    return;
  }

  img.src = imageUrl;
  wrap.classList.remove('hidden');
}

function clearImageUrl() {
  pendingImageDataUrl = '';
  updateImagePreview();
}

function handleUserInputPaste(event) {
  const items = event.clipboardData?.items;
  if (!items || !items.length) return;

  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;

    const file = item.getAsFile();
    if (!file) continue;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = sanitizeImageUrl(reader.result);
        if (!dataUrl) return;

        setStatus('截图处理中...', 'info');
        const before = dataUrlSizeKB(dataUrl);
        const compressed = await compressImageDataUrl(dataUrl);
        const finalDataUrl = sanitizeImageUrl(compressed) || dataUrl;
        const after = dataUrlSizeKB(finalDataUrl);

        const uploadedUrl = await uploadImageDataUrl(finalDataUrl);
        if (!uploadedUrl) {
          throw new Error('上传后未返回有效图片地址');
        }

        pendingImageDataUrl = uploadedUrl;
        updateImagePreview();
        setStatus(`截图已就绪（${before}KB → ${after}KB）`, 'success');
      } catch (error) {
        setStatus(`截图处理失败：${error.message}`, 'error');
      }
    };
    reader.readAsDataURL(file);
    event.preventDefault();
    return;
  }
}

function getAdminPassword() {
  return document.getElementById('admin-password').value.trim();
}

function requireAdminPasswordOrThrow() {
  const password = getAdminPassword();
  if (!password) {
    throw new Error('请先输入管理密码');
  }
  return password;
}

function getCurrentSession() {
  return sessions.find((s) => s.id === currentSessionId);
}

function getCurrentPreset() {
  return publicConfig?.presets?.find((p) => p.id === currentPresetId) || null;
}

function setStatus(message, type = 'info') {
  const box = document.getElementById('status-box');
  const map = {
    info: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-slate-50/70 dark:bg-slate-900/40',
    success: 'border-green-200 text-green-700 bg-green-50 dark:border-green-900 dark:text-green-300 dark:bg-green-950/30',
    error: 'border-red-200 text-red-700 bg-red-50 dark:border-red-900 dark:text-red-300 dark:bg-red-950/30'
  };

  box.className = `text-xs rounded-2xl p-4 border ${map[type] || map.info}`;
  box.textContent = message;
  box.classList.remove('hidden');
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const isHidden = sb.classList.contains('-translate-x-full');

  if (isHidden) {
    sb.classList.remove('-translate-x-full');
    ov.classList.remove('hidden');
    setTimeout(() => ov.classList.add('opacity-100'), 10);
  } else {
    sb.classList.add('-translate-x-full');
    ov.classList.remove('opacity-100');
    setTimeout(() => ov.classList.add('hidden'), 300);
  }
}

function toggleDarkMode() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('easychat-dark', document.documentElement.classList.contains('dark'));
}

function clearAllData() {
  if (!confirm('清空所有本地会话记录？')) return;
  localStorage.removeItem(STORAGE_SESSIONS_KEY);
  localStorage.removeItem(STORAGE_CURRENT_ID_KEY);
  location.reload();
}

function renderPresetTabs() {
  const container = document.getElementById('preset-tabs');
  container.innerHTML = '';

  (publicConfig?.presets || []).forEach((p) => {
    const btn = document.createElement('button');
    btn.className = `px-3 py-1 text-[10px] rounded-full whitespace-nowrap transition-all border ${
      p.id === currentPresetId
        ? 'bg-blue-600 border-blue-600 text-white font-bold'
        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500'
    }`;
    btn.innerText = p.name;
    btn.onclick = () => {
      currentPresetId = p.id;
      localStorage.setItem('easychat-preset-id', currentPresetId);
      renderPresetTabs();
      updatePresetInfo();
    };
    container.appendChild(btn);
  });
}

function updatePresetInfo() {
  const preset = getCurrentPreset();
  if (!preset) {
    document.getElementById('current-model').textContent = '-';
    return;
  }
  const imageModel = preset.imageModel ? ` ｜ 出图：${preset.imageModel}` : '';
  document.getElementById('current-model').textContent = `${preset.name} / 聊天：${preset.model}${imageModel}`;
}

function createNewChat() {
  if (abortController) abortController.abort();

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.unshift({ id, title: 'New Chat', history: [] });
  currentSessionId = id;
  saveSessions();
  renderHistoryList();
  loadSession(id);
  setStatus('已新建会话', 'success');
  if (window.innerWidth < 1024) toggleSidebar();
}

function loadSession(id) {
  currentSessionId = id;
  saveSessions();

  const session = getCurrentSession();
  const container = document.querySelector('#chat-box > div');
  container.innerHTML = '';

  if (!session || session.history.length === 0) {
    container.innerHTML = `
      <div id="welcome-view" class="text-center pt-0 pb-6">
        <h1 id="app-title" class="text-7xl font-black mb-4 tracking-tighter italic oops-gradient">${publicConfig?.appName || 'EasyChat'}</h1>
        <p class="text-slate-400 dark:text-slate-600 text-sm font-medium tracking-widest uppercase">Start Conversation</p>
      </div>
    `;
  } else {
    session.history.forEach((msg) => renderBubble(msg.role, msg.content));
  }

  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';

  sessions.forEach((s) => {
    const row = document.createElement('div');
    row.className = `flex items-center justify-between group p-4 rounded-2xl cursor-pointer transition-all ${
      s.id === currentSessionId
        ? 'bg-blue-50/40 dark:bg-blue-500/10 text-blue-600 font-bold backdrop-blur-md'
        : 'hover:bg-slate-50/40 dark:hover:bg-slate-800/40 text-slate-500'
    }`;
    row.onclick = () => loadSession(s.id);
    row.innerHTML = `
      <span class="truncate text-xs flex-1">${s.title}</span>
      <button onclick="deleteSession(event, '${s.id}')" class="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition">✕</button>
    `;
    list.appendChild(row);
  });
}

function deleteSession(e, id) {
  e.stopPropagation();
  sessions = sessions.filter((s) => s.id !== id);

  if (currentSessionId === id) {
    currentSessionId = sessions.length ? sessions[0].id : null;
  }

  if (sessions.length === 0) {
    createNewChat();
  } else {
    saveSessions();
    renderHistoryList();
    loadSession(currentSessionId);
  }
}

function stringifyMessageForCopy(content) {
  const normalized = normalizeMessageContent(content);
  const blocks = [];
  if (normalized.text) blocks.push(normalized.text);

  normalized.images.forEach((url) => {
    if (/^data:image\//i.test(url)) {
      blocks.push('[截图图片]');
    } else {
      blocks.push(`[图片] ${url}`);
    }
  });

  return blocks.join('\n');
}

async function copyMessage(content) {
  await copyTextToClipboard(stringifyMessageForCopy(content));
}

function renderBubble(role, content) {
  document.getElementById('welcome-view')?.remove();

  const container = document.querySelector('#chat-box > div');
  const div = document.createElement('div');
  div.className = `flex flex-col ${role === 'user' ? 'items-end' : 'items-start'}`;

  const bubble = document.createElement('div');
  bubble.className = `max-w-[90%] md:max-w-[85%] p-5 rounded-[22px] ${
    role === 'user'
      ? 'bg-blue-600 text-white shadow-lg rounded-tr-none'
      : 'bg-white/70 dark:bg-darkCard/70 backdrop-blur-md text-slate-800 dark:text-slate-200 border border-white/10 dark:border-slate-800 shadow-sm rounded-tl-none'
  } prose dark:prose-invert prose-sm leading-relaxed chat-select`;

  renderBubbleContent(bubble, content);

  const meta = document.createElement('div');
  meta.className = 'mb-2 px-2 flex items-center gap-2';
  meta.innerHTML = `<span class="text-[9px] font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest">${role}</span>`;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'text-[10px] text-slate-400 hover:text-blue-500 transition';
  copyBtn.textContent = '复制';
  copyBtn.onclick = () => copyMessage(bubble.__content);

  meta.appendChild(copyBtn);
  div.appendChild(meta);
  div.appendChild(bubble);
  container.appendChild(div);

  document.getElementById('chat-box').scrollTop = document.getElementById('chat-box').scrollHeight;

  return bubble;
}

function randomId(prefix = 'preset') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setAdminPanelVisible(visible) {
  document.getElementById('admin-panel').classList.toggle('hidden', !visible);
}

function renderAdminPanel() {
  if (!adminConfig) {
    setAdminPanelVisible(false);
    return;
  }

  setAdminPanelVisible(true);
  document.getElementById('app-name-input').value = adminConfig.appName || '';
  document.getElementById('background-image-input').value = adminConfig.backgroundImage || '';

  const container = document.getElementById('admin-presets');
  container.innerHTML = '';

  adminConfig.presets.forEach((preset, index) => {
    const card = document.createElement('div');
    card.className = 'p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3';
    card.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <input type="radio" name="default-preset" ${adminConfig.defaultPresetId === preset.id ? 'checked' : ''} onchange="setDefaultPreset('${preset.id}')">
          默认预设
        </label>
        <button onclick="deleteAdminPreset('${preset.id}')" class="text-xs text-red-500 hover:underline">删除</button>
      </div>
      <input data-field="name" data-id="${preset.id}" value="${escapeHtml(preset.name)}" placeholder="Preset Name" class="admin-input w-full p-3 bg-white/70 dark:bg-slate-950/50 border dark:border-slate-700 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
      <input data-field="baseUrl" data-id="${preset.id}" value="${escapeHtml(preset.baseUrl)}" placeholder="https://api.openai.com/v1" class="admin-input w-full p-3 bg-white/70 dark:bg-slate-950/50 border dark:border-slate-700 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
      <input data-field="model" data-id="${preset.id}" value="${escapeHtml(preset.model)}" placeholder="gpt-4o" class="admin-input w-full p-3 bg-white/70 dark:bg-slate-950/50 border dark:border-slate-700 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
      <input data-field="imageModel" data-id="${preset.id}" value="${escapeHtml(preset.imageModel || '')}" placeholder="gpt-image-1（可选）" class="admin-input w-full p-3 bg-white/70 dark:bg-slate-950/50 border dark:border-slate-700 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
      <input data-field="apiKey" data-id="${preset.id}" value="${escapeHtml(preset.apiKey)}" placeholder="sk-..." class="admin-input w-full p-3 bg-white/70 dark:bg-slate-950/50 border dark:border-slate-700 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 text-sm">
      <div class="text-[10px] text-slate-400">Preset ${index + 1}</div>
    `;
    container.appendChild(card);
  });

  document.querySelectorAll('.admin-input').forEach((input) => {
    input.addEventListener('input', (event) => {
      const { id, field } = event.target.dataset;
      updateAdminPreset(id, field, event.target.value);
    });
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function updateAdminPreset(id, field, value) {
  if (!adminConfig) return;
  const preset = adminConfig.presets.find((item) => item.id === id);
  if (!preset) return;
  preset[field] = value;
}

function setDefaultPreset(id) {
  if (!adminConfig) return;
  adminConfig.defaultPresetId = id;
}

function addAdminPreset() {
  if (!adminConfig) {
    setStatus('请先加载管理配置', 'info');
    return;
  }

  adminConfig.presets.push({
    id: randomId(),
    name: 'New Preset',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    imageModel: 'gpt-image-1',
    apiKey: ''
  });

  renderAdminPanel();
}

function deleteAdminPreset(id) {
  if (!adminConfig) return;
  if (adminConfig.presets.length === 1) {
    setStatus('至少保留一个预设', 'error');
    return;
  }

  adminConfig.presets = adminConfig.presets.filter((preset) => preset.id !== id);
  if (adminConfig.defaultPresetId === id) {
    adminConfig.defaultPresetId = adminConfig.presets[0]?.id || '';
  }
  renderAdminPanel();
}

function collectAdminForm() {
  if (!adminConfig) return null;
  return {
    appName: document.getElementById('app-name-input').value.trim(),
    backgroundImage: document.getElementById('background-image-input').value.trim(),
    defaultPresetId: adminConfig.defaultPresetId,
    presets: adminConfig.presets.map((preset) => ({
      id: String(preset.id || '').trim(),
      name: String(preset.name || '').trim(),
      baseUrl: String(preset.baseUrl || '').trim(),
      model: String(preset.model || '').trim(),
      imageModel: String(preset.imageModel || '').trim(),
      apiKey: String(preset.apiKey || '').trim()
    }))
  };
}

function setActionButtonsDisabled(disabled) {
  const sendBtn = document.getElementById('send-btn');
  const imageBtn = document.getElementById('image-btn');
  if (sendBtn) sendBtn.disabled = disabled;
  if (imageBtn) imageBtn.disabled = disabled;
}

async function loadAdminConfig() {
  const password = getAdminPassword();
  if (!password) {
    setStatus('请先输入管理密码', 'error');
    return;
  }

  try {
    const res = await fetch('/api/admin/config', {
      headers: {
        'x-admin-password': password
      }
    });

    const data = await readJsonResponseOrThrow(res, '加载管理配置失败');

    adminConfig = data;
    renderAdminPanel();
    setStatus('管理配置已加载', 'success');
  } catch (error) {
    adminConfig = null;
    renderAdminPanel();
    setStatus(`加载管理配置失败：${error.message}`, 'error');
  }
}

async function saveAdminConfig() {
  const password = getAdminPassword();
  if (!password) {
    setStatus('请先输入管理密码', 'error');
    return;
  }

  const payload = collectAdminForm();
  if (!payload) {
    setStatus('请先加载管理配置', 'error');
    return;
  }

  try {
    const res = await fetch('/api/admin/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password
      },
      body: JSON.stringify(payload)
    });

    const data = await readJsonResponseOrThrow(res, '保存配置失败');

    adminConfig = data.config;
    renderAdminPanel();
    await refreshPublicConfig();
    setStatus('配置已保存，前端预设已刷新', 'success');
  } catch (error) {
    setStatus(`保存配置失败：${error.message}`, 'error');
  }
}

async function refreshPublicConfig() {
  const password = requireAdminPasswordOrThrow();
  const res = await fetch('/api/config', {
    headers: {
      'x-admin-password': password
    }
  });
  publicConfig = await readJsonResponseOrThrow(res, '加载配置失败');

  document.title = publicConfig.appName || 'EasyChat AI';
  const appTitle = document.getElementById('app-title');
  if (appTitle) appTitle.textContent = publicConfig.appName || 'EasyChat';

  document.getElementById('dynamic-bg').style.backgroundImage = publicConfig.backgroundImage
    ? `url('${publicConfig.backgroundImage}')`
    : 'none';

  const storedPresetId = localStorage.getItem('easychat-preset-id');
  const availablePresetIds = publicConfig.presets.map((preset) => preset.id);
  currentPresetId = availablePresetIds.includes(currentPresetId)
    ? currentPresetId
    : availablePresetIds.includes(storedPresetId)
      ? storedPresetId
      : publicConfig.defaultPresetId || publicConfig.presets[0]?.id;

  localStorage.setItem('easychat-preset-id', currentPresetId || '');
  renderPresetTabs();
  updatePresetInfo();
}

async function testConnection() {
  const indicator = document.getElementById('test-indicator');
  const preset = getCurrentPreset();
  if (!preset) return;

  const password = getAdminPassword();
  if (!password) {
    setStatus('请先输入管理密码', 'error');
    return;
  }

  setStatus('正在测试连通性...', 'info');
  indicator.className = 'w-3 h-3 rounded-full bg-yellow-400 animate-pulse';

  try {
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password
      },
      body: JSON.stringify({ presetId: preset.id })
    });

    const data = await readJsonResponse(res);

    if (res.ok && data.ok) {
      indicator.className = 'w-3 h-3 rounded-full bg-green-500 shadow-[0_0_12px_#22c55e]';
      setStatus(`连接成功：${preset.name} / ${preset.model}`, 'success');
    } else {
      indicator.className = 'w-3 h-3 rounded-full bg-red-500 shadow-[0_0_12px_#ef4444]';
      setStatus(`连接失败：${data.message || data.error || '未知错误'}`, 'error');
    }
  } catch (error) {
    indicator.className = 'w-3 h-3 rounded-full bg-red-500 shadow-[0_0_12px_#ef4444]';
    setStatus(`连接失败：${error.message}`, 'error');
  }
}

async function readSSEStream(response, onDelta) {
  if (!response.body) throw new Error('响应无数据流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;

        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content || '';
          if (delta) onDelta(delta);
        } catch (_) {}
      }
    }
  }
}

async function handleSend() {
  if (abortController || imageGenerating) return;

  const input = document.getElementById('user-input');
  const text = input.value.trim();
  const imageUrl = sanitizeImageUrl(pendingImageDataUrl);
  const preset = getCurrentPreset();

  if ((!text && !imageUrl) || !preset) return;

  const password = getAdminPassword();
  if (!password) {
    setStatus('请先输入管理密码', 'error');
    return;
  }

  let session = getCurrentSession();
  if (!session) {
    createNewChat();
    session = getCurrentSession();
  }

  abortController = new AbortController();
  document.getElementById('loading-tag').classList.remove('hidden');
  document.getElementById('stop-btn').classList.remove('hidden');
  setStatus(`已使用预设：${preset.name} / ${preset.model}`, 'info');

  input.value = '';
  pendingImageDataUrl = '';
  updateImagePreview();
  input.style.height = 'auto';

  const userContent = imageUrl
    ? [
        ...(text ? [{ type: 'text', text }] : []),
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    : text;

  if (session.history.length === 0) {
    const titleBase = text || 'Image Chat';
    session.title = titleBase.substring(0, 24);
    renderHistoryList();
  }

  renderBubble('user', userContent);
  session.history.push({ role: 'user', content: userContent });

  const aiBubble = renderBubble('assistant', '');
  aiBubble.classList.add('typing');

  let full = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password
      },
      body: JSON.stringify({
        presetId: preset.id,
        messages: session.history,
        stream: true
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const data = await readJsonResponse(response);
        msg = data.details || data.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }

    await readSSEStream(response, (delta) => {
      full += delta;
      renderBubbleContent(aiBubble, full);
      document.getElementById('chat-box').scrollTop = document.getElementById('chat-box').scrollHeight;
    });

    session.history.push({ role: 'assistant', content: full });
    saveSessions();
  } catch (error) {
    if (error.name === 'AbortError') {
      if (full) {
        session.history.push({ role: 'assistant', content: full });
        saveSessions();
      } else {
        aiBubble.innerHTML = '<span class="text-slate-400">已停止生成</span>';
      }
    } else {
      aiBubble.innerHTML = `<span class="text-red-500">错误：${error.message}</span>`;
      setStatus(`聊天失败：${error.message}`, 'error');
    }
  } finally {
    aiBubble.classList.remove('typing');
    aiBubble.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
    enhanceCodeBlocks(aiBubble);
    document.getElementById('loading-tag').classList.add('hidden');
    document.getElementById('stop-btn').classList.add('hidden');
    abortController = null;
  }
}

async function handleImageGenerate() {
  if (abortController || imageGenerating) return;

  const input = document.getElementById('user-input');
  const prompt = input.value.trim();
  const preset = getCurrentPreset();

  if (!prompt || !preset) return;

  const password = getAdminPassword();
  if (!password) {
    setStatus('请先输入管理密码', 'error');
    return;
  }

  let session = getCurrentSession();
  if (!session) {
    createNewChat();
    session = getCurrentSession();
  }

  imageGenerating = true;
  setActionButtonsDisabled(true);
  document.getElementById('loading-tag').classList.remove('hidden');
  document.getElementById('stop-btn').classList.remove('hidden');
  document.getElementById('loading-tag').textContent = 'Generating image';
  setStatus(`开始生成图片：${preset.name} / ${preset.imageModel || preset.model}`, 'info');

  input.value = '';
  input.style.height = 'auto';

  const userContent = `请帮我生成一张图片：${prompt}`;
  if (session.history.length === 0) {
    session.title = prompt.substring(0, 24) || 'Image Chat';
    renderHistoryList();
  }

  renderBubble('user', userContent);
  session.history.push({ role: 'user', content: userContent });

  const aiBubble = renderBubble('assistant', '正在生成图片，请稍候...');
  const assistantMessage = { role: 'assistant', content: '正在生成图片，请稍候...' };
  session.history.push(assistantMessage);
  saveSessions();

  try {
    const response = await fetch('/api/image-generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': password
      },
      body: JSON.stringify({
        presetId: preset.id,
        prompt,
        size: IMAGE_GENERATE_PRIMARY_SIZE,
        fallbackSizes: IMAGE_GENERATE_FALLBACK_SIZES
      })
    });

    const taskData = await readJsonResponse(response);
    if (!response.ok || !taskData?.ok || !taskData?.taskId) {
      const detailMessage = typeof taskData?.details === 'string'
        ? taskData.details
        : taskData?.details?.error?.message || taskData?.details?.message || JSON.stringify(taskData?.details || '');
      throw new Error(detailMessage || taskData?.error || `HTTP ${response.status}`);
    }

    currentImageTaskId = taskData.taskId;

    setStatus(`图片任务已提交，正在后台生成（任务：${taskData.taskId}）`, 'info');
    assistantMessage.content = `图片任务已提交，正在后台生成...\n\n任务 ID：${taskData.taskId}`;
    renderBubbleContent(aiBubble, assistantMessage.content);
    saveSessions();

    const data = await pollImageTask(taskData.taskId, password, (task, elapsed) => {
      const statusText = task.status === 'queued' ? '排队中' : task.status === 'running' ? '生成中' : task.status;
      const message = `图片${statusText}，已等待 ${formatElapsed(elapsed)}...\n\n任务 ID：${taskData.taskId}`;
      assistantMessage.content = message;
      renderBubbleContent(aiBubble, message);
      setStatus(`图片${statusText}，已等待 ${formatElapsed(elapsed)}`, 'info');
    });

    if (!data?.url) {
      const detailMessage = typeof data?.details === 'string'
        ? data.details
        : data?.details?.error?.message || data?.details?.message || JSON.stringify(data?.details || '');
      throw new Error(detailMessage || data?.error || '上游未返回图片地址');
    }

    const safeImageUrl = sanitizeImageUrl(data.url) || data.url;
    const actualDimensions = await getImageDimensions(safeImageUrl);
    const requestedSizeText = data.sizeUsed || IMAGE_GENERATE_PRIMARY_SIZE;
    const actualSizeText = actualDimensions ? `${actualDimensions.width}x${actualDimensions.height}` : '未知';
    const sizeMismatch = actualDimensions && requestedSizeText && requestedSizeText !== actualSizeText;

    const assistantContent = [
      {
        type: 'text',
        text: `已为你生成图片。\n\n调用模型：${data.model || preset.imageModel || preset.model}${data.upstreamModel && data.upstreamModel !== data.model ? `（上游返回：${data.upstreamModel}）` : ''}\n请求分辨率：${requestedSizeText}${data.fallbackApplied ? '（已自动降级到兼容尺寸）' : ''}\n实际分辨率：${actualSizeText}${sizeMismatch ? '\n⚠️ 上游返回的实际分辨率与请求分辨率不一致。' : ''}\n\n提示词：${data.prompt || prompt}${data.revisedPrompt ? `\n\n优化后提示词：${data.revisedPrompt}` : ''}`
      },
      { type: 'image_url', image_url: { url: safeImageUrl } }
    ];

    renderBubbleContent(aiBubble, assistantContent);
    assistantMessage.content = assistantContent;
    saveSessions();
    setStatus('图片生成成功', 'success');
  } catch (error) {
    const errorContent = `出图失败：${error.message}`;
    assistantMessage.content = errorContent;
    aiBubble.innerHTML = `<span class="${error.name === 'ImageTaskCancelled' ? 'text-slate-400' : 'text-red-500'}">${error.name === 'ImageTaskCancelled' ? '图片生成已取消' : errorContent}</span>`;
    saveSessions();
    setStatus(error.name === 'ImageTaskCancelled' ? '图片生成已取消' : `出图失败：${error.message}`, error.name === 'ImageTaskCancelled' ? 'info' : 'error');
  } finally {
    imageGenerating = false;
    currentImageTaskId = null;
    setActionButtonsDisabled(false);
    document.getElementById('loading-tag').classList.add('hidden');
    document.getElementById('stop-btn').classList.add('hidden');
    document.getElementById('loading-tag').textContent = 'Assistant is typing';
  }
}

function stopGeneration() {
  if (abortController) abortController.abort();
  if (imageGenerating && currentImageTaskId) {
    const password = getAdminPassword();
    const taskId = currentImageTaskId;
    currentImageTaskId = null;
    fetch(`/api/image-generate/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      headers: {
        'x-admin-password': password
      }
    }).catch((error) => console.warn('取消图片任务失败', error));
    setStatus('已请求停止图片生成', 'info');
  }
}

async function init() {
  if (localStorage.getItem('easychat-dark') === 'true') {
    document.documentElement.classList.add('dark');
  }

  const savedAdminPassword = localStorage.getItem('easychat-admin-password');
  if (savedAdminPassword) {
    document.getElementById('admin-password').value = savedAdminPassword;
  }

  document.getElementById('admin-password').addEventListener('change', async (event) => {
    localStorage.setItem('easychat-admin-password', event.target.value);
    if (!event.target.value.trim()) return;
    try {
      await refreshPublicConfig();
      setStatus('鉴权成功，可开始使用', 'success');
    } catch (error) {
      setStatus(`鉴权失败：${error.message}`, 'error');
    }
  });

  document.getElementById('user-input')?.addEventListener('paste', handleUserInputPaste);
  updateImagePreview();

  try {
    if (!getAdminPassword()) {
      setStatus('请输入管理密码后开始使用', 'info');
      return;
    }

    await refreshPublicConfig();
    await loadSessionsFromServer();

    if (sessions.length === 0) {
      createNewChat();
    } else {
      renderHistoryList();
      if (!currentSessionId || !sessions.some((s) => s.id === currentSessionId)) {
        currentSessionId = sessions[0].id;
      }
      loadSession(currentSessionId);
    }
  } catch (error) {
    setStatus(`初始化失败：${error.message}`, 'error');
  }
}

window.toggleSidebar = toggleSidebar;
window.toggleDarkMode = toggleDarkMode;
window.clearAllData = clearAllData;
window.createNewChat = createNewChat;
window.deleteSession = deleteSession;
window.testConnection = testConnection;
window.loadAdminConfig = loadAdminConfig;
window.saveAdminConfig = saveAdminConfig;
window.addAdminPreset = addAdminPreset;
window.deleteAdminPreset = deleteAdminPreset;
window.setDefaultPreset = setDefaultPreset;
window.clearImageUrl = clearImageUrl;

window.onload = init;

document.getElementById('send-btn').onclick = handleSend;
document.getElementById('image-btn').onclick = handleImageGenerate;
document.getElementById('stop-btn').onclick = stopGeneration;
document.getElementById('user-input').oninput = function () {
  this.style.height = 'auto';
  this.style.height = `${this.scrollHeight}px`;
};
document.getElementById('user-input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};
