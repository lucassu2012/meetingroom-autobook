// ==UserScript==
// @name         iLearning 学习助手 - NotebookLM 端 (Stage 2)
// @namespace    https://github.com/lucassu2012/
// @version      0.1.0
// @description  在 NotebookLM 上自动化输入题目、提交、抓取解析(Stage 2: 不连 iLearning, 手动测试)
// @author       Lucas
// @match        https://notebooklm.google.com/notebook/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/notebooklm-helper.js
// @downloadURL  https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/notebooklm-helper.js
// ==/UserScript==

// CHANGELOG
// v0.1.0 - Stage 2 初版: 自动输入/提交/等待/抓取响应

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     ⚙️  CONFIG
     ═══════════════════════════════════════════════════════════ */
  const VERSION = '0.1.0';
  const STAGE_LABEL = 'Stage 2';

  const CONFIG = {
    submitWaitMs: 600,             // 输入后等多久再点提交
    responseInitialDelayMs: 1500,  // 提交后, 等多久开始监听响应
    pollIntervalMs: 500,           // 响应增长检查频率
    silenceTimeoutMs: 5000,        // 内容静默 N 秒视为完成
    maxResponseWaitMs: 180000,     // 最长等 3 分钟
    minResponseChars: 30,          // 响应至少这么长才算有效
    panelWidth: 420,
    panelMaxHeight: 720,
    logMaxLines: 100,
  };

  /* ═══════════════════════════════════════════════════════════
     📊  STATE
     ═══════════════════════════════════════════════════════════ */
  const state = {
    busy: false,
    panelCollapsed: false,
    logCollapsed: false,
    lastResponse: null,
    elementSnapshot: null,   // Map<Element, originalTextLength>
    submittedQuestionText: '', // 用于过滤掉问题本身
  };

  /* ═══════════════════════════════════════════════════════════
     🎨  STYLES
     ═══════════════════════════════════════════════════════════ */
  GM_addStyle(`
    #nlh-panel {
      position: fixed; bottom: 24px; right: 24px;
      width: ${CONFIG.panelWidth}px;
      max-height: ${CONFIG.panelMaxHeight}px;
      background: linear-gradient(135deg, #1a2e2a 0%, #1f3a3f 100%);
      color: #e0f2f1;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
      z-index: 2147483646;
      overflow: hidden;
      display: flex; flex-direction: column;
      transition: max-height 0.25s ease;
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
      transition: all 0.2s;
    }
    .nlh-dot.idle { background: #888; box-shadow: none; }
    .nlh-dot.busy { background: #ffb300; box-shadow: 0 0 8px #ffb300; animation: nlh-pulse 1.2s infinite; }
    .nlh-dot.error { background: #f44336; box-shadow: 0 0 8px #f44336; }
    @keyframes nlh-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

    .nlh-title { flex: 1; font-weight: 600; letter-spacing: 0.3px; }
    .nlh-stage {
      font-size: 10px; opacity: 0.65;
      padding: 2px 7px;
      background: rgba(255,255,255,0.07);
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .nlh-toggle {
      cursor: pointer; padding: 2px 6px;
      opacity: 0.5; transition: opacity 0.15s;
      font-family: monospace;
    }
    .nlh-toggle:hover { opacity: 1; }

    #nlh-status {
      padding: 11px 14px;
      font-weight: 500;
      border-left: 3px solid #26a69a;
      background: rgba(38,166,154,0.10);
    }
    #nlh-status.idle  { border-left-color: #666;    background: rgba(255,255,255,0.03); opacity: 0.75; }
    #nlh-status.busy  { border-left-color: #ffb300; background: rgba(255,179,0,0.10); }
    #nlh-status.error { border-left-color: #f44336; background: rgba(244,67,54,0.10); }

    #nlh-test-area {
      padding: 12px 14px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .nlh-label {
      font-size: 11px; opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    #nlh-test-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 10px;
      background: rgba(0,0,0,0.25);
      color: #e0f2f1;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
      min-height: 80px;
      font-family: inherit;
    }
    #nlh-test-input:focus {
      outline: none;
      border-color: rgba(38,166,154,0.6);
      background: rgba(0,0,0,0.35);
    }
    #nlh-test-input::placeholder { color: rgba(255,255,255,0.3); }

    .nlh-buttons { display: flex; gap: 6px; }
    .nlh-btn {
      flex: 1;
      padding: 8px 10px;
      background: rgba(255,255,255,0.06);
      color: #e0f2f1;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .nlh-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.13);
      transform: translateY(-1px);
    }
    .nlh-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .nlh-btn.primary {
      background: linear-gradient(135deg, #26a69a, #00897b);
      border-color: rgba(38,166,154,0.4);
      font-weight: 500;
    }
    .nlh-btn.primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #2bb8aa, #00a085);
    }

    #nlh-response {
      padding: 0 14px 12px;
      max-height: 240px;
      overflow-y: auto;
      display: none;
    }
    #nlh-response.visible { display: block; }
    .nlh-response-header {
      font-size: 11px; opacity: 0.7;
      margin-bottom: 6px;
      display: flex; justify-content: space-between;
    }
    .nlh-response-content {
      padding: 10px 12px;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      border-left: 2px solid #26a69a;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
    }
    .nlh-copy-link {
      cursor: pointer;
      color: #80cbc4;
      font-size: 11px;
      transition: color 0.15s;
    }
    .nlh-copy-link:hover { color: #b2dfdb; }

    #nlh-log-section {
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; flex-direction: column;
    }
    #nlh-log-header {
      padding: 7px 14px;
      font-size: 11px;
      opacity: 0.7;
      cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      user-select: none;
    }
    #nlh-log-header:hover { opacity: 1; }
    #nlh-log {
      padding: 0 14px 10px;
      overflow-y: auto;
      font-size: 11px;
      font-family: "SF Mono", Monaco, Consolas, "Courier New", monospace;
      line-height: 1.55;
      max-height: 160px;
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

  /* ═══════════════════════════════════════════════════════════
     📝  LOG
     ═══════════════════════════════════════════════════════════ */
  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const logEl = document.getElementById('nlh-log');
    if (logEl) {
      const entry = document.createElement('div');
      entry.className = `nlh-log-entry nlh-log-${type}`;
      entry.innerHTML = `<span class="nlh-log-time">${time}</span>${escapeHtml(msg)}`;
      logEl.appendChild(entry);
      while (logEl.children.length > CONFIG.logMaxLines) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(`[NLH ${time}] ${msg}`);
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ═══════════════════════════════════════════════════════════
     🔍  ELEMENT FINDERS  (NotebookLM DOM 探测)
     这部分不依赖任何特定 class 名, 用元素特征找东西, 抗 UI 改版
     ═══════════════════════════════════════════════════════════ */

  /**
   * 找输入框: 找页面中最大的、可见的、可输入的元素
   * 候选: textarea / contenteditable div
   */
  function findInputElement() {
    const candidates = [];
    // textarea
    document.querySelectorAll('textarea').forEach((el) => {
      if (isVisible(el) && !el.disabled && !el.readOnly) {
        candidates.push({ el, score: areaScore(el) + 100 }); // textarea 加分
      }
    });
    // contenteditable
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      if (isVisible(el)) {
        candidates.push({ el, score: areaScore(el) });
      }
    });
    if (candidates.length === 0) return null;
    // 按 score 取最大的
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  /** 元素的可见尺寸分数(面积大 = 更可能是主输入框) */
  function areaScore(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  /** 元素是否可见 */
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  /**
   * 找提交按钮: 从输入框往上找祖先, 取祖先内最右边的可点击 button
   * 这个约定在大多数聊天 UI 都成立(发送按钮在输入框右侧)
   */
  function findSubmitButton(inputEl) {
    if (!inputEl) return null;
    let container = inputEl.parentElement;
    for (let depth = 0; depth < 6 && container; depth++) {
      const buttons = Array.from(container.querySelectorAll('button'))
        .filter((btn) => isVisible(btn) && !btn.disabled);
      if (buttons.length > 0) {
        // 取最右边的(发送按钮通常在最右)
        let rightmost = null, maxX = -Infinity;
        for (const btn of buttons) {
          const rect = btn.getBoundingClientRect();
          if (rect.right > maxX) { maxX = rect.right; rightmost = btn; }
        }
        if (rightmost) {
          log(`  └ 提交按钮: ${describeEl(rightmost)} (祖先深度 ${depth})`, 'debug');
          return rightmost;
        }
      }
      container = container.parentElement;
    }
    return null;
  }

  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
    const aria = el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '';
    return `${tag}${cls}${aria}`;
  }

  /* ═══════════════════════════════════════════════════════════
     ✏️  INPUT INJECTION  (模拟输入到 React 输入框)
     这是关键步骤: 普通的 .value = xxx 不会触发 React 状态更新
     ═══════════════════════════════════════════════════════════ */

  function setInputValue(el, text) {
    el.focus();
    if (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'input') {
      // React-friendly: 使用原生 setter
      const proto = el.tagName.toLowerCase() === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      el.innerHTML = '';
      // 用 InputEvent 让 React 接收到
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true,
        inputType: 'insertText', data: text,
      }));
      // 兜底: 触发 keyup 让某些框架认为输入完成
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }
  }

  /** 模拟按 Enter 提交 (作为找不到按钮时的兜底) */
  function pressEnter(el) {
    el.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /* ═══════════════════════════════════════════════════════════
     📸  RESPONSE CAPTURE (DOM 文本快照对比法)
     提交前: 给所有"长文本块"拍快照(记录其 textLength)
     提交后: 不断观察哪个元素长出最多内容, 那就是响应
     ═══════════════════════════════════════════════════════════ */

  function snapshotPageText() {
    const map = new Map();
    document.querySelectorAll('div, p, article, section, main, span').forEach((el) => {
      const len = el.textContent.length;
      if (len > 30) map.set(el, len);
    });
    return map;
  }

  /**
   * 在快照之后找"长出最多新内容"的元素 = 响应所在
   * 排除策略:
   * - 跳过包含整段题目的元素(那是题目历史, 不是解析)
   * - 选取最深的(避免选到容器), 增长最大的元素
   */
  function findGrowingResponseElement(snapshot, questionText) {
    const candidates = [];
    document.querySelectorAll('div, p, article, section, main, span').forEach((el) => {
      const newLen = el.textContent.length;
      const oldLen = snapshot.get(el) || 0;
      const growth = newLen - oldLen;
      if (growth < CONFIG.minResponseChars) return;
      // 排除那些 textContent 主要是问题本身的元素
      const text = el.textContent;
      if (questionText && text.includes(questionText.substring(0, Math.min(40, questionText.length)))) {
        // 包含问题, 但增长远超问题长度时仍然有效(说明响应也在里面)
        if (growth < questionText.length + CONFIG.minResponseChars) return;
      }
      candidates.push({ el, growth, depth: getDepth(el) });
    });
    if (candidates.length === 0) return null;
    // 选: 最深的(精确到响应文本块), growth 最大的
    candidates.sort((a, b) => {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return b.growth - a.growth;
    });
    // 但是太深的元素可能只是文本片段, 取深度合理的
    return candidates[0].el;
  }

  function getDepth(el) {
    let d = 0;
    let p = el;
    while (p && p !== document.body) { d++; p = p.parentElement; }
    return d;
  }

  /**
   * 等待响应完成: 监听增长, 5 秒静默后认为完成
   */
  async function waitForResponse(snapshot, questionText) {
    const startTs = Date.now();
    let lastLen = 0;
    let lastChangeTs = Date.now();
    let responseEl = null;

    while (Date.now() - startTs < CONFIG.maxResponseWaitMs) {
      await sleep(CONFIG.pollIntervalMs);

      const currentEl = findGrowingResponseElement(snapshot, questionText);
      if (currentEl) {
        responseEl = currentEl;
        const currentLen = currentEl.textContent.length;
        if (currentLen > lastLen) {
          if (lastLen === 0) log(`  ▶ 响应开始, 已抓到 ${currentLen} 字符`, 'debug');
          lastLen = currentLen;
          lastChangeTs = Date.now();
        }
      }

      // 静默检测
      if (lastLen > CONFIG.minResponseChars && (Date.now() - lastChangeTs) > CONFIG.silenceTimeoutMs) {
        log(`  ✓ 响应已稳定 ${Math.round(CONFIG.silenceTimeoutMs / 1000)} 秒, 视为完成`, 'debug');
        return responseEl ? responseEl.textContent.trim() : null;
      }
    }
    log('  ⏱️ 达到最长等待时间, 强制返回当前内容', 'warn');
    return responseEl ? responseEl.textContent.trim() : null;
  }

  /* ═══════════════════════════════════════════════════════════
     🎬  TEST FLOW
     ═══════════════════════════════════════════════════════════ */
  async function runTest(questionText) {
    if (state.busy) return log('⚠️ 还在进行中, 请等当前任务结束', 'warn');
    if (!questionText || questionText.trim().length < 5) {
      return log('⚠️ 题目内容太短, 请粘贴一道完整题目', 'warn');
    }
    state.busy = true;
    setButtonsEnabled(false);
    showResponse(null);

    try {
      // [1] 找输入框
      setStatus('busy', '🔍 寻找输入框...');
      log('📍 [1/5] 寻找输入框', 'info');
      const inputEl = findInputElement();
      if (!inputEl) {
        log('❌ 未找到任何输入框 (textarea / contenteditable)', 'error');
        setStatus('error', '❌ 未找到输入框');
        return;
      }
      log(`  └ 找到: ${describeEl(inputEl)}`, 'debug');

      // [2] 模拟输入
      setStatus('busy', '✏️ 输入题目中...');
      log('📍 [2/5] 输入题目内容', 'info');
      setInputValue(inputEl, questionText);
      state.submittedQuestionText = questionText;
      await sleep(CONFIG.submitWaitMs);

      // [3] 拍快照, 准备捕获响应
      log('📍 [3/5] 给页面文本拍快照(用于响应增长检测)', 'info');
      state.elementSnapshot = snapshotPageText();
      log(`  └ 快照覆盖 ${state.elementSnapshot.size} 个文本元素`, 'debug');

      // [4] 提交
      setStatus('busy', '📤 提交中...');
      log('📍 [4/5] 提交问题', 'info');
      const submitBtn = findSubmitButton(inputEl);
      if (submitBtn) {
        submitBtn.click();
        log(`  └ 已点击提交按钮`, 'success');
      } else {
        log('  ⚠️ 未找到提交按钮, 尝试 Enter 键', 'warn');
        pressEnter(inputEl);
      }
      await sleep(CONFIG.responseInitialDelayMs);

      // [5] 等待响应完成
      setStatus('busy', '⏳ 等待 NotebookLM 回答(可能需 10-30 秒)...');
      log('📍 [5/5] 监听响应增长', 'info');
      const responseText = await waitForResponse(state.elementSnapshot, questionText);

      if (!responseText || responseText.length < CONFIG.minResponseChars) {
        log(`❌ 未抓取到有效响应(长度 ${responseText?.length || 0})`, 'error');
        setStatus('error', '❌ 抓取响应失败');
        return;
      }

      // 成功
      state.lastResponse = responseText;
      log(`✅ 响应抓取成功, 共 ${responseText.length} 字符`, 'success');
      setStatus('', `✅ 已完成 · ${responseText.length} 字符`);
      showResponse(responseText);
    } catch (e) {
      log(`❌ 异常: ${e.message}`, 'error');
      console.error('[NLH] Test error:', e);
      setStatus('error', `❌ ${e.message}`);
    } finally {
      state.busy = false;
      setButtonsEnabled(true);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     🎨  UI
     ═══════════════════════════════════════════════════════════ */
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'nlh-panel';
    panel.innerHTML = `
      <div id="nlh-header">
        <span class="nlh-dot idle"></span>
        <span class="nlh-title">📓 NotebookLM 助手</span>
        <span class="nlh-stage">${STAGE_LABEL}</span>
        <span class="nlh-toggle" id="nlh-toggle-panel" title="折叠/展开">━</span>
      </div>
      <div id="nlh-status" class="idle">⏸ 就绪 · 粘一道题测试</div>
      <div id="nlh-test-area">
        <span class="nlh-label">📝 测试题目(从 iLearning 复制)</span>
        <textarea id="nlh-test-input" placeholder="例如:\n[单选题] 第 1/40 题\n\n采用IPD1.2开发产品组合方案和管理生命周期流程的重量级团队是:\n\nA. 产品组合SDT\nB. 这些团队都是\nC. 行业SDT\nD. SPDT"></textarea>
        <div class="nlh-buttons">
          <button class="nlh-btn primary" id="nlh-btn-test">▶️ 测试问答</button>
          <button class="nlh-btn" id="nlh-btn-detect">🔍 仅探测元素</button>
        </div>
      </div>
      <div id="nlh-response">
        <div class="nlh-response-header">
          <span>💡 抓到的解析</span>
          <span class="nlh-copy-link" id="nlh-btn-copy">📋 复制</span>
        </div>
        <div class="nlh-response-content" id="nlh-response-content"></div>
      </div>
      <div id="nlh-log-section">
        <div id="nlh-log-header">
          <span>📝 调试日志</span>
          <span id="nlh-log-toggle">▼</span>
        </div>
        <div id="nlh-log"></div>
      </div>
    `;
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
    document.getElementById('nlh-btn-test').addEventListener('click', () => {
      const text = document.getElementById('nlh-test-input').value.trim();
      runTest(text);
    });
    document.getElementById('nlh-btn-detect').addEventListener('click', () => {
      runDetectionOnly();
    });
    document.getElementById('nlh-btn-copy').addEventListener('click', () => {
      if (!state.lastResponse) return log('⚠️ 还没有可复制的解析', 'warn');
      navigator.clipboard.writeText(state.lastResponse).then(
        () => log('✅ 解析已复制到剪贴板', 'success'),
        (e) => log(`❌ 复制失败: ${e.message}`, 'error')
      );
    });

    makeDraggable(panel, document.getElementById('nlh-header'));
  }

  function runDetectionOnly() {
    log('🔍 仅探测页面元素(不输入不提交)', 'info');
    const input = findInputElement();
    if (input) {
      log(`✅ 输入框: ${describeEl(input)}`, 'success');
      flashHighlight(input, '#26a69a');
    } else {
      log('❌ 未找到输入框', 'error');
    }
    if (input) {
      const btn = findSubmitButton(input);
      if (btn) {
        log(`✅ 提交按钮: ${describeEl(btn)}`, 'success');
        flashHighlight(btn, '#ffb300');
      } else {
        log('⚠️ 未找到提交按钮(运行时会用 Enter 兜底)', 'warn');
      }
    }
  }

  /** 临时高亮元素(用红框闪 2 秒) */
  function flashHighlight(el, color = '#ff5252') {
    const orig = el.style.outline;
    const origOffset = el.style.outlineOffset;
    el.style.outline = `3px solid ${color}`;
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = orig;
      el.style.outlineOffset = origOffset;
    }, 2200);
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
    const sEl = document.getElementById('nlh-status');
    if (!sEl) return;
    sEl.className = level || '';
    sEl.textContent = text;
    const dot = document.querySelector('#nlh-header .nlh-dot');
    if (dot) dot.className = 'nlh-dot' + (level ? ' ' + level : '');
  }

  function setButtonsEnabled(enabled) {
    document.getElementById('nlh-btn-test').disabled = !enabled;
    document.getElementById('nlh-btn-detect').disabled = !enabled;
  }

  function showResponse(text) {
    const wrap = document.getElementById('nlh-response');
    const content = document.getElementById('nlh-response-content');
    if (!text) {
      wrap.classList.remove('visible');
      return;
    }
    content.textContent = text;
    wrap.classList.add('visible');
  }

  /* ═══════════════════════════════════════════════════════════
     🚀  INIT
     ═══════════════════════════════════════════════════════════ */
  function init() {
    if (!document.body) { setTimeout(init, 100); return; }
    if (!location.pathname.startsWith('/notebook/')) {
      console.log('[NLH] 当前不是笔记本页, 不激活');
      return;
    }
    buildPanel();
    log(`✅ NotebookLM 助手 v${VERSION} 已加载`, 'success');
    log(`🎯 当前阶段: ${STAGE_LABEL} (手动喂题测试)`, 'info');
    log('💡 操作步骤: 1) 粘一道完整题目  2) 点"测试问答"  3) 等 10-30 秒抓取', 'info');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
