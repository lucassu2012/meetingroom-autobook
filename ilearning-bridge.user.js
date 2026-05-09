// ==UserScript==
// @name         iLearning 学习助手 (Stage 3 桥接版)
// @namespace    https://github.com/lucassu2012/
// @version      0.5.2
// @description  iLearning 习题页和 NotebookLM 联动: 开题自动出解析
// @author       Lucas
// @match        https://ilearning.huawei.com/iexam/*
// @match        https://notebooklm.google.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/ilearning-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/ilearning-bridge.user.js
// ==/UserScript==

// CHANGELOG
// v0.5.2 - 修复缓存抓错(排除user message区) + 加防错入库sanity check + 缓存优先 + 心跳容忍90s
// v0.5.1 - 修复 SPA 路由问题 (NotebookLM/iLearning 的客户端路由不刷新页面, 之前脚本错过初始化)
// v0.5.0 - Stage 3: 合并 iLearning + NotebookLM 双端, GM 存储桥接, 开题自动出解析

console.log('[ILH-BRIDGE] 🔔 脚本加载, hostname=', location.hostname, 'path=', location.pathname);

(function () {
  'use strict';

  /* ════════════════════════════════════════════════════════════
     🛡️  共享: Trusted Types policy (NotebookLM CSP 兼容)
     ════════════════════════════════════════════════════════════ */
  const __ttPolicy = (() => {
    if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
      try {
        return window.trustedTypes.createPolicy('ilh-bridge', { createHTML: (s) => s });
      } catch (e) {
        console.log('[ILH-BRIDGE] TT policy 创建失败, 使用 DOMParser fallback');
        return null;
      }
    }
    return null;
  })();

  function setSafeHTML(el, html) {
    if (__ttPolicy) {
      el.innerHTML = __ttPolicy.createHTML(html);
      return;
    }
    try {
      while (el.firstChild) el.removeChild(el.firstChild);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
    } catch (e) {
      el.textContent = '[渲染失败]';
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ════════════════════════════════════════════════════════════
     🌉  Bridge: GM 存储跨标签页通信
     ════════════════════════════════════════════════════════════ */
  const Bridge = {
    KEY_REQ: (id) => `ilh:request:${id}`,
    KEY_RESP: (id) => `ilh:response:${id}`,
    KEY_QUEUE: 'ilh:queue',
    KEY_STATUS: 'ilh:nlm_status', // NotebookLM 端用来报告自己活着

    /** iLearning 端: 发 request, 如已有缓存 response 则直接返回 */
    sendRequest(question) {
      const cached = GM_getValue(this.KEY_RESP(question.id), null);
      if (cached && cached.status === 'done') return cached;

      GM_setValue(this.KEY_REQ(question.id), {
        ...question,
        timestamp: Date.now(),
        status: 'pending',
      });
      const queue = GM_getValue(this.KEY_QUEUE, []);
      if (!queue.includes(question.id)) {
        queue.push(question.id);
        GM_setValue(this.KEY_QUEUE, queue);
      }
      return null;
    },

    /** iLearning 端: 监听 response 写入 */
    onResponse(qId, callback) {
      const listenerId = GM_addValueChangeListener(
        this.KEY_RESP(qId),
        (key, oldVal, newVal, remote) => {
          if (newVal && newVal.status === 'done') {
            GM_removeValueChangeListener(listenerId);
            callback(newVal);
          } else if (newVal && newVal.status === 'error') {
            GM_removeValueChangeListener(listenerId);
            callback(newVal);
          }
        }
      );
      return listenerId;
    },

    /** NotebookLM 端: 监听新 request */
    onRequest(callback) {
      // 监听队列变化(有新题进入队列时触发)
      const listenerId = GM_addValueChangeListener(
        this.KEY_QUEUE,
        (key, oldVal, newVal, remote) => {
          if (newVal && Array.isArray(newVal) && newVal.length > 0) {
            callback();
          }
        }
      );
      return listenerId;
    },

    /** NotebookLM 端: 取队首待处理 request */
    peekNextRequest() {
      const queue = GM_getValue(this.KEY_QUEUE, []);
      if (queue.length === 0) return null;
      const qId = queue[0];
      const req = GM_getValue(this.KEY_REQ(qId), null);
      // 如果该 request 已有 response 了, 跳过(应对边缘情况)
      const resp = GM_getValue(this.KEY_RESP(qId), null);
      if (resp && resp.status === 'done') {
        // 从队列移除
        const newQueue = queue.slice(1);
        GM_setValue(this.KEY_QUEUE, newQueue);
        return this.peekNextRequest();
      }
      return req;
    },

    /** NotebookLM 端: 写 response, 从队列移除该题 */
    writeResponse(qId, text, status = 'done', error = null) {
      GM_setValue(this.KEY_RESP(qId), {
        id: qId,
        text,
        status,
        error,
        timestamp: Date.now(),
      });
      const queue = GM_getValue(this.KEY_QUEUE, []);
      GM_setValue(this.KEY_QUEUE, queue.filter((id) => id !== qId));
    },

    /** NotebookLM 端: 报告心跳(我活着) */
    reportAlive() {
      GM_setValue(this.KEY_STATUS, { alive: true, timestamp: Date.now() });
    },

    /** iLearning 端: 检查 NotebookLM 是否活着 (10 秒内有心跳) */
    isNotebookLMAlive() {
      const status = GM_getValue(this.KEY_STATUS, null);
      if (!status || !status.alive) return false;
      // v0.5.2: 90 秒容忍, 应对 Chrome 后台标签页 setInterval 节流
      return (Date.now() - status.timestamp) < 90000;
    },

    /** 调试: 列出所有 ilh:* keys */
    listAllKeys() {
      return GM_listValues().filter((k) => k.startsWith('ilh:'));
    },

    /** 清空所有 bridge 数据(调试用) */
    clearAll() {
      this.listAllKeys().forEach((k) => GM_deleteValue(k));
    },
  };

  /* ════════════════════════════════════════════════════════════
     🚦  路由分发 (含 SPA 路由监听 - v0.5.1)
     iLearning 和 NotebookLM 都是 SPA, 客户端路由切换不刷新页面.
     脚本必须监听 pushState/replaceState/popstate, 路径变成期望模式时再初始化.
     ════════════════════════════════════════════════════════════ */
  function watchForRoute(matcher, label, callback) {
    let initialized = false;
    function check() {
      if (initialized) return;
      const match = matcher instanceof RegExp
        ? matcher.test(location.pathname)
        : location.pathname.includes(matcher);
      if (match) {
        initialized = true;
        console.log(`[ILH-BRIDGE] ✅ 路由匹配 ${label}, 初始化中... (path=${location.pathname})`);
        try { callback(); } catch (e) { console.error('[ILH-BRIDGE] 初始化失败:', e); }
      }
    }
    // 拦截 history API
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function () { orig.apply(this, arguments); check(); };
    });
    window.addEventListener('popstate', check);
    // 兜底: 1.5 秒轮询(防 SPA 用了非标准的路由方式)
    const intervalId = setInterval(() => {
      check();
      if (initialized) clearInterval(intervalId);
    }, 1500);
    // 立即检查一次
    check();
  }

  if (location.hostname === 'ilearning.huawei.com') {
    console.log('[ILH-BRIDGE] iLearning 域, 等待答题页路由...');
    watchForRoute(/\/examContent/, 'iLearning examContent', initILearning);
  } else if (location.hostname === 'notebooklm.google.com') {
    console.log('[ILH-BRIDGE] NotebookLM 域, 等待笔记本页路由...');
    watchForRoute(/^\/notebook\//, 'NotebookLM /notebook/', initNotebookLM);
  }

  /* ════════════════════════════════════════════════════════════
     📚  iLearning 端
     ════════════════════════════════════════════════════════════ */
  function initILearning() {
    const VERSION = '0.5.0';
    const STAGE = 'Stage 3';

    const CONFIG = {
      extractDebounceMs: 300,
      minStemLength: 4,
      logMaxLines: 80,
      panelWidth: 420,
      panelMaxHeight: 780,
      requestTimeoutMs: 90000, // 90 秒等不到响应就报错
      nlmCheckIntervalMs: 5000, // 每 5s 检查 NotebookLM 心跳
    };

    const state = {
      currentQuestion: null,
      lastQuestionId: null,
      panelCollapsed: false,
      logCollapsed: false,
      activeListeners: new Map(), // qId -> listenerId
    };

    // === STYLES ===
    GM_addStyle(`
      #ilh-panel {
        position: fixed; bottom: 24px; right: 24px;
        width: ${CONFIG.panelWidth}px;
        max-height: ${CONFIG.panelMaxHeight}px;
        background: linear-gradient(135deg, #1a1d2e 0%, #232842 100%);
        color: #e8eaf6;
        font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
        z-index: 2147483646;
        overflow: hidden;
        display: flex; flex-direction: column;
        transition: max-height 0.25s ease;
      }
      #ilh-panel.collapsed { max-height: 44px; }
      #ilh-header {
        padding: 11px 14px;
        background: rgba(0,0,0,0.28);
        display: flex; align-items: center; gap: 8px;
        cursor: move;
        user-select: none;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .ilh-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #4caf50;
        box-shadow: 0 0 8px #4caf50;
      }
      .ilh-dot.idle { background: #888; box-shadow: none; }
      .ilh-dot.error { background: #f44336; box-shadow: 0 0 8px #f44336; }
      .ilh-dot.warn  { background: #ff9800; box-shadow: 0 0 8px #ff9800; }
      .ilh-dot.busy { background: #2196f3; box-shadow: 0 0 8px #2196f3; animation: ilh-pulse 1.2s infinite; }
      @keyframes ilh-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

      .ilh-title { flex: 1; font-weight: 600; letter-spacing: 0.3px; }
      .ilh-stage {
        font-size: 10px; opacity: 0.65;
        padding: 2px 7px;
        background: rgba(255,255,255,0.07);
        border-radius: 4px;
      }
      .ilh-toggle {
        cursor: pointer; padding: 2px 6px;
        opacity: 0.5; transition: opacity 0.15s;
        font-family: monospace;
      }
      .ilh-toggle:hover { opacity: 1; }

      #ilh-status {
        padding: 11px 14px;
        font-weight: 500;
        border-left: 3px solid #4caf50;
        background: rgba(76,175,80,0.08);
      }
      #ilh-status.error { border-left-color: #f44336; background: rgba(244,67,54,0.08); }
      #ilh-status.idle  { border-left-color: #666;    background: rgba(255,255,255,0.03); opacity: 0.75; }
      #ilh-status.warn  { border-left-color: #ff9800; background: rgba(255,152,0,0.08); }
      #ilh-status.busy  { border-left-color: #2196f3; background: rgba(33,150,243,0.08); }

      #ilh-question {
        padding: 12px 14px;
        overflow-y: auto;
        max-height: 280px;
      }
      .ilh-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
      .ilh-pill {
        padding: 3px 9px; border-radius: 11px;
        font-size: 11px; font-weight: 500;
        background: rgba(33,150,243,0.18); color: #64b5f6;
      }
      .ilh-pill.position { background: rgba(255,193,7,0.18); color: #ffd54f; }
      .ilh-stem {
        font-size: 13px; line-height: 1.6;
        margin-bottom: 12px; padding: 10px 12px;
        background: rgba(255,255,255,0.04);
        border-radius: 6px;
        white-space: pre-wrap; word-break: break-word;
      }
      .ilh-options { display: flex; flex-direction: column; gap: 5px; }
      .ilh-option {
        padding: 7px 10px;
        background: rgba(255,255,255,0.03);
        border-left: 2px solid rgba(100,181,246,0.45);
        border-radius: 4px;
        font-size: 12px; line-height: 1.5;
        word-break: break-word;
      }
      .ilh-option-letter { font-weight: 600; color: #64b5f6; margin-right: 6px; }

      #ilh-explain {
        border-top: 1px solid rgba(255,255,255,0.06);
        padding: 12px 14px;
      }
      .ilh-explain-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px;
        font-size: 12px; font-weight: 500;
      }
      .ilh-explain-status {
        font-size: 11px; opacity: 0.7;
      }
      .ilh-explain-content {
        padding: 10px 12px;
        background: rgba(76,175,80,0.06);
        border-left: 2px solid #4caf50;
        border-radius: 4px;
        font-size: 12px; line-height: 1.65;
        white-space: pre-wrap; word-break: break-word;
        max-height: 220px;
        overflow-y: auto;
      }
      .ilh-explain-content.waiting {
        border-left-color: #2196f3;
        background: rgba(33,150,243,0.06);
        color: #90caf9;
        font-style: italic;
      }
      .ilh-explain-content.error {
        border-left-color: #f44336;
        background: rgba(244,67,54,0.08);
        color: #ef9a9a;
      }
      .ilh-explain-actions {
        display: flex; gap: 6px;
        margin-top: 8px;
      }
      .ilh-mini-btn {
        padding: 4px 8px;
        background: rgba(255,255,255,0.06);
        color: #e8eaf6;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 4px;
        font-size: 10px;
        cursor: pointer;
      }
      .ilh-mini-btn:hover { background: rgba(255,255,255,0.13); }

      #ilh-log-section {
        border-top: 1px solid rgba(255,255,255,0.06);
        display: flex; flex-direction: column;
      }
      #ilh-log-header {
        padding: 7px 14px;
        font-size: 11px; opacity: 0.7;
        cursor: pointer;
        display: flex; justify-content: space-between;
        user-select: none;
      }
      #ilh-log-header:hover { opacity: 1; }
      #ilh-log {
        padding: 0 14px 10px;
        overflow-y: auto;
        font-size: 11px;
        font-family: "SF Mono", Monaco, Consolas, monospace;
        line-height: 1.55;
        max-height: 130px;
      }
      #ilh-log.collapsed { display: none; }
      .ilh-log-entry { margin-bottom: 1px; opacity: 0.9; }
      .ilh-log-info    { color: #90caf9; }
      .ilh-log-success { color: #81c784; }
      .ilh-log-warn    { color: #ffb74d; }
      .ilh-log-error   { color: #e57373; }
      .ilh-log-debug   { color: #b0bec5; opacity: 0.7; }
      .ilh-log-time    { opacity: 0.4; margin-right: 6px; }

      #ilh-empty {
        padding: 32px 14px; text-align: center;
        opacity: 0.55; font-size: 12px; line-height: 1.7;
      }
      #ilh-empty .ilh-hint {
        font-size: 10px; opacity: 0.7;
        display: block; margin-top: 6px;
      }
    `);

    // === LOG ===
    function log(msg, type = 'info') {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const logEl = document.getElementById('ilh-log');
      if (logEl) {
        const entry = document.createElement('div');
        entry.className = `ilh-log-entry ilh-log-${type}`;
        setSafeHTML(entry, `<span class="ilh-log-time">${time}</span>${escapeHtml(msg)}`);
        logEl.appendChild(entry);
        while (logEl.children.length > CONFIG.logMaxLines) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
      console.log(`[ILH ${time}] ${msg}`);
    }

    // === EXTRACTION (Stage 1 已验证) ===
    function extractQuestion() {
      try {
        const positionInfo = findPosition();
        if (!positionInfo) return null;
        const questionType = findQuestionType();
        const stem = findStem(positionInfo.position);
        if (!stem || stem.length < CONFIG.minStemLength) return null;
        const options = findOptions();
        const id = `q${positionInfo.position}_${hashString(stem.substring(0, 60))}`;
        return {
          id, type: questionType,
          position: positionInfo.position,
          total: positionInfo.total,
          stem, options,
          extractedAt: Date.now(),
        };
      } catch (e) {
        log(`❌ 抽取异常: ${e.message}`, 'error');
        return null;
      }
    }

    function findPosition() {
      const re = /第\s*(\d+)\s*\/\s*(\d+)\s*题/;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.length > 200) continue;
        const m = node.textContent.match(re);
        if (m) return { position: parseInt(m[1], 10), total: parseInt(m[2], 10) };
      }
      return null;
    }

    function findQuestionType() {
      const types = ['单选题', '多选题', '判断题'];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (t.length > 5) continue;
        for (const tp of types) if (t === tp) return tp;
      }
      return '未知题型';
    }

    function findStem(expectedPosition) {
      const stemStartRe = new RegExp(`^\\s*${expectedPosition}\\s*[、\\.,，]\\s*(.+)`, 's');
      const els = document.body.querySelectorAll('div, p, span, h1, h2, h3, h4, label, section, article');
      let best = null;
      for (const el of els) {
        if (el.closest('#ilh-panel')) continue;
        const text = el.textContent.trim();
        if (text.length < CONFIG.minStemLength || text.length > 3000) continue;
        const m = text.match(stemStartRe);
        if (!m) continue;
        const beforeOpts = m[1].split(/\s*\n?\s*[A-Z]\s*[\.、,，]\s/)[0].trim();
        if (beforeOpts.length < CONFIG.minStemLength) continue;
        if (!best || beforeOpts.length < best.length) best = beforeOpts;
      }
      return best;
    }

    function findOptions() {
      const optRe = /^\s*([A-Z])\s*[\.、,，]\s*(.+)/s;
      let opts = extractOptionsFromContainers('[class*="option-list-item"], [class*="option-item"]', optRe);
      if (opts.length > 0) return opts;
      opts = extractOptionsFromContainers('[class*="option-content"]', optRe);
      if (opts.length > 0) return opts;
      // C 兜底: TreeWalker
      const seen = new Set();
      opts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text.length === 0 || text.length > 600) continue;
        const m = text.match(optRe);
        if (m && !seen.has(m[1]) && m[2].trim().length > 0) {
          seen.add(m[1]);
          opts.push({ letter: m[1], content: m[2].trim() });
        }
      }
      opts.sort((a, b) => a.letter.localeCompare(b.letter));
      return opts;
    }

    function extractOptionsFromContainers(selector, optRe) {
      const items = document.querySelectorAll(selector);
      const opts = [];
      const seen = new Set();
      for (const item of items) {
        if (item.closest('#ilh-panel')) continue;
        const text = item.textContent.replace(/\s+/g, ' ').trim();
        if (!text || text.length > 800) continue;
        const m = text.match(optRe);
        if (m && !seen.has(m[1]) && m[2].trim().length > 0 && m[2].trim().length < 800) {
          seen.add(m[1]);
          opts.push({ letter: m[1], content: m[2].trim() });
        }
      }
      opts.sort((a, b) => a.letter.localeCompare(b.letter));
      return opts;
    }

    function hashString(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return Math.abs(h).toString(36);
    }

    // === UI ===
    function buildPanel() {
      const panel = document.createElement('div');
      panel.id = 'ilh-panel';
      setSafeHTML(panel, `
        <div id="ilh-header">
          <span class="ilh-dot idle"></span>
          <span class="ilh-title">📚 学习助手</span>
          <span class="ilh-stage">${STAGE}</span>
          <span class="ilh-toggle" id="ilh-toggle-panel" title="折叠/展开">━</span>
        </div>
        <div id="ilh-status" class="idle">⏸ 等待识别题目...</div>
        <div id="ilh-question">
          <div id="ilh-empty">尚未识别到题目<span class="ilh-hint">切换到任意题目即可触发抽取</span></div>
        </div>
        <div id="ilh-explain" style="display:none">
          <div class="ilh-explain-header">
            <span>💡 <span id="ilh-explain-title">解析</span></span>
            <span class="ilh-explain-status" id="ilh-explain-status"></span>
          </div>
          <div class="ilh-explain-content" id="ilh-explain-content"></div>
          <div class="ilh-explain-actions">
            <button class="ilh-mini-btn" id="ilh-btn-copy-explain">📋 复制解析</button>
            <button class="ilh-mini-btn" id="ilh-btn-redo">🔄 重新请求</button>
          </div>
        </div>
        <div id="ilh-log-section">
          <div id="ilh-log-header">
            <span>📝 调试日志</span>
            <span id="ilh-log-toggle">▼</span>
          </div>
          <div id="ilh-log"></div>
        </div>
      `);
      document.body.appendChild(panel);

      document.getElementById('ilh-toggle-panel').addEventListener('click', () => {
        state.panelCollapsed = !state.panelCollapsed;
        panel.classList.toggle('collapsed', state.panelCollapsed);
      });
      document.getElementById('ilh-log-header').addEventListener('click', () => {
        state.logCollapsed = !state.logCollapsed;
        document.getElementById('ilh-log').classList.toggle('collapsed', state.logCollapsed);
        document.getElementById('ilh-log-toggle').textContent = state.logCollapsed ? '▶' : '▼';
      });
      document.getElementById('ilh-btn-copy-explain').addEventListener('click', () => {
        const el = document.getElementById('ilh-explain-content');
        if (!el || !el.textContent) return log('⚠️ 暂无解析可复制', 'warn');
        navigator.clipboard.writeText(el.textContent).then(
          () => log('✅ 解析已复制', 'success'),
          (e) => log(`❌ 复制失败: ${e.message}`, 'error')
        );
      });
      document.getElementById('ilh-btn-redo').addEventListener('click', () => {
        if (!state.currentQuestion) return;
        // 删除缓存, 重新请求
        GM_deleteValue(`ilh:response:${state.currentQuestion.id}`);
        log(`🔄 已清除 ${state.currentQuestion.id} 的缓存解析, 重新请求`, 'info');
        requestExplanation(state.currentQuestion);
      });

      makeDraggable(panel, document.getElementById('ilh-header'));
    }

    function makeDraggable(el, handle) {
      let dragging = false, dx = 0, dy = 0;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        dx = e.clientX - el.offsetLeft;
        dy = e.clientY - el.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        el.style.left = (e.clientX - dx) + 'px';
        el.style.top = (e.clientY - dy) + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    }

    function setStatus(level, text) {
      const sEl = document.getElementById('ilh-status');
      if (!sEl) return;
      sEl.className = level || '';
      sEl.textContent = text;
      const dot = document.querySelector('#ilh-header .ilh-dot');
      if (dot) dot.className = 'ilh-dot' + (level ? ' ' + level : '');
    }

    function renderQuestion(q) {
      const c = document.getElementById('ilh-question');
      if (!c) return;
      const optionsHtml = q.options.length > 0
        ? `<div class="ilh-options">${q.options.map((o) => `
             <div class="ilh-option"><span class="ilh-option-letter">${escapeHtml(o.letter)}.</span>${escapeHtml(o.content)}</div>
           `).join('')}</div>`
        : (q.type === '判断题'
          ? '<div style="opacity:0.6;font-size:11px">(判断题无选项)</div>'
          : '<div style="opacity:0.5;font-size:11px;color:#ffb74d">⚠️ 未识别到选项</div>');
      setSafeHTML(c, `
        <div class="ilh-meta">
          <span class="ilh-pill">${escapeHtml(q.type)}</span>
          <span class="ilh-pill position">第 ${q.position}/${q.total} 题</span>
        </div>
        <div class="ilh-stem">${escapeHtml(q.stem)}</div>
        ${optionsHtml}
      `);
    }

    function showExplain(state, content = '', statusText = '') {
      const wrap = document.getElementById('ilh-explain');
      const contentEl = document.getElementById('ilh-explain-content');
      const statusEl = document.getElementById('ilh-explain-status');
      if (!wrap) return;
      wrap.style.display = 'block';
      contentEl.className = 'ilh-explain-content ' + (state || '');
      contentEl.textContent = content;
      statusEl.textContent = statusText;
    }

    function hideExplain() {
      const wrap = document.getElementById('ilh-explain');
      if (wrap) wrap.style.display = 'none';
    }

    // === 题目识别 + Bridge 发请求 ===
    let extractTimer = null;
    function handleQuestionChange(force = false) {
      clearTimeout(extractTimer);
      extractTimer = setTimeout(() => {
        const q = extractQuestion();
        if (!q) {
          if (force || state.lastQuestionId === null) {
            setStatus('error', '⚠️ 题目识别失败');
          }
          return;
        }
        if (!force && state.lastQuestionId === q.id) return;

        // 取消上一题的监听器(如果有)
        if (state.lastQuestionId && state.activeListeners.has(state.lastQuestionId)) {
          GM_removeValueChangeListener(state.activeListeners.get(state.lastQuestionId));
          state.activeListeners.delete(state.lastQuestionId);
        }

        state.currentQuestion = q;
        state.lastQuestionId = q.id;
        renderQuestion(q);
        setStatus('', `✅ 第 ${q.position}/${q.total} 题已识别 · ${q.type}`);
        requestExplanation(q);
      }, CONFIG.extractDebounceMs);
    }

    function requestExplanation(q) {
      // v0.5.2: 缓存优先(命中就秒回, 不依赖 NotebookLM 活跃状态)
      const cached = GM_getValue(`ilh:response:${q.id}`, null);
      if (cached && cached.status === 'done') {
        showExplain('', cached.text, '✅ 缓存命中 · 秒回');
        log(`💾 缓存命中: ${q.id}`, 'success');
        return;
      }
      if (cached && cached.status === 'error') {
        showExplain('error', cached.error || '上次请求失败 · 点"重新请求"重试', '上次失败');
        log(`⚠️ 缓存的错误响应, 不重试 (用户可手动重试)`, 'warn');
        return;
      }

      // 没缓存才检查 NotebookLM 活动
      if (!Bridge.isNotebookLMAlive()) {
        showExplain('error', '⚠️ 没检测到 NotebookLM 活动\n\n请确认你已经在另一个标签页打开了对应的 NotebookLM 笔记本, 并且本脚本也加载了它。\n\n(如果 NotebookLM 标签页一直在后台, Chrome 会节流脚本,可以切到 NotebookLM 标签页激活一下)', '');
        log('❌ NotebookLM 心跳缺失, 提示用户检查', 'error');
        return;
      }

      // 发新 request
      Bridge.sendRequest(q);
      const startTs = Date.now();
      showExplain('waiting', '⏳ 已发送给 NotebookLM, 通常需要 10-30 秒...', '排队中');
      log(`📤 发出 request: ${q.id} (题号 ${q.position})`, 'info');

      // 监听响应
      const listenerId = Bridge.onResponse(q.id, (resp) => {
        // 只在还是当前题目时才更新 UI
        if (state.currentQuestion && state.currentQuestion.id === q.id) {
          if (resp.status === 'done') {
            const elapsed = Math.round((Date.now() - startTs) / 1000);
            showExplain('', resp.text, `✅ 已完成 · ${elapsed}秒 · ${resp.text.length}字`);
            log(`✅ 收到解析: ${q.id}, ${resp.text.length} 字符`, 'success');
          } else {
            showExplain('error', resp.error || '处理失败', '失败');
            log(`❌ 解析失败: ${resp.error}`, 'error');
          }
        }
        state.activeListeners.delete(q.id);
      });
      state.activeListeners.set(q.id, listenerId);

      // 超时检查
      setTimeout(() => {
        const r = GM_getValue(`ilh:response:${q.id}`, null);
        if (!r) {
          if (state.currentQuestion && state.currentQuestion.id === q.id) {
            const stillAlive = Bridge.isNotebookLMAlive();
            showExplain('error', stillAlive
              ? '⏱️ 超过 90 秒没收到响应。NotebookLM 可能还在思考(看 NotebookLM 浮窗确认), 或抓取失败。'
              : '⚠️ NotebookLM 失联了。请检查标签页是否被关闭/卡死。', '超时');
            log(`⏱️ ${q.id} 超时`, 'error');
          }
        }
      }, CONFIG.requestTimeoutMs);
    }

    // === MutationObserver ===
    function setupObserver() {
      const observer = new MutationObserver(() => handleQuestionChange());
      observer.observe(document.body, { childList: true, subtree: true });
      log('👀 MutationObserver 已启动', 'info');
    }

    // === INIT ===
    buildPanel();
    log(`✅ iLearning 端 v${VERSION} 已加载`, 'success');
    log(`🎯 当前阶段: ${STAGE} (开题自动出解析)`, 'info');

    setTimeout(() => handleQuestionChange(true), 800);
    setupObserver();

    // 定期提示用户 NotebookLM 状态(只在还没识别到题时)
    setInterval(() => {
      if (state.currentQuestion) return;
      const alive = Bridge.isNotebookLMAlive();
      const dot = document.querySelector('#ilh-header .ilh-dot');
      if (dot && !state.currentQuestion) {
        dot.className = 'ilh-dot' + (alive ? ' idle' : ' warn');
      }
    }, CONFIG.nlmCheckIntervalMs);
  }

  /* ════════════════════════════════════════════════════════════
     📓  NotebookLM 端
     ════════════════════════════════════════════════════════════ */
  function initNotebookLM() {
    const VERSION = '0.5.0';
    const STAGE = 'Stage 3';

    const CONFIG = {
      submitWaitMs: 600,
      responseInitialDelayMs: 1500,
      pollIntervalMs: 500,
      silenceTimeoutMs: 5000,
      maxResponseWaitMs: 180000,
      minResponseChars: 150,
      heartbeatIntervalMs: 3000,
      panelWidth: 420,
      panelMaxHeight: 720,
      logMaxLines: 100,
    };

    const state = {
      busy: false,
      panelCollapsed: false,
      logCollapsed: false,
      processedCount: 0,
      currentRequest: null,
    };

    GM_addStyle(`
      #nlh-panel {
        position: fixed; bottom: 24px; right: 24px;
        width: ${CONFIG.panelWidth}px;
        max-height: ${CONFIG.panelMaxHeight}px;
        background: linear-gradient(135deg, #1a2e2a 0%, #1f3a3f 100%);
        color: #e0f2f1;
        font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
        font-size: 13px;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
        z-index: 2147483646;
        overflow: hidden;
        display: flex; flex-direction: column;
      }
      #nlh-panel.collapsed { max-height: 44px; }
      #nlh-header {
        padding: 11px 14px;
        background: rgba(0,0,0,0.28);
        display: flex; align-items: center; gap: 8px;
        cursor: move;
        user-select: none;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .nlh-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #26a69a;
        box-shadow: 0 0 8px #26a69a;
      }
      .nlh-dot.idle { background: #888; box-shadow: none; }
      .nlh-dot.busy { background: #ffb300; box-shadow: 0 0 8px #ffb300; animation: nlh-pulse 1.2s infinite; }
      .nlh-dot.error { background: #f44336; box-shadow: 0 0 8px #f44336; }
      @keyframes nlh-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      .nlh-title { flex: 1; font-weight: 600; }
      .nlh-stage {
        font-size: 10px; opacity: 0.65;
        padding: 2px 7px;
        background: rgba(255,255,255,0.07);
        border-radius: 4px;
      }
      .nlh-toggle { cursor: pointer; padding: 2px 6px; opacity: 0.5; font-family: monospace; }
      .nlh-toggle:hover { opacity: 1; }

      #nlh-status {
        padding: 11px 14px;
        font-weight: 500;
        border-left: 3px solid #26a69a;
        background: rgba(38,166,154,0.10);
      }
      #nlh-status.idle  { border-left-color: #666; background: rgba(255,255,255,0.03); opacity: 0.75; }
      #nlh-status.busy  { border-left-color: #ffb300; background: rgba(255,179,0,0.10); }
      #nlh-status.error { border-left-color: #f44336; background: rgba(244,67,54,0.10); }

      #nlh-stats {
        padding: 10px 14px;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .nlh-stat {
        text-align: center;
        padding: 6px;
        background: rgba(255,255,255,0.03);
        border-radius: 4px;
      }
      .nlh-stat-num {
        font-size: 18px; font-weight: 600; color: #80cbc4;
      }
      .nlh-stat-label {
        font-size: 10px; opacity: 0.7;
        text-transform: uppercase;
      }

      #nlh-current {
        padding: 12px 14px;
        max-height: 200px;
        overflow-y: auto;
      }
      .nlh-current-title {
        font-size: 11px; opacity: 0.7;
        margin-bottom: 6px;
      }
      .nlh-current-content {
        font-size: 12px; line-height: 1.5;
        padding: 8px 10px;
        background: rgba(255,255,255,0.04);
        border-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 130px;
        overflow-y: auto;
      }

      #nlh-actions {
        display: flex; gap: 6px;
        padding: 0 14px 10px;
      }
      .nlh-btn {
        flex: 1;
        padding: 6px 10px;
        background: rgba(255,255,255,0.06);
        color: #e0f2f1;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 5px;
        font-size: 11px;
        cursor: pointer;
      }
      .nlh-btn:hover:not(:disabled) { background: rgba(255,255,255,0.13); }
      .nlh-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      #nlh-log-section {
        border-top: 1px solid rgba(255,255,255,0.06);
        display: flex; flex-direction: column;
      }
      #nlh-log-header {
        padding: 7px 14px;
        font-size: 11px; opacity: 0.7;
        cursor: pointer;
        display: flex; justify-content: space-between;
        user-select: none;
      }
      #nlh-log-header:hover { opacity: 1; }
      #nlh-log {
        padding: 0 14px 10px;
        overflow-y: auto;
        font-size: 11px;
        font-family: "SF Mono", Monaco, Consolas, monospace;
        line-height: 1.55;
        max-height: 140px;
      }
      #nlh-log.collapsed { display: none; }
      .nlh-log-entry { margin-bottom: 1px; opacity: 0.92; }
      .nlh-log-info    { color: #80cbc4; }
      .nlh-log-success { color: #a5d6a7; }
      .nlh-log-warn    { color: #ffcc80; }
      .nlh-log-error   { color: #ef9a9a; }
      .nlh-log-debug   { color: #b0bec5; opacity: 0.7; }
      .nlh-log-time    { opacity: 0.4; margin-right: 6px; }
    `);

    function log(msg, type = 'info') {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const logEl = document.getElementById('nlh-log');
      if (logEl) {
        const entry = document.createElement('div');
        entry.className = `nlh-log-entry nlh-log-${type}`;
        setSafeHTML(entry, `<span class="nlh-log-time">${time}</span>${escapeHtml(msg)}`);
        logEl.appendChild(entry);
        while (logEl.children.length > CONFIG.logMaxLines) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
      console.log(`[NLH ${time}] ${msg}`);
    }

    // === 元素查找 (Stage 2 已验证, 排除自己浮窗) ===
    function isVisible(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    }

    function describeEl(el) {
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
      const aria = el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '';
      return `${tag}${cls}${aria}`;
    }

    function findInputElement() {
      const candidates = [];
      document.querySelectorAll('textarea').forEach((el) => {
        if (el.closest('#nlh-panel')) return;
        if (isVisible(el) && !el.disabled && !el.readOnly) {
          const r = el.getBoundingClientRect();
          candidates.push({ el, score: r.width * r.height + 100 });
        }
      });
      document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
        if (el.closest('#nlh-panel')) return;
        if (isVisible(el)) {
          const r = el.getBoundingClientRect();
          candidates.push({ el, score: r.width * r.height });
        }
      });
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0].el;
    }

    function findSubmitButton(inputEl) {
      if (!inputEl) return null;
      const inputRect = inputEl.getBoundingClientRect();
      const inputCenterY = (inputRect.top + inputRect.bottom) / 2;
      const BLACKLIST = [
        '收起', '展开', '关闭', '打开', 'studio', '面板', 'panel',
        'collapse', 'expand', 'close', 'open', 'sidebar', 'menu',
        '设置', 'settings', '帮助', 'help', '更多', 'more', '选项',
        '分享', 'share', '创建', 'create', '保存', 'save',
        '复制', 'copy', '粘贴', 'paste', '撤销', 'undo',
        'thumb_up', 'thumb_down', '点赞', '点踩', 'like', 'dislike',
      ];
      const POSITIVE = ['send', 'submit', '发送', '提交', 'arrow_upward', 'arrow_forward'];
      const getBtnText = (btn) =>
        ((btn.getAttribute('aria-label') || '') + ' ' +
         (btn.getAttribute('title') || '') + ' ' +
         btn.textContent).toLowerCase();
      const isBlk = (btn) => BLACKLIST.some((kw) => getBtnText(btn).includes(kw));
      const isPos = (btn) => POSITIVE.some((kw) => getBtnText(btn).includes(kw));

      const candidates = [];
      document.querySelectorAll('button, [role="button"]').forEach((btn) => {
        if (btn.closest('#nlh-panel')) return;
        if (!isVisible(btn)) return;
        if (isBlk(btn)) return;
        const r = btn.getBoundingClientRect();
        const verticalDist = Math.abs((r.top + r.bottom) / 2 - inputCenterY);
        if (verticalDist > 120) return;
        const horizontalGap = r.left - inputRect.right;
        if (horizontalGap < -200 || horizontalGap > 200) return;
        let score = verticalDist + Math.abs(horizontalGap);
        if (isPos(btn)) score -= 1000;
        if (btn.disabled) score += 100;
        candidates.push({ btn, score });
      });
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0].btn;
    }

    // === 输入注入 (execCommand 主路) ===
    async function setInputValue(el, text) {
      el.focus();
      await sleep(80);
      const tag = el.tagName.toLowerCase();
      try {
        if (tag === 'textarea' || tag === 'input') el.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('delete');
        const ok = document.execCommand('insertText', false, text);
        const current = (tag === 'textarea' || tag === 'input') ? el.value : el.textContent;
        if (ok && current && current.trim().length >= Math.floor(text.trim().length * 0.9)) {
          return true;
        }
      } catch (e) { /* fall through */ }
      // Fallback
      if (tag === 'textarea' || tag === 'input') {
        const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      }
      return true;
    }

    function readInputValue(el) {
      const tag = el.tagName.toLowerCase();
      return (tag === 'textarea' || tag === 'input') ? (el.value || '') : (el.textContent || '');
    }

    function pressEnter(el) {
      el.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    async function submitMessage(inputEl) {
      const beforeValue = readInputValue(inputEl).trim();
      pressEnter(inputEl);
      await sleep(800);
      const afterValue = readInputValue(inputEl).trim();
      if (beforeValue && afterValue !== beforeValue) {
        log('  ✅ Enter 提交成功', 'success');
        return 'enter';
      }
      log('  ⚠️ Enter 没用, 尝试按钮', 'warn');
      let btn = null;
      for (let i = 0; i < 5; i++) {
        btn = findSubmitButton(inputEl);
        if (btn && !btn.disabled) break;
        await sleep(400);
      }
      if (btn) {
        btn.click();
        await sleep(800);
        log(`  🖱 点击按钮: ${describeEl(btn)}`, 'success');
        return 'button';
      }
      return null;
    }

    // === 响应捕获 (Stage 2 验证) ===
    function snapshotPageText() {
      const map = new Map();
      document.querySelectorAll('div, p, article, section, main, span').forEach((el) => {
        const len = el.textContent.length;
        if (len > 30) map.set(el, len);
      });
      return map;
    }

    function findGrowingResponseElement(snapshot, questionText, excludedNodes) {
      const candidates = [];
      document.querySelectorAll('div, p, article, section, main, span').forEach((el) => {
        if (el.closest('#nlh-panel')) return;
        if (excludedNodes && excludedNodes.has(el)) return; // v0.5.2: 排除 user message 树
        const newLen = el.textContent.length;
        const oldLen = snapshot.get(el) || 0;
        const growth = newLen - oldLen;
        if (growth < CONFIG.minResponseChars) return;
        const text = el.textContent;
        if (questionText && text.includes(questionText.substring(0, Math.min(40, questionText.length)))) {
          if (growth < questionText.length + CONFIG.minResponseChars) return;
        }
        let depth = 0;
        let p = el;
        while (p && p !== document.body) { depth++; p = p.parentElement; }
        candidates.push({ el, growth, depth });
      });
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => (b.depth - a.depth) || (b.growth - a.growth));
      return candidates[0].el;
    }

    async function waitForResponse(snapshot, questionText, excludedNodes) {
      const startTs = Date.now();
      let lastLen = 0;
      let lastChangeTs = Date.now();
      let responseEl = null;
      while (Date.now() - startTs < CONFIG.maxResponseWaitMs) {
        await sleep(CONFIG.pollIntervalMs);
        const currentEl = findGrowingResponseElement(snapshot, questionText, excludedNodes);
        if (currentEl) {
          responseEl = currentEl;
          const currentLen = currentEl.textContent.length;
          if (currentLen > lastLen) {
            lastLen = currentLen;
            lastChangeTs = Date.now();
          }
        }
        if (lastLen > CONFIG.minResponseChars && (Date.now() - lastChangeTs) > CONFIG.silenceTimeoutMs) {
          return responseEl ? responseEl.textContent.trim() : null;
        }
      }
      return responseEl ? responseEl.textContent.trim() : null;
    }

    // === 处理一道题 ===
    async function processOneRequest(req) {
      state.busy = true;
      state.currentRequest = req;
      setStatus('busy', `⏳ 处理 第 ${req.position}/${req.total} 题...`);
      updateCurrent(req);
      log(`📥 接到题目 ${req.id} (第 ${req.position} 题)`, 'info');

      try {
        const text = formatQuestionForNLM(req);

        // 1. 找输入框
        const inputEl = findInputElement();
        if (!inputEl) {
          log('❌ 未找到 NotebookLM 输入框', 'error');
          Bridge.writeResponse(req.id, '', 'error', '找不到 NotebookLM 输入框');
          return;
        }

        // 2. 输入题目
        await setInputValue(inputEl, text);
        await sleep(CONFIG.submitWaitMs);

        // 3. 拍快照
        const snapshot = snapshotPageText();

        // 4. 提交
        const method = await submitMessage(inputEl);
        if (!method) {
          log('❌ 提交失败', 'error');
          Bridge.writeResponse(req.id, '', 'error', '提交失败');
          return;
        }
        await sleep(CONFIG.responseInitialDelayMs);

        // 4.5. v0.5.2: 识别 user message 区域并加入排除集
        // 提交后, NotebookLM 会先把用户消息显示在对话区, 我们要确保不抓到它
        const userMsgEl = findUserMessageElement(text);
        const excludedNodes = new Set();
        if (userMsgEl) {
          log(`  └ 识别到 user message: ${describeEl(userMsgEl)}`, 'debug');
          // 自己 + 所有祖先 + 所有后代加入排除
          let p = userMsgEl;
          while (p && p !== document.body) { excludedNodes.add(p); p = p.parentElement; }
          userMsgEl.querySelectorAll('*').forEach((c) => excludedNodes.add(c));
        } else {
          log('  ⚠️ 未识别到 user message, 用旧的过滤逻辑', 'warn');
        }

        // 5. 等响应
        const responseText = await waitForResponse(snapshot, text, excludedNodes);
        if (!responseText || responseText.length < CONFIG.minResponseChars) {
          log(`❌ 响应过短 (${responseText?.length || 0} 字符)`, 'error');
          Bridge.writeResponse(req.id, responseText || '', 'error', '响应过短或未抓到');
          return;
        }

        // 5.5. v0.5.2: Sanity check - 响应不应该完全是题目本身
        const fingerprint = text.substring(0, 60).trim();
        if (fingerprint.length >= 20 && responseText.includes(fingerprint)) {
          log(`  ⚠️ 响应包含原题指纹, 大概率抓到了 user message 而不是 AI 回答`, 'warn');
          Bridge.writeResponse(req.id, responseText, 'error', '抓到了用户消息区而非 AI 回答, 请重新请求');
          return;
        }

        // 6. 写回
        Bridge.writeResponse(req.id, responseText, 'done');
        state.processedCount++;
        log(`✅ 题目 ${req.id} 完成, ${responseText.length} 字符`, 'success');
      } catch (e) {
        log(`❌ 处理异常: ${e.message}`, 'error');
        Bridge.writeResponse(req.id, '', 'error', e.message);
      } finally {
        state.busy = false;
        state.currentRequest = null;
        updateCurrent(null);
        updateStats();
      }
    }

    /** v0.5.2: 找包含完整题目指纹的最深 + 最短(最具体)元素 = user message */
    function findUserMessageElement(questionText) {
      const fingerprint = questionText.substring(0, 80).replace(/\s+/g, ' ').trim();
      if (fingerprint.length < 20) return null;
      const candidates = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.closest('#nlh-panel')) return;
        const elText = el.textContent.replace(/\s+/g, ' ').trim();
        if (elText.includes(fingerprint)) {
          let depth = 0;
          let p = el;
          while (p && p !== document.body) { depth++; p = p.parentElement; }
          candidates.push({ el, depth, len: elText.length });
        }
      });
      if (candidates.length === 0) return null;
      // 优先短的(纯 user message), 再深的
      candidates.sort((a, b) => (a.len - b.len) || (b.depth - a.depth));
      return candidates[0].el;
    }

    function formatQuestionForNLM(req) {
      let t = `[${req.type}] 第 ${req.position}/${req.total} 题\n\n${req.stem}\n`;
      if (req.options && req.options.length > 0) {
        t += '\n' + req.options.map((o) => `${o.letter}. ${o.content}`).join('\n');
      }
      t += '\n\n请基于知识库给出正确答案及完整解析。';
      return t;
    }

    // === 队列循环 ===
    async function tryProcessQueue() {
      if (state.busy) return;
      const req = Bridge.peekNextRequest();
      if (!req) {
        setStatus('idle', '⏸ 等待 iLearning 发题...');
        return;
      }
      await processOneRequest(req);
      // 处理完一个再试下一个(顺序处理, 避免并发)
      setTimeout(tryProcessQueue, 500);
    }

    // === UI ===
    function buildPanel() {
      const panel = document.createElement('div');
      panel.id = 'nlh-panel';
      setSafeHTML(panel, `
        <div id="nlh-header">
          <span class="nlh-dot idle"></span>
          <span class="nlh-title">📓 NotebookLM 助手</span>
          <span class="nlh-stage">${STAGE}</span>
          <span class="nlh-toggle" id="nlh-toggle-panel" title="折叠/展开">━</span>
        </div>
        <div id="nlh-status" class="idle">⏸ 等待 iLearning 发题...</div>
        <div id="nlh-stats">
          <div class="nlh-stat">
            <div class="nlh-stat-num" id="nlh-stat-queue">0</div>
            <div class="nlh-stat-label">排队中</div>
          </div>
          <div class="nlh-stat">
            <div class="nlh-stat-num" id="nlh-stat-done">0</div>
            <div class="nlh-stat-label">已处理</div>
          </div>
          <div class="nlh-stat">
            <div class="nlh-stat-num" id="nlh-stat-cache">0</div>
            <div class="nlh-stat-label">缓存数</div>
          </div>
        </div>
        <div id="nlh-current">
          <div class="nlh-current-title">📝 当前任务</div>
          <div class="nlh-current-content" id="nlh-current-content" style="opacity:0.5">空闲中</div>
        </div>
        <div id="nlh-actions">
          <button class="nlh-btn" id="nlh-btn-detect">🔍 仅探测元素</button>
          <button class="nlh-btn" id="nlh-btn-clear">🗑️ 清空缓存</button>
        </div>
        <div id="nlh-log-section">
          <div id="nlh-log-header">
            <span>📝 调试日志</span>
            <span id="nlh-log-toggle">▼</span>
          </div>
          <div id="nlh-log"></div>
        </div>
      `);
      document.body.appendChild(panel);

      document.getElementById('nlh-toggle-panel').addEventListener('click', () => {
        state.panelCollapsed = !state.panelCollapsed;
        panel.classList.toggle('collapsed', state.panelCollapsed);
      });
      document.getElementById('nlh-log-header').addEventListener('click', () => {
        state.logCollapsed = !state.logCollapsed;
        document.getElementById('nlh-log').classList.toggle('collapsed', state.logCollapsed);
        document.getElementById('nlh-log-toggle').textContent = state.logCollapsed ? '▶' : '▼';
      });
      document.getElementById('nlh-btn-detect').addEventListener('click', () => {
        const i = findInputElement();
        if (i) {
          log(`✅ 输入框: ${describeEl(i)}`, 'success');
          flashHL(i, '#26a69a');
          const b = findSubmitButton(i);
          if (b) {
            log(`✅ 提交按钮: ${describeEl(b)} disabled=${b.disabled}`, 'success');
            flashHL(b, '#ffb300');
          } else {
            log('⚠️ 未找到符合条件的按钮', 'warn');
          }
        } else {
          log('❌ 未找到输入框', 'error');
        }
      });
      document.getElementById('nlh-btn-clear').addEventListener('click', () => {
        if (!confirm('清空所有缓存的解析? 之后切回老题会重新请求。')) return;
        Bridge.clearAll();
        log('🗑️ 已清空所有桥接数据', 'warn');
        updateStats();
      });

      // 拖拽
      const handle = document.getElementById('nlh-header');
      let dragging = false, dx = 0, dy = 0;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        dx = e.clientX - panel.offsetLeft;
        dy = e.clientY - panel.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = (e.clientX - dx) + 'px';
        panel.style.top = (e.clientY - dy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    }

    function flashHL(el, color) {
      const orig = el.style.outline, oo = el.style.outlineOffset;
      el.style.outline = `3px solid ${color}`;
      el.style.outlineOffset = '2px';
      setTimeout(() => { el.style.outline = orig; el.style.outlineOffset = oo; }, 2200);
    }

    function setStatus(level, text) {
      const sEl = document.getElementById('nlh-status');
      if (!sEl) return;
      sEl.className = level || '';
      sEl.textContent = text;
      const dot = document.querySelector('#nlh-header .nlh-dot');
      if (dot) dot.className = 'nlh-dot' + (level ? ' ' + level : '');
    }

    function updateCurrent(req) {
      const el = document.getElementById('nlh-current-content');
      if (!el) return;
      if (!req) {
        el.textContent = '空闲中';
        el.style.opacity = '0.5';
      } else {
        el.style.opacity = '1';
        el.textContent = `[${req.type}] 第 ${req.position}/${req.total} 题\n\n${req.stem.substring(0, 120)}${req.stem.length > 120 ? '...' : ''}`;
      }
    }

    function updateStats() {
      const queue = GM_getValue('ilh:queue', []);
      const allKeys = Bridge.listAllKeys();
      const cacheCount = allKeys.filter((k) => k.startsWith('ilh:response:')).length;
      const queueEl = document.getElementById('nlh-stat-queue');
      const doneEl = document.getElementById('nlh-stat-done');
      const cacheEl = document.getElementById('nlh-stat-cache');
      if (queueEl) queueEl.textContent = String(queue.length);
      if (doneEl) doneEl.textContent = String(state.processedCount);
      if (cacheEl) cacheEl.textContent = String(cacheCount);
    }

    // === INIT ===
    buildPanel();
    log(`✅ NotebookLM 端 v${VERSION} 已加载`, 'success');
    log(`🎯 当前阶段: ${STAGE} (自动消费 iLearning 发来的题)`, 'info');

    // 心跳: 每 3 秒报告一次
    Bridge.reportAlive();
    setInterval(() => Bridge.reportAlive(), CONFIG.heartbeatIntervalMs);

    // 监听新 request
    Bridge.onRequest(() => {
      log('🔔 检测到新请求, 准备处理', 'info');
      tryProcessQueue();
    });

    // 启动时也试一次(防止启动前已有积压)
    setTimeout(tryProcessQueue, 1500);

    // 定期更新统计
    setInterval(updateStats, 2000);
    updateStats();
  }
})();
