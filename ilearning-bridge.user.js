// ==UserScript==
// @name         iLearning 学习助手 (Stage 3 桥接版)
// @namespace    https://github.com/lucassu2012/
// @version      0.7.0
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
// v0.7.0 - 抓取算法完全重写: 抛弃 snapshot diff, 改用真实 NotebookLM DOM 选择器 (chat-message-pair + element-list-renderer)
//          单题独立锁定, 彻底消除跨题串扰
// v0.6.2 - 修跨题串扰: user message 排除改为实时检查 + 加 DOM 顺序检查(只看 user message 之后元素), 避免抓到前题的 AI response
// v0.6.1 - 修题型识别(多选题被识别成单选题) + 修批次大小输入框被切题箭头键误触发
// v0.6.0 - Stage 3.5 阶段A: iLearning 端批量预取面板(进度+未识别题号+批次大小可配置). 阶段B(NotebookLM真批处理)分别实现
// v0.5.7 - markdown 渲染段落紧凑化(去掉换行符夹层 + margin 归零)
// v0.5.6 - iLearning 浮窗渲染 markdown(粗体/列表/嵌套), 不再是 raw 文本
// v0.5.5 - 抓取保留格式(块元素换行 + markdown加粗) + 导出从JSON改为CSV(Excel友好,UTF-8 BOM)
// v0.5.4 - 🔑 用 NotebookLM 完成标记(thumb_up出现)作主判定 + 强化 user message 容器查找(要全部选项) + 提交后强制最小等待
// v0.5.3 - 修复 user message 容器识别(原版漏排除选项兄弟元素); 加导出题库 JSON
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

    // v0.6.0 Stage 3.5: 批量预取状态
    const batchState = {
      enabled: true,                       // 默认开
      batchSize: 20,                       // 默认每批 20 题
      totalQuestions: 0,                   // 第一题识别后从 q.total 填入
      identifiedPositions: new Set(),      // 已识别的题号(数字)
      identifiedQuestions: new Map(),      // qId -> q 对象
      batchStarted: false,                 // 是否已经启动批处理
    };

    // v0.6.0: 把已识别的题号合并成紧凑 ranges (e.g. "1-3, 5, 7-10")
    function compactRanges(positionsArray) {
      const sorted = Array.from(positionsArray).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
      if (sorted.length === 0) return '-';
      const ranges = [];
      let start = sorted[0], prev = sorted[0];
      for (let i = 1; i <= sorted.length; i++) {
        const cur = sorted[i];
        if (cur !== prev + 1) {
          ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
          start = cur;
        }
        prev = cur;
      }
      return ranges.join(', ');
    }

    function getMissingPositions() {
      const missing = [];
      for (let i = 1; i <= batchState.totalQuestions; i++) {
        if (!batchState.identifiedPositions.has(i)) missing.push(i);
      }
      return missing;
    }

    function updateBatchPanel() {
      const idCount = document.getElementById('ilh-batch-id-count');
      const totalEl = document.getElementById('ilh-batch-total');
      const missingEl = document.getElementById('ilh-batch-missing-list');
      const statusEl = document.getElementById('ilh-batch-status-text');
      const startBtn = document.getElementById('ilh-batch-start');
      const panelEl = document.getElementById('ilh-batch-panel');
      if (!idCount) return;

      idCount.textContent = batchState.identifiedPositions.size;
      totalEl.textContent = batchState.totalQuestions || '?';
      panelEl.classList.toggle('disabled', !batchState.enabled);

      if (!batchState.enabled) {
        statusEl.textContent = '已关闭, 单题模式';
        statusEl.className = '';
        return;
      }

      if (batchState.totalQuestions > 0) {
        const missing = getMissingPositions();
        missingEl.textContent = missing.length > 0
          ? `未识别: ${compactRanges(new Set(missing))}`
          : '✅ 全部识别完成';

        if (batchState.batchStarted) {
          statusEl.textContent = '🚀 批处理已启动 (阶段A仅模拟)';
          statusEl.className = 'running';
          startBtn.disabled = true;
        } else if (missing.length === 0) {
          statusEl.textContent = '✅ 全部识别完成, 可启动批处理';
          statusEl.className = 'ready';
          startBtn.disabled = false;
        } else {
          statusEl.textContent = `⏸ 还需识别 ${missing.length} 题`;
          statusEl.className = '';
          startBtn.disabled = true;
        }
      } else {
        missingEl.textContent = '未识别: 等待第一题识别后获取总数';
        statusEl.textContent = '⏸ 等待第一题识别';
        statusEl.className = '';
        startBtn.disabled = true;
      }
    }

    function startBatchProcessing() {
      if (batchState.batchStarted) return;
      batchState.batchStarted = true;
      const total = batchState.identifiedQuestions.size;
      const numBatches = Math.ceil(total / batchState.batchSize);
      log(`🚀 (阶段A) 模拟启动批处理: ${total} 题, 每批 ${batchState.batchSize}, 共 ${numBatches} 批`, 'info');
      log(`   阶段 B 接通 NotebookLM 后会真正发批量 prompt`, 'warn');
      updateBatchPanel();
      if (state.currentQuestion) {
        showExplain('waiting', `🚀 批处理已启动\n\n${total} 道题分 ${numBatches} 批, 每批 ${batchState.batchSize} 题\n\n(阶段 A: 仅 UI 模拟, 阶段 B 接通后真正发送)`, '批处理中');
      }
    }

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

      #ilh-batch-panel {
        padding: 9px 14px 10px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: rgba(33,150,243,0.04);
        font-size: 11px;
      }
      .ilh-batch-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 6px;
        font-weight: 600; font-size: 12px;
      }
      .ilh-batch-toggle {
        display: flex; align-items: center; gap: 5px;
        cursor: pointer;
        font-size: 11px; opacity: 0.9;
        font-weight: normal;
      }
      .ilh-batch-toggle input[type="checkbox"] {
        cursor: pointer;
      }
      .ilh-batch-config {
        margin-bottom: 5px;
        display: flex; align-items: center; gap: 6px;
        opacity: 0.9;
      }
      .ilh-batch-config input {
        width: 48px; padding: 2px 4px;
        background: rgba(0,0,0,0.25);
        color: #e8eaf6;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 3px;
        font-size: 11px;
        text-align: center;
      }
      .ilh-batch-progress {
        margin-bottom: 4px;
        opacity: 0.85;
      }
      .ilh-batch-progress .ilh-batch-num {
        font-weight: 600;
        color: #64b5f6;
      }
      .ilh-batch-missing {
        margin-bottom: 6px;
        opacity: 0.7;
        font-family: "SF Mono", Monaco, Consolas, monospace;
        font-size: 10px;
        word-break: break-all;
        max-height: 36px;
        overflow-y: auto;
      }
      .ilh-batch-status-row {
        display: flex; justify-content: space-between; align-items: center;
        gap: 6px;
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid rgba(255,255,255,0.05);
      }
      #ilh-batch-status-text {
        flex: 1; font-size: 11px;
      }
      #ilh-batch-status-text.ready { color: #81c784; font-weight: 600; }
      #ilh-batch-status-text.running { color: #64b5f6; font-weight: 600; }
      #ilh-batch-start {
        font-size: 10px; padding: 4px 9px;
      }
      #ilh-batch-start:disabled {
        opacity: 0.35; cursor: not-allowed;
      }
      #ilh-batch-panel.disabled {
        opacity: 0.45;
      }
      #ilh-batch-panel.disabled .ilh-batch-config,
      #ilh-batch-panel.disabled .ilh-batch-progress,
      #ilh-batch-panel.disabled .ilh-batch-missing,
      #ilh-batch-panel.disabled .ilh-batch-status-row {
        display: none;
      }

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

      .ilh-explain-content .ilh-md-line {
        margin: 0;
        padding: 0;
        line-height: 1.6;
      }
      .ilh-explain-content ul.ilh-md-list {
        margin: 3px 0;
        padding-left: 20px;
        list-style: disc;
      }
      .ilh-explain-content ul.ilh-md-list ul.ilh-md-list {
        list-style: circle;
        margin: 0;
      }
      .ilh-explain-content li {
        margin: 0;
        line-height: 1.55;
      }
      .ilh-explain-content.md-rendered {
        white-space: normal;
      }
      .ilh-explain-content strong {
        color: #fff;
        font-weight: 600;
      }
      .ilh-explain-content em { font-style: italic; }
      #ilh-empty {
        padding: 32px 14px; text-align: center;
        opacity: 0.55; font-size: 12px; line-height: 1.7;
      }
      #ilh-empty .ilh-hint {
        font-size: 10px; opacity: 0.7;
        display: block; margin-top: 6px;
      }
    `);

    // === Markdown 渲染 (v0.5.6) ===
    function renderMarkdown(md) {
      if (!md) return '';
      let html = escapeHtml(md);
      // 加粗 **text** -> <strong>
      html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      // 行级处理: 列表 vs 普通行 (支持嵌套缩进)
      const lines = html.split('\n');
      const out = [];
      const listStack = []; // 记录每层 list 的缩进
      function closeListsTo(targetIndent) {
        while (listStack.length > 0 && listStack[listStack.length - 1] >= targetIndent) {
          if (listStack[listStack.length - 1] > targetIndent || targetIndent === -1) {
            out.push('</ul>');
            listStack.pop();
          } else break;
        }
      }
      for (const rawLine of lines) {
        const indentMatch = rawLine.match(/^( *)/);
        const indent = indentMatch ? indentMatch[0].length : 0;
        const trimmed = rawLine.trim();
        const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/) || trimmed.match(/^\d+\.\s+(.+)/);
        if (bulletMatch) {
          // 关闭比当前缩进深的 list
          while (listStack.length > 0 && listStack[listStack.length - 1] > indent) {
            out.push('</ul>');
            listStack.pop();
          }
          // 开新层级 list
          if (listStack.length === 0 || listStack[listStack.length - 1] < indent) {
            out.push('<ul class="ilh-md-list">');
            listStack.push(indent);
          }
          out.push('<li>' + bulletMatch[1] + '</li>');
        } else {
          // 关闭所有 list
          while (listStack.length > 0) {
            out.push('</ul>');
            listStack.pop();
          }
          if (trimmed === '') {
            // 空行: 段落分隔, 不输出标签
          } else {
            out.push('<div class="ilh-md-line">' + trimmed + '</div>');
          }
        }
      }
      while (listStack.length > 0) {
        out.push('</ul>');
        listStack.pop();
      }
      // v0.5.7: 不用 '\n' 连接, 避免 white-space:pre-wrap 把它显示成额外换行
      return out.join('');
    }

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
      // v0.6.1: 找所有题型候选 - sidebar 里可能有"单选题/多选题"分类标签, 不能取第一个
      const candidates = [];
      const w1 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n1;
      while ((n1 = w1.nextNode())) {
        const t = n1.textContent.trim();
        if (t.length > 5 || t.length < 2) continue;
        if (types.includes(t)) candidates.push(n1);
      }
      if (candidates.length === 0) return '未知题型';
      if (candidates.length === 1) return candidates[0].textContent.trim();

      // 多候选: 找包含"第 X/Y 题"的元素, 选 DOM 距离最近的题型
      const positionRe = /第\s*\d+\s*\/\s*\d+\s*题/;
      let positionEl = null;
      const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n2;
      while ((n2 = w2.nextNode())) {
        if (n2.textContent.length < 200 && positionRe.test(n2.textContent)) {
          positionEl = n2.parentElement;
          break;
        }
      }
      if (!positionEl) return candidates[0].textContent.trim();

      let best = candidates[0];
      let bestDist = Infinity;
      for (const c of candidates) {
        const cParent = c.parentElement;
        if (!cParent) continue;
        const d = domDistance(cParent, positionEl);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      return best.textContent.trim();
    }

    /** v0.6.1: 计算两个 element 在 DOM 树中的距离 (祖先链 LCA 距离之和) */
    function domDistance(a, b) {
      if (a === b) return 0;
      const aAnc = new Map();
      let p = a, d = 0;
      while (p) { aAnc.set(p, d++); p = p.parentElement; }
      p = b; d = 0;
      while (p) {
        if (aAnc.has(p)) return aAnc.get(p) + d;
        d++; p = p.parentElement;
      }
      return Infinity;
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
        <div id="ilh-batch-panel">
          <div class="ilh-batch-header">
            <span>🚀 批量预取</span>
            <label class="ilh-batch-toggle">
              <input type="checkbox" id="ilh-batch-enabled" checked>
              <span>开启</span>
            </label>
          </div>
          <div class="ilh-batch-config">
            每批: <input type="number" id="ilh-batch-size" value="20" min="1" max="50"> 题
          </div>
          <div class="ilh-batch-progress">已识别: <span class="ilh-batch-num" id="ilh-batch-id-count">0</span>/<span id="ilh-batch-total">?</span></div>
          <div class="ilh-batch-missing" id="ilh-batch-missing-list">未识别: -</div>
          <div class="ilh-batch-status-row">
            <span id="ilh-batch-status-text">⏸ 等待第一题识别</span>
            <button class="ilh-mini-btn" id="ilh-batch-start" disabled>▷ 立即批处理</button>
          </div>
        </div>
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

      // v0.6.0: 批量面板事件
      document.getElementById('ilh-batch-enabled').addEventListener('change', (e) => {
        batchState.enabled = e.target.checked;
        log(`🚀 批量预取已${batchState.enabled ? '开启' : '关闭'}`, 'info');
        updateBatchPanel();
        // 切回单题模式时, 当前题没缓存就立即请求
        if (!batchState.enabled && state.currentQuestion) {
          const cached = GM_getValue(`ilh:response:${state.currentQuestion.id}`, null);
          if (!cached || cached.status !== 'done') {
            requestExplanation(state.currentQuestion);
          }
        }
      });
      const batchSizeInput = document.getElementById('ilh-batch-size');
      batchSizeInput.addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (Number.isInteger(v) && v >= 1 && v <= 50) {
          batchState.batchSize = v;
          log(`🚀 批次大小改为 ${v}`, 'info');
          updateBatchPanel();
        } else {
          e.target.value = batchState.batchSize;
        }
        e.target.blur(); // v0.6.1: 改完失焦, 防止后续切题键被吃
      });
      // v0.6.1: 阻止 number input 在箭头键时自己 step (但不阻止事件传播给 iLearning 切题)
      batchSizeInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
            e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
        }
      });
      document.getElementById('ilh-batch-start').addEventListener('click', () => {
        startBatchProcessing();
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
      // v0.5.6: 成功状态用 markdown 渲染, 等待/错误状态保持纯文本
      if ((state === '' || !state) && content) {
        contentEl.classList.add('md-rendered');
        setSafeHTML(contentEl, renderMarkdown(content));
      } else {
        contentEl.classList.remove('md-rendered');
        contentEl.textContent = content;
      }
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

        // v0.6.0: 加入批量识别集
        if (batchState.totalQuestions === 0 && q.total) {
          batchState.totalQuestions = q.total;
        }
        batchState.identifiedPositions.add(q.position);
        batchState.identifiedQuestions.set(q.id, q);
        updateBatchPanel();

        // 路由: 批量模式 vs 单题模式
        if (batchState.enabled) {
          // 批量模式: 缓存优先, 没缓存就显示"等识别完"
          const cached = GM_getValue(`ilh:response:${q.id}`, null);
          if (cached && cached.status === 'done') {
            showExplain('', cached.text, '✅ 缓存命中 · 秒回');
            log(`💾 缓存命中: ${q.id}`, 'success');
          } else if (cached && cached.status === 'error') {
            showExplain('error', cached.error || '上次失败', '上次失败 · 关闭批量模式可单题重试');
          } else if (batchState.batchStarted) {
            showExplain('waiting', '⏳ 批处理已启动, 这道题答案马上到...\n\n(阶段 A: 仅 UI 模拟, 阶段 B 真正发送)', '批处理中');
          } else {
            const missing = getMissingPositions();
            if (missing.length > 0) {
              showExplain('waiting', `⏳ 批量预取已开启, 请继续切题完成识别\n\n还需识别: ${compactRanges(new Set(missing))} (共 ${missing.length} 题)`, '识别进行中');
            } else {
              // 全部识别完, 自动启动批处理
              startBatchProcessing();
            }
          }
        } else {
          // 单题模式 (沿用 v0.5.x 行为)
          requestExplanation(q);
        }
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
    updateBatchPanel(); // v0.6.0: 初始化批量面板

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
      minInitialWaitMs: 6000,         // v0.5.4: 提交后至少等 6 秒再考虑"静默", 防 NotebookLM 还没开始生成被误判完成
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

    /**
     * v0.5.5: 遍历 DOM 提取保留格式的文本
     * - 块级元素(div, p, li, h1-h6, ul, ol)前后加换行
     * - <li> 前加 "- " (markdown bullet)
     * - <strong>/<b> 用 **...** 包起来
     * - <br> 转 \n
     * 这样抓到的内容是 markdown 格式, 保留 NotebookLM 原始的层次结构
     */
    function extractFormattedText(el) {
      if (!el) return '';
      const parts = [];
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.textContent);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (['style', 'script', 'noscript', 'svg'].includes(tag)) return;
        if (tag === 'br') { parts.push('\n'); return; }

        const isBlock = ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote', 'tr', 'article', 'section'].includes(tag);
        const isBold = tag === 'strong' || tag === 'b';
        const isItem = tag === 'li';

        if (isBlock || isItem) {
          const last = parts.length ? parts[parts.length - 1] : '';
          if (last && !last.endsWith('\n')) parts.push('\n');
        }
        if (isItem) parts.push('- ');
        if (isBold) parts.push('**');

        for (const child of node.childNodes) walk(child);

        if (isBold) parts.push('**');
        if (isBlock || isItem) {
          const last = parts.length ? parts[parts.length - 1] : '';
          if (last && !last.endsWith('\n')) parts.push('\n');
        }
      }
      walk(el);
      // 清理: 行尾空白, 三连空行→双连空行, 空 ** **
      return parts.join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\*\*\s*\*\*/g, '')
        .trim();
    }

    /** v0.5.5: 导出缓存为 CSV (Excel 友好) */
    function exportCacheCSV() {
      const allKeys = Bridge.listAllKeys();
      const requests = {}, responses = {};
      let counts = { total: 0, done: 0, error: 0, pending: 0 };
      allKeys.forEach((k) => {
        const v = GM_getValue(k, null);
        if (k.startsWith('ilh:request:')) {
          requests[k.replace('ilh:request:', '')] = v;
        } else if (k.startsWith('ilh:response:')) {
          responses[k.replace('ilh:response:', '')] = v;
          counts.total++;
          if (v && v.status) counts[v.status] = (counts[v.status] || 0) + 1;
        }
      });
      const combined = [];
      for (const qId in requests) {
        const req = requests[qId];
        const resp = responses[qId];
        combined.push({
          position: req.position || 0,
          type: req.type || '',
          stem: req.stem || '',
          options: req.options || [],
          status: resp ? resp.status : 'pending',
          text: resp ? (resp.text || '') : '',
          error: resp ? (resp.error || '') : '',
          at: resp ? new Date(resp.timestamp).toLocaleString('zh-CN') : '',
        });
      }
      combined.sort((a, b) => a.position - b.position);

      // 选项可能多于 4 个(多选), 算最大数量
      const maxOpts = combined.reduce((m, q) => Math.max(m, (q.options || []).length), 4);
      const optHeaders = [];
      for (let i = 0; i < maxOpts; i++) {
        optHeaders.push(`选项${String.fromCharCode(65 + i)}`);
      }
      const headers = ['题号', '题型', '题干', ...optHeaders, '状态', '解析', '错误', '处理时间'];
      const rows = [headers];
      for (const q of combined) {
        const opts = (q.options || []).map((o) => o.content || '');
        while (opts.length < maxOpts) opts.push('');
        rows.push([
          q.position || '',
          q.type || '',
          q.stem || '',
          ...opts,
          q.status || '',
          q.text || '',
          q.error || '',
          q.at || '',
        ]);
      }
      // CSV 转换: 含逗号/引号/换行的字段用引号包起来, 内部引号双写转义
      const csv = rows.map((row) =>
        row.map((field) => {
          const s = String(field == null ? '' : field);
          if (/[",\n\r]/.test(s)) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }).join(',')
      ).join('\r\n'); // CRLF, Excel/Windows 友好

      // UTF-8 BOM 让 Excel 正确识别中文
      const csvWithBOM = '\ufeff' + csv;
      const blob = new Blob([csvWithBOM], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ilearning-questions-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      log(`📥 已导出 ${combined.length} 道题为 CSV (done: ${counts.done}, error: ${counts.error})`, 'success');
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

    /**
     * v0.7.0: 用真实 NotebookLM DOM 直接定位当前题的 AI 响应
     * 结构: div.chat-message-pair > [from-user-container, to-user-container]
     * 取最后一对 → 验证是当前题 → 抓 element-list-renderer
     */
    function findCurrentAIResponse(req) {
      const pairs = document.querySelectorAll('div.chat-message-pair');
      if (pairs.length === 0) return { status: 'no-pair' };

      // 取最后一对 (最新的问答)
      const lastPair = pairs[pairs.length - 1];

      // 验证 user message 是当前题 (用题干前 30 字做指纹)
      const userMsg = lastPair.querySelector('div.from-user-container div.md3-body-text');
      if (!userMsg) return { status: 'no-user-msg' };

      const userText = (userMsg.textContent || '').replace(/\s+/g, ' ');
      const stemFp = (req.stem || '').substring(0, 30).replace(/\s+/g, ' ').trim();
      if (stemFp.length >= 10 && !userText.includes(stemFp)) {
        return { status: 'wrong-pair', userTextPreview: userText.substring(0, 50) };
      }

      // 找 AI 响应正文容器 (干净, 只含 AI 生成内容)
      const aiEl = lastPair.querySelector('div.to-user-container element-list-renderer');
      if (!aiEl) return { status: 'no-ai-yet' };

      // 完成检测: 这一对的 mat-card-actions 是否有 thumb_up button
      // (流式中 mat-card-actions 不存在或子元素未填充, 完成后才出现完整 actions)
      let complete = false;
      const actions = lastPair.querySelector('div.to-user-container mat-card-actions');
      if (actions) {
        const icons = actions.querySelectorAll('mat-icon');
        for (const icon of icons) {
          if (icon.textContent.trim() === 'thumb_up') {
            complete = true;
            break;
          }
        }
      }

      return { status: 'ok', el: aiEl, complete };
    }

    async function waitForResponse(req) {
      const startTs = Date.now();
      let lastEl = null;
      let lastLen = 0;
      let lastChangeTs = startTs;
      let completedAt = null;
      let lastStatus = null;
      let okStartedAt = null;

      while (Date.now() - startTs < CONFIG.maxResponseWaitMs) {
        await sleep(CONFIG.pollIntervalMs);
        const elapsed = Date.now() - startTs;

        const result = findCurrentAIResponse(req);

        // 状态变化 → log 一次
        if (result.status !== lastStatus) {
          if (result.status === 'wrong-pair') {
            log(`  └ 状态: 最后一对不是本题 (text=${result.userTextPreview}...)`, 'debug');
          } else if (result.status === 'ok' && lastStatus !== 'ok') {
            log(`  └ 状态: 锁定本题 AI 响应区, 开始监听增长`, 'debug');
            okStartedAt = Date.now();
          } else {
            log(`  └ 状态: ${result.status}`, 'debug');
          }
          lastStatus = result.status;
        }

        if (result.status !== 'ok') continue;

        lastEl = result.el;
        const currentLen = lastEl.textContent.length;
        if (currentLen > lastLen) {
          lastLen = currentLen;
          lastChangeTs = Date.now();
        }

        // 主判定: 完成标记 (mat-card-actions thumb_up 出现)
        if (result.complete && lastLen >= CONFIG.minResponseChars) {
          if (completedAt === null) {
            completedAt = Date.now();
            log(`  ✅ 检测到完成标记 (thumb_up), 收尾 1.5s`, 'success');
          }
          if (Date.now() - completedAt > 1500) {
            // 收尾再抓一次, 拿最完整内容
            const finalResult = findCurrentAIResponse(req);
            const finalEl = (finalResult.status === 'ok' && finalResult.el) ? finalResult.el : lastEl;
            const text = extractFormattedText(finalEl);
            log(`  ✅ 抓取最终响应 (${text ? text.length : 0} 字符, 含格式)`, 'success');
            return text;
          }
          continue;
        }

        // 兜底: 静默检测 (lastEl 已锁定本题且 minInitialWait 已过)
        const okElapsed = okStartedAt ? Date.now() - okStartedAt : 0;
        if (okElapsed > CONFIG.minInitialWaitMs && lastLen >= CONFIG.minResponseChars) {
          const silenceMs = Date.now() - lastChangeTs;
          if (silenceMs > CONFIG.silenceTimeoutMs) {
            log(`  ⚠️ 没等到完成标记, 静默 ${Math.round(silenceMs/1000)}s 强制返回 (内容已稳定)`, 'warn');
            return extractFormattedText(lastEl);
          }
        }
      }

      log(`  ⏱️ 达到最长等待时间 ${Math.round(CONFIG.maxResponseWaitMs/1000)}s`, 'warn');
      return lastEl ? extractFormattedText(lastEl) : null;
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

        // 3. 提交 (v0.7.0: 不再需要 snapshot, 用 chat-message-pair 锁定本题)
        const method = await submitMessage(inputEl);
        if (!method) {
          log('❌ 提交失败', 'error');
          Bridge.writeResponse(req.id, '', 'error', '提交失败');
          return;
        }
        await sleep(CONFIG.responseInitialDelayMs);

        // 4. 等响应 (v0.7.0: 直接用真实 DOM 选择器锁定本题 AI 响应)
        const responseText = await waitForResponse(req);
        if (!responseText || responseText.length < CONFIG.minResponseChars) {
          log(`❌ 响应过短 (${responseText?.length || 0} 字符)`, 'error');
          Bridge.writeResponse(req.id, responseText || '', 'error', '响应过短或未抓到');
          return;
        }

        // 5.5. v0.5.3: Sanity check - normalize 空白后比对
        const normalizedResp = responseText.replace(/\s+/g, ' ').trim();
        const stemFp = (req.stem || '').substring(0, 40).replace(/\s+/g, ' ').trim();
        const optFp = (req.options && req.options[0] ? req.options[0].content : '').substring(0, 25).replace(/\s+/g, ' ').trim();
        let suspicious = false;
        let suspReason = '';
        // 检查 1: 响应是否包含题干特征
        if (stemFp.length >= 15 && normalizedResp.includes(stemFp)) {
          suspicious = true;
          suspReason = '响应包含题干指纹';
        }
        // 检查 2: 响应是否大段就是选项原文
        if (optFp.length >= 10 && normalizedResp.includes(optFp) && req.options.length >= 2) {
          // 看是否所有选项都在响应里(说明响应就是选项罗列)
          let optsInResp = 0;
          for (const opt of req.options) {
            const fp = (opt.content || '').substring(0, 20).replace(/\s+/g, ' ').trim();
            if (fp.length >= 8 && normalizedResp.includes(fp)) optsInResp++;
          }
          if (optsInResp >= req.options.length - 1) {
            suspicious = true;
            suspReason = `响应包含 ${optsInResp}/${req.options.length} 个选项原文`;
          }
        }
        if (suspicious) {
          log(`  ⚠️ ${suspReason}, 大概率抓到了 user message 而不是 AI 回答`, 'warn');
          Bridge.writeResponse(req.id, responseText, 'error', `${suspReason}: 抓到了用户消息区, 请重新请求`);
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

    /**
     * v0.5.4: 找完整 user message 容器 - 要求祖先包含题干 + 全部选项
     * 旧版只要 1 个选项就返回, 可能找到不完整的内部元素
     */
    function findUserMessageContainer(req) {
      const stemFp = (req.stem || '').substring(0, 50).replace(/\s+/g, ' ').trim();
      if (stemFp.length < 15) return null;

      const optFps = (req.options || [])
        .map((o) => (o.content || '').substring(0, 25).replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 8);

      // 1. 找所有 textContent 包含题干指纹的元素
      const stemEls = [];
      document.querySelectorAll('*').forEach((el) => {
        if (el.closest('#nlh-panel')) return;
        const elText = el.textContent.replace(/\s+/g, ' ').trim();
        if (elText.includes(stemFp)) {
          stemEls.push(el);
        }
      });
      if (stemEls.length === 0) return null;

      // 2. 对每个题干元素往上爬, 找最小的祖先 - 必须包含 stem + 全部选项
      let bestCandidate = null;
      let bestSize = Infinity;
      for (const stemEl of stemEls) {
        let p = stemEl;
        while (p && p !== document.body) {
          const text = p.textContent.replace(/\s+/g, ' ').trim();
          let optionsFound = 0;
          for (const fp of optFps) {
            if (text.includes(fp)) optionsFound++;
          }
          // 要求: 没选项时只要题干, 有选项时要求全部选项
          const allOptionsPresent = optFps.length === 0 || optionsFound >= optFps.length;
          if (allOptionsPresent) {
            // 这是个候选 - 取最小的(最贴合 user message 边界的)
            if (text.length < bestSize) {
              bestCandidate = p;
              bestSize = text.length;
            }
            break; // 不再往上(更上的祖先必然更大)
          }
          p = p.parentElement;
        }
      }
      // 3. 没找到完整的, 至少返回最深题干元素(better than nothing)
      if (!bestCandidate && stemEls.length > 0) {
        let deepest = stemEls[0], maxDepth = 0;
        for (const el of stemEls) {
          let d = 0; let p = el;
          while (p && p !== document.body) { d++; p = p.parentElement; }
          if (d > maxDepth) { maxDepth = d; deepest = el; }
        }
        return deepest;
      }
      return bestCandidate;
    }

    /**
     * v0.5.4: 计数 NotebookLM 已完成 AI 回答的数量
     * 用 thumb_up 按钮出现作完成信号 (生成中绝不出现, 完成后才显示)
     */
    function countCompletedResponses() {
      let count = 0;
      document.querySelectorAll('button, [role="button"]').forEach((btn) => {
        if (btn.closest('#nlh-panel')) return;
        if (!isVisible(btn)) return;
        const text = ((btn.getAttribute('aria-label') || '') + ' ' +
                      (btn.getAttribute('title') || '') + ' ' +
                      btn.textContent);
        // thumb_up 是 Material 图标名, "good response"/"like" 是 aria-label, "点赞" 是中文
        if (/thumb_up|good response|点赞|👍/i.test(text) || /\blike\b/i.test(text)) {
          count++;
        }
      });
      return count;
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
          <button class="nlh-btn" id="nlh-btn-detect">🔍 仅探测</button>
          <button class="nlh-btn" id="nlh-btn-export">📥 CSV</button>
          <button class="nlh-btn" id="nlh-btn-clear">🗑️ 清空</button>
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
      document.getElementById('nlh-btn-export').addEventListener('click', () => {
        exportCacheCSV();
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
