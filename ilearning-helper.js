// ==UserScript==
// @name         iLearning 学习助手 (Stage 1: DOM 抽取)
// @namespace    https://github.com/lucassu2012/
// @version      0.1.2
// @description  iLearning 习题页自动识别题目,Stage 1 只验证 DOM 抽取(尚未联动 NotebookLM)
// @author       Lucas
// @match        https://ilearning.huawei.com/iexam/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/ilearning-helper.js
// @downloadURL  https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/ilearning-helper.js
// ==/UserScript==

// CHANGELOG
// v0.1.2 - 修复选项识别 (选项字母和内容跨节点); @match 精确到 examContent
// v0.1.0 - Stage 1 初版

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     ⚙️  CONFIG
     ═══════════════════════════════════════════════════════════ */
  const VERSION = '0.1.0';
  const STAGE_LABEL = 'Stage 1';

  const CONFIG = {
    extractDebounceMs: 300,      // 抽取防抖, MutationObserver 多次触发只跑一次
    minStemLength: 4,            // 题干最少字符数
    logMaxLines: 80,
    panelWidth: 380,
    panelMaxHeight: 680,
  };

  /* ═══════════════════════════════════════════════════════════
     📊  STATE
     ═══════════════════════════════════════════════════════════ */
  const state = {
    currentQuestion: null,
    lastQuestionId: null,
    extractCount: 0,
    extractFailCount: 0,
    panelCollapsed: false,
    logCollapsed: false,
  };

  /* ═══════════════════════════════════════════════════════════
     🎨  STYLES
     ═══════════════════════════════════════════════════════════ */
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
      display: flex;
      flex-direction: column;
      transition: max-height 0.25s ease;
    }
    #ilh-panel.collapsed {
      max-height: 44px;
    }
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
      transition: background 0.2s, box-shadow 0.2s;
    }
    .ilh-dot.idle { background: #888; box-shadow: none; }
    .ilh-dot.error { background: #f44336; box-shadow: 0 0 8px #f44336; }
    .ilh-dot.warn  { background: #ff9800; box-shadow: 0 0 8px #ff9800; }

    .ilh-title { flex: 1; font-weight: 600; letter-spacing: 0.3px; }
    .ilh-stage {
      font-size: 10px; opacity: 0.65;
      padding: 2px 7px;
      background: rgba(255,255,255,0.07);
      border-radius: 4px;
      letter-spacing: 0.5px;
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

    #ilh-question {
      padding: 12px 14px;
      overflow-y: auto;
      flex: 1; min-height: 0;
    }
    .ilh-meta {
      display: flex; gap: 6px; flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .ilh-pill {
      padding: 3px 9px;
      border-radius: 11px;
      font-size: 11px;
      font-weight: 500;
      background: rgba(33,150,243,0.18);
      color: #64b5f6;
    }
    .ilh-pill.position { background: rgba(255,193,7,0.18); color: #ffd54f; }
    .ilh-pill.id       { background: rgba(255,255,255,0.05); color: #999; font-family: monospace; font-size: 10px; }

    .ilh-stem {
      font-size: 13px; line-height: 1.6;
      margin-bottom: 12px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
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
    .ilh-option-letter {
      font-weight: 600;
      color: #64b5f6;
      margin-right: 6px;
    }

    #ilh-actions {
      display: flex; gap: 6px;
      padding: 0 14px 10px;
    }
    .ilh-btn {
      flex: 1;
      padding: 6px 8px;
      background: rgba(255,255,255,0.06);
      color: #e8eaf6;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s, transform 0.15s;
    }
    .ilh-btn:hover { background: rgba(255,255,255,0.13); transform: translateY(-1px); }
    .ilh-btn:active { transform: translateY(0); }

    #ilh-log-section {
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; flex-direction: column;
    }
    #ilh-log-header {
      padding: 7px 14px;
      font-size: 11px;
      opacity: 0.7;
      cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      user-select: none;
    }
    #ilh-log-header:hover { opacity: 1; }
    #ilh-log {
      padding: 0 14px 10px;
      overflow-y: auto;
      font-size: 11px;
      font-family: "SF Mono", Monaco, Consolas, "Courier New", monospace;
      line-height: 1.55;
      max-height: 140px;
    }
    #ilh-log.collapsed { display: none; }
    .ilh-log-entry { margin-bottom: 1px; opacity: 0.9; }
    .ilh-log-info    { color: #90caf9; }
    .ilh-log-success { color: #81c784; }
    .ilh-log-warn    { color: #ffb74d; }
    .ilh-log-error   { color: #e57373; }
    .ilh-log-time    { opacity: 0.4; margin-right: 6px; }

    #ilh-empty {
      padding: 32px 14px;
      text-align: center;
      opacity: 0.55;
      font-size: 12px;
      line-height: 1.7;
    }
    #ilh-empty .ilh-hint {
      font-size: 10px; opacity: 0.7;
      display: block; margin-top: 6px;
    }
  `);

  /* ═══════════════════════════════════════════════════════════
     📝  LOG
     ═══════════════════════════════════════════════════════════ */
  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const logEl = document.getElementById('ilh-log');
    if (logEl) {
      const entry = document.createElement('div');
      entry.className = `ilh-log-entry ilh-log-${type}`;
      entry.innerHTML = `<span class="ilh-log-time">${time}</span>${escapeHtml(msg)}`;
      logEl.appendChild(entry);
      while (logEl.children.length > CONFIG.logMaxLines) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(`[ILH ${time}] ${msg}`);
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  /* ═══════════════════════════════════════════════════════════
     🔍  EXTRACTION
     用多策略防御式抽取, 任一策略失败时降级到下一个
     ═══════════════════════════════════════════════════════════ */

  /** 主入口: 抽取当前题目, 返回结构化对象或 null */
  function extractQuestion() {
    state.extractCount++;
    try {
      // [1] 先找到位置标识 "第 X/Y 题" - 这是最稳定的锚点
      const positionInfo = findPosition();
      if (!positionInfo) {
        log('❌ 未找到 "第 X/Y 题" 文本标识', 'error');
        return null;
      }

      // [2] 找题型 (单选/多选/判断)
      const questionType = findQuestionType();

      // [3] 找题干 (以题号开头的文本块, 如 "1、xxx" 或 "39、xxx")
      const stem = findStem(positionInfo.position);
      if (!stem || stem.length < CONFIG.minStemLength) {
        log(`❌ 题干抽取失败 (长度 ${stem ? stem.length : 0})`, 'error');
        return null;
      }

      // [4] 找选项 (A./B./C./...)
      const options = findOptions();
      // (无选项时的提示移到 handleQuestionChange,避免重复抽取时刷屏)

      // [5] 生成题目唯一ID(供未来缓存复用)
      const id = `q${positionInfo.position}_${hashString(stem.substring(0, 60))}`;

      return {
        id,
        type: questionType,
        position: positionInfo.position,
        total: positionInfo.total,
        stem,
        options,
        extractedAt: Date.now(),
      };
    } catch (e) {
      state.extractFailCount++;
      log(`❌ 抽取异常: ${e.message}`, 'error');
      console.error('[ILH] Extract error:', e);
      return null;
    }
  }

  /** 找 "第 X/Y 题" — 走 TreeWalker 在文本节点里搜 */
  function findPosition() {
    const re = /第\s*(\d+)\s*\/\s*(\d+)\s*题/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      if (text.length > 200) continue; // 跳过大段文本节点
      const m = text.match(re);
      if (m) {
        return { position: parseInt(m[1], 10), total: parseInt(m[2], 10) };
      }
    }
    return null;
  }

  /** 找题型 — 在短文本节点里找 "单选题"/"多选题"/"判断题" */
  function findQuestionType() {
    const types = ['单选题', '多选题', '判断题'];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 5) continue;
      for (const t of types) if (text === t) return t;
    }
    return '未知题型';
  }

  /**
   * 找题干 — 找以 "<position>、" 开头的元素
   * iLearning 题干格式: "39、PDCP阶段的合作计划制定..."
   */
  function findStem(expectedPosition) {
    // 注意: 题号可能用中文顿号 "、" 也可能用 "."
    const stemStartRe = new RegExp(`^\\s*${expectedPosition}\\s*[、\\.,，]\\s*(.+)`, 's');

    // 优先扫常见的内容容器
    const containers = document.body.querySelectorAll(
      'div, p, span, h1, h2, h3, h4, label, section, article'
    );

    let bestCandidate = null;
    for (const el of containers) {
      const text = el.textContent.trim();
      if (text.length < CONFIG.minStemLength || text.length > 3000) continue;

      const m = text.match(stemStartRe);
      if (!m) continue;

      // 候选: 取题号后面的内容,截断到第一个 "A. " 之前(剔除选项)
      const afterNum = m[1];
      const beforeOptions = afterNum.split(/\s*\n?\s*[A-Z]\s*[\.、,，]\s/)[0].trim();

      if (beforeOptions.length < CONFIG.minStemLength) continue;

      // 选最短的有效候选(避免拿到包含选项的大容器)
      if (!bestCandidate || beforeOptions.length < bestCandidate.length) {
        bestCandidate = beforeOptions;
      }
    }
    return bestCandidate;
  }

  /**
   * 找选项 A. B. C. D. ...
   * 多策略防御式抽取(因为选项的字母和内容可能在不同 DOM 节点里)
   */
  function findOptions() {
    const optRe = /^\s*([A-Z])\s*[\.、,，]\s*(.+)/s;

    // 策略 A (主):查 [class*="option-list-item"] 容器, 取整个容器的拼接文本
    // iLearning 选项DOM: <div class="option-list-item"> 内含 .option-order-str("A. ") + .content("产品组合SDT")
    // 直接读 item.textContent 会拼成 "A. 产品组合SDT" - 这是最稳定的提取方式
    let opts = extractOptionsFromContainers(
      '[class*="option-list-item"], [class*="option-item"]',
      optRe
    );
    if (opts.length > 0) {
      log(`  └ 选项策略A命中(option-list-item 容器): ${opts.length} 个`, 'info');
      return opts;
    }

    // 策略 B (备):查 [class*="option-content"] (排除 wrapper/list 等外层)
    opts = extractOptionsFromContainers('[class*="option-content"]', optRe);
    if (opts.length > 0) {
      log(`  └ 选项策略B命中(option-content 容器): ${opts.length} 个`, 'info');
      return opts;
    }

    // 策略 C (兜底):TreeWalker 单文本节点匹配(适用于扁平结构)
    opts = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length === 0 || text.length > 600) continue;
      const m = text.match(optRe);
      if (m) {
        const letter = m[1];
        const content = m[2].trim();
        if (!seen.has(letter) && content.length > 0) {
          seen.add(letter);
          opts.push({ letter, content });
        }
      }
    }
    if (opts.length > 0) {
      opts.sort((a, b) => a.letter.localeCompare(b.letter));
      log(`  └ 选项策略C命中(单文本节点): ${opts.length} 个`, 'info');
    }
    return opts;
  }

  /** 通用工具:从一组容器里抽取选项, 每个容器的 textContent 应该形如 "A. xxx" */
  function extractOptionsFromContainers(selector, optRe) {
    const items = document.querySelectorAll(selector);
    const opts = [];
    const seen = new Set();
    for (const item of items) {
      // 折叠所有空白(空格/换行/制表)为单个空格
      const text = item.textContent.replace(/\s+/g, ' ').trim();
      if (text.length === 0 || text.length > 800) continue;
      const m = text.match(optRe);
      if (m) {
        const letter = m[1];
        const content = m[2].trim();
        if (!seen.has(letter) && content.length > 0 && content.length < 800) {
          seen.add(letter);
          opts.push({ letter, content });
        }
      }
    }
    opts.sort((a, b) => a.letter.localeCompare(b.letter));
    return opts;
  }

  /** 简单字符串哈希,用于题目唯一 ID */
  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  /* ═══════════════════════════════════════════════════════════
     🎨  UI
     ═══════════════════════════════════════════════════════════ */
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'ilh-panel';
    panel.innerHTML = `
      <div id="ilh-header">
        <span class="ilh-dot idle"></span>
        <span class="ilh-title">📚 学习助手</span>
        <span class="ilh-stage">${STAGE_LABEL}</span>
        <span class="ilh-toggle" id="ilh-toggle-panel" title="折叠/展开">━</span>
      </div>
      <div id="ilh-status" class="idle">⏸ 等待识别题目...</div>
      <div id="ilh-question">
        <div id="ilh-empty">尚未识别到题目<span class="ilh-hint">切换到任意题目即可触发抽取</span></div>
      </div>
      <div id="ilh-actions">
        <button class="ilh-btn" id="ilh-btn-copy">📋 复制题目</button>
        <button class="ilh-btn" id="ilh-btn-rescan">🔄 重新抽取</button>
        <button class="ilh-btn" id="ilh-btn-dump">🐛 DOM 快照</button>
      </div>
      <div id="ilh-log-section">
        <div id="ilh-log-header">
          <span>📝 调试日志</span>
          <span id="ilh-log-toggle">▼</span>
        </div>
        <div id="ilh-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 折叠/展开
    document.getElementById('ilh-toggle-panel').addEventListener('click', () => {
      state.panelCollapsed = !state.panelCollapsed;
      panel.classList.toggle('collapsed', state.panelCollapsed);
    });
    // 日志折叠
    document.getElementById('ilh-log-header').addEventListener('click', () => {
      state.logCollapsed = !state.logCollapsed;
      document.getElementById('ilh-log').classList.toggle('collapsed', state.logCollapsed);
      document.getElementById('ilh-log-toggle').textContent = state.logCollapsed ? '▶' : '▼';
    });
    // 复制题目
    document.getElementById('ilh-btn-copy').addEventListener('click', () => {
      if (!state.currentQuestion) return log('⚠️ 暂无识别到的题目', 'warn');
      const text = formatQuestionForCopy(state.currentQuestion);
      navigator.clipboard.writeText(text).then(
        () => log('✅ 题目已复制到剪贴板', 'success'),
        (e) => log(`❌ 复制失败: ${e.message}`, 'error')
      );
    });
    // 重新抽取
    document.getElementById('ilh-btn-rescan').addEventListener('click', () => {
      log('🔄 手动触发重新抽取', 'info');
      handleQuestionChange(true);
    });
    // DOM 快照(给 Claude 调试用)
    document.getElementById('ilh-btn-dump').addEventListener('click', () => {
      const snapshot = captureDomSnapshot();
      navigator.clipboard.writeText(snapshot).then(
        () => log(`✅ DOM 快照已复制(${snapshot.length} 字符), 抽取失败时贴给 Claude 看`, 'success'),
        (e) => log(`❌ 复制失败: ${e.message}`, 'error')
      );
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
      el.style.top  = (e.clientY - dy) + 'px';
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
    if (dot) {
      dot.className = 'ilh-dot' + (level ? ' ' + level : '');
    }
  }

  function renderQuestion(q) {
    const c = document.getElementById('ilh-question');
    if (!c) return;
    if (!q) {
      c.innerHTML = '<div id="ilh-empty">尚未识别到题目</div>';
      return;
    }
    const optionsHtml = q.options.length > 0
      ? `<div class="ilh-options">${q.options.map(o => `
           <div class="ilh-option"><span class="ilh-option-letter">${escapeHtml(o.letter)}.</span>${escapeHtml(o.content)}</div>
         `).join('')}</div>`
      : (q.type === '判断题'
          ? '<div style="opacity:0.6;font-size:11px">(判断题无选项)</div>'
          : '<div style="opacity:0.5;font-size:11px;color:#ffb74d">⚠️ 未识别到选项</div>');

    c.innerHTML = `
      <div class="ilh-meta">
        <span class="ilh-pill">${escapeHtml(q.type)}</span>
        <span class="ilh-pill position">第 ${q.position}/${q.total} 题</span>
        <span class="ilh-pill id" title="题目唯一ID">${escapeHtml(q.id)}</span>
      </div>
      <div class="ilh-stem">${escapeHtml(q.stem)}</div>
      ${optionsHtml}
    `;
  }

  function formatQuestionForCopy(q) {
    let t = `[${q.type}] 第 ${q.position}/${q.total} 题\n\n${q.stem}\n`;
    if (q.options.length > 0) t += '\n' + q.options.map(o => `${o.letter}. ${o.content}`).join('\n');
    return t;
  }

  /** 抓取关键 DOM 区域,用于调试 */
  function captureDomSnapshot() {
    // 限制大小,只取主要内容容器
    const main = document.querySelector('main, [class*="exam"], [class*="content"], [class*="question"]') || document.body;
    const html = main.outerHTML.substring(0, 30000);
    return [
      `=== iLearning DOM Snapshot ===`,
      `URL: ${location.href}`,
      `Time: ${new Date().toISOString()}`,
      `Extract count: ${state.extractCount}, fails: ${state.extractFailCount}`,
      `Current question ID: ${state.lastQuestionId || 'none'}`,
      ``,
      `=== HTML (max 30000 chars) ===`,
      html,
    ].join('\n');
  }

  /* ═══════════════════════════════════════════════════════════
     👀  OBSERVER  (监听切题)
     ═══════════════════════════════════════════════════════════ */
  let extractTimer = null;

  function handleQuestionChange(force = false) {
    clearTimeout(extractTimer);
    extractTimer = setTimeout(() => {
      const q = extractQuestion();
      if (!q) {
        if (force || state.lastQuestionId === null) {
          setStatus('error', '⚠️ 题目识别失败 — 查看日志');
        }
        return;
      }
      // 题目没变就不刷UI
      if (!force && state.lastQuestionId === q.id) return;

      state.currentQuestion = q;
      state.lastQuestionId = q.id;
      renderQuestion(q);
      setStatus('', `✅ 第 ${q.position}/${q.total} 题已识别 · ${q.type}`);

      // 仅在题目真的变了时,才提示无选项(避免 MutationObserver 重复触发刷屏)
      if (q.options.length === 0 && q.type !== '判断题') {
        log(`⚠️ 第 ${q.position} 题未识别到选项`, 'warn');
      }
    }, CONFIG.extractDebounceMs);
  }

  function setupObserver() {
    const observer = new MutationObserver(() => handleQuestionChange());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // 不监听 characterData 以避免页面计时器干扰
    });
    log('👀 MutationObserver 已启动', 'info');
  }

  /* ═══════════════════════════════════════════════════════════
     🚀  INIT
     ═══════════════════════════════════════════════════════════ */
  function init() {
    if (!document.body) { setTimeout(init, 100); return; }

    buildPanel();
    log(`✅ iLearning 学习助手 v${VERSION} 已加载`, 'success');
    log(`🎯 当前阶段: ${STAGE_LABEL} (仅验证 DOM 抽取)`, 'info');
    log(`🌐 ${location.pathname}${location.search}`, 'info');

    // 首次抽取(等 SPA 渲染完)
    setTimeout(() => handleQuestionChange(true), 800);
    // 启动观察器
    setupObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
