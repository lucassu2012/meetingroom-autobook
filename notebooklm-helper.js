// ==UserScript==
// @name         iLearning 学习助手 - NotebookLM 端 (Stage 2)
// @namespace    https://github.com/lucassu2012/
// @version      0.4.0
// @description  在 NotebookLM 上自动化输入题目、提交、抓取解析(Stage 2: 不连 iLearning, 手动测试)
// @author       Lucas
// @match        https://notebooklm.google.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/notebooklm-helper.js
// @downloadURL  https://raw.githubusercontent.com/lucassu2012/meetingroom-autobook/main/notebooklm-helper.js
// ==/UserScript==

// CHANGELOG
// v0.4.0 - 🔥关键修复: 排除浮窗自身的 textarea/button (之前会把我自己的 textarea 当成 NotebookLM 输入框); 找按钮加重试机制
// v0.3.0 - 输入注入改用 execCommand (穿透 Web Component); 空间约束放宽; 允许 disabled 按钮候选; 探测面板列出周围所有按钮
// v0.2.0 - Enter主路提交策略; 找按钮加空间约束+黑/白名单(避免选到"收起Studio"); 响应噪音阈值 30→150
// v0.1.2 - 修复 Trusted Types CSP 拦截 (NotebookLM 禁止直接 innerHTML 赋值); 浮窗现在能在 NotebookLM 渲染
// v0.1.1 - 拓宽 @match (整个 notebooklm.google.com); @run-at 改为 document-idle (SPA 友好); 加入顶层无条件诊断日志
// v0.1.0 - Stage 2 初版

// 🔔 顶层诊断日志: 不在任何函数/IIFE 内, 一定会打印
// 如果在 Console 看不到这些, 说明脚本根本没注入
console.log('[NLH-DIAG] 🔔 脚本文件已加载');
console.log('[NLH-DIAG] location.href =', location.href);
console.log('[NLH-DIAG] location.pathname =', location.pathname);
console.log('[NLH-DIAG] document.readyState =', document.readyState);
console.log('[NLH-DIAG] GM_addStyle 类型 =', typeof GM_addStyle);

// 🛡️ Trusted Types 兼容层 (NotebookLM/Gmail 等 Google 产品启用了 require-trusted-types-for)
// 不处理这个, innerHTML = "..." 会被直接拦截
const __trustedHTMLPolicy = (() => {
  if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
    try {
      const p = window.trustedTypes.createPolicy('nlh-policy', { createHTML: (s) => s });
      console.log('[NLH-DIAG] ✅ TrustedTypes policy 已创建');
      return p;
    } catch (e) {
      console.log('[NLH-DIAG] ⚠️ TrustedTypes policy 创建被 CSP 拒绝, 将使用 DOMParser fallback:', e.message);
      return null;
    }
  }
  console.log('[NLH-DIAG] (页面未启用 TrustedTypes, 直接 innerHTML 即可)');
  return null;
})();

/** 安全地设置一个 element 的 innerHTML, 自动处理 Trusted Types 限制 */
function __setSafeInnerHTML(el, htmlString) {
  // 路线 A: 有 policy 就直接用
  if (__trustedHTMLPolicy) {
    el.innerHTML = __trustedHTMLPolicy.createHTML(htmlString);
    return;
  }
  // 路线 B: 用 DOMParser 解析(不经 Trusted Types sink)
  try {
    while (el.firstChild) el.removeChild(el.firstChild);
    const doc = new DOMParser().parseFromString(htmlString, 'text/html');
    while (doc.body.firstChild) el.appendChild(doc.body.firstChild);
    return;
  } catch (e) {
    console.error('[NLH] DOMParser fallback 也失败了:', e);
    // 路线 C: 最后兜底 - 至少保留文本
    el.textContent = '[渲染失败, 看 Console 报错]';
  }
}

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     ⚙️  CONFIG
     ═══════════════════════════════════════════════════════════ */
  const VERSION = '0.4.0';
  const STAGE_LABEL = 'Stage 2';

  const CONFIG = {
    submitWaitMs: 600,             // 输入后等多久再点提交
    responseInitialDelayMs: 1500,  // 提交后, 等多久开始监听响应
    pollIntervalMs: 500,           // 响应增长检查频率
    silenceTimeoutMs: 5000,        // 内容静默 N 秒视为完成
    maxResponseWaitMs: 180000,     // 最长等 3 分钟
    minResponseChars: 150,         // 响应至少这么长才算有效 (过滤 UI 文字变化的噪音)
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
      __setSafeInnerHTML(entry, `<span class="nlh-log-time">${time}</span>${escapeHtml(msg)}`);
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
      if (el.closest('#nlh-panel')) return; // v0.4.0: 排除自己浮窗里的 textarea
      if (isVisible(el) && !el.disabled && !el.readOnly) {
        candidates.push({ el, score: areaScore(el) + 100 }); // textarea 加分
      }
    });
    // contenteditable
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      if (el.closest('#nlh-panel')) return; // v0.4.0
      if (isVisible(el)) {
        candidates.push({ el, score: areaScore(el) });
      }
    });
    if (candidates.length === 0) return null;
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
   * 找提交按钮 - v0.2.0 重写: 空间约束 + 黑/白名单
   * 旧版"找最右边的button"会错选 Studio 收起按钮(它在屏幕最右)
   * 新版要求按钮必须和输入框水平相邻且垂直对齐
   */
  function findSubmitButton(inputEl) {
    if (!inputEl) return null;
    const inputRect = inputEl.getBoundingClientRect();
    const inputCenterY = (inputRect.top + inputRect.bottom) / 2;

    // 黑名单: 含这些关键词的按钮一律不选
    const BLACKLIST = [
      '收起', '展开', '关闭', '打开', 'studio', '面板', 'panel',
      'collapse', 'expand', 'close', 'open', 'sidebar', 'menu',
      '设置', 'settings', '帮助', 'help', '更多', 'more', '选项', 'options',
      '分享', 'share', '创建', 'create', '保存', 'save',
      '复制', 'copy', '粘贴', 'paste', '撤销', 'undo',
      'thumb_up', 'thumb_down', '点赞', '点踩', 'like', 'dislike',
    ];
    // 白名单: 含这些的优先选
    const POSITIVE = ['send', 'submit', '发送', '提交', 'arrow_upward', 'arrow_forward'];

    const getBtnText = (btn) =>
      ((btn.getAttribute('aria-label') || '') + ' ' +
       (btn.getAttribute('title') || '') + ' ' +
       btn.textContent).toLowerCase();

    const isBlacklisted = (btn) => {
      const text = getBtnText(btn);
      return BLACKLIST.some((kw) => text.includes(kw.toLowerCase()));
    };
    const isPositive = (btn) => {
      const text = getBtnText(btn);
      return POSITIVE.some((kw) => text.includes(kw.toLowerCase()));
    };

    const candidates = [];
    document.querySelectorAll('button, [role="button"]').forEach((btn) => {
      if (btn.closest('#nlh-panel')) return; // v0.4.0: 排除自己浮窗里的按钮
      if (!isVisible(btn)) return;
      // v0.3.0: 不再排除 disabled (execCommand 注入后 disabled 会变 enabled)
      if (isBlacklisted(btn)) return;

      const rect = btn.getBoundingClientRect();
      const btnCenterY = (rect.top + rect.bottom) / 2;

      // 空间约束 1: 和输入框同一水平区域 (v0.3.0: 80→120)
      const verticalDist = Math.abs(btnCenterY - inputCenterY);
      if (verticalDist > 120) return;

      // 空间约束 2: 在输入框右侧或与输入框重叠 (v0.3.0: 放宽到 -200~+200)
      const horizontalGap = rect.left - inputRect.right;
      if (horizontalGap < -200 || horizontalGap > 200) return;

      // 评分: 距离越近分越低; 含正面关键词减 1000 优先; disabled 加 100 (其他条件相同时优先 enabled)
      let score = verticalDist + Math.abs(horizontalGap);
      if (isPositive(btn)) score -= 1000;
      if (btn.disabled) score += 100;
      candidates.push({ btn, score, isPositive: isPositive(btn), disabled: btn.disabled });
    });

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);

    // 调试: 列出 top 3 候选
    const top = candidates.slice(0, Math.min(3, candidates.length));
    log(`  └ 按钮候选 (top ${top.length}):`, 'debug');
    top.forEach((c, i) => {
      const posTag = c.isPositive ? '🎯' : '  ';
      const disTag = c.disabled ? '🔒disabled' : '✓enabled';
      log(`     ${posTag} ${i + 1}. ${describeEl(c.btn)} score=${c.score.toFixed(0)} ${disTag}`, 'debug');
    });

    return candidates[0].btn;
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

  async function setInputValue(el, text) {
    el.focus();
    await sleep(80);
    const tag = el.tagName.toLowerCase();

    // 主路: execCommand 'insertText' - 浏览器原生命令, 触发完整事件链
    // 兼容 React / Angular / Lit / Web Components, 比 nativeSetter 更可靠
    try {
      // 全选并删除现有内容
      if (tag === 'textarea' || tag === 'input') {
        el.select();
      } else {
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
        log('  └ 输入注入: execCommand 成功', 'debug');
        return;
      }
    } catch (e) {
      log(`  ⚠️ execCommand 抛错: ${e.message}, 切换到 fallback`, 'debug');
    }

    // Fallback: native setter (老办法)
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      log('  └ 输入注入: nativeSetter (fallback)', 'debug');
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text,
      }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      log('  └ 输入注入: contenteditable textContent (fallback)', 'debug');
    }
  }

  /** 模拟按 Enter 提交 */
  function pressEnter(el) {
    el.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** 读输入框的当前内容 */
  function readInputValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') return el.value || '';
    return el.textContent || '';
  }

  /**
   * 提交消息 - v0.2.0 双策略
   * 主路: Enter 键 (NotebookLM 标准聊天 UI, Enter 即发送)
   * 通过"输入框是否被清空"判断 Enter 是否真的触发了提交
   * 兜底: 找发送按钮点击 (用新的空间约束算法)
   */
  async function submitMessage(inputEl) {
    const beforeValue = readInputValue(inputEl).trim();

    // 主路: Enter
    log('  ⌨️ 尝试 Enter 键提交', 'info');
    pressEnter(inputEl);
    await sleep(800);

    const afterValue = readInputValue(inputEl).trim();
    // 输入框被清空 = Enter 触发了提交
    if (beforeValue && !afterValue) {
      log('  ✅ Enter 提交成功 (输入框已被清空)', 'success');
      return 'enter';
    }
    // 内容变化但没空 - 也认为提交了
    if (beforeValue && afterValue !== beforeValue) {
      log('  ✅ Enter 提交成功 (输入框内容已变化)', 'success');
      return 'enter';
    }

    log('  ⚠️ Enter 似乎没触发提交, 尝试找发送按钮兜底', 'warn');

    // 兜底: 按钮 (v0.4.0: 重试找 enabled, execCommand 后框架可能需要 100-500ms 切 disabled→enabled)
    let btn = null;
    for (let i = 0; i < 5; i++) {
      btn = findSubmitButton(inputEl);
      if (btn && !btn.disabled) {
        log(`  ✓ 找到 enabled 按钮 (第 ${i + 1} 次尝试)`, 'debug');
        break;
      }
      if (btn) {
        log(`  ⏳ 按钮还是 disabled (第 ${i + 1}/5 次), 等 400ms`, 'debug');
      } else {
        log(`  ⏳ 还没找到按钮 (第 ${i + 1}/5 次), 等 400ms`, 'debug');
      }
      await sleep(400);
    }

    if (btn) {
      log(`  🖱 点击按钮: ${describeEl(btn)} (disabled=${btn.disabled})`, 'success');
      btn.click();
      await sleep(800);
      const afterBtnValue = readInputValue(inputEl).trim();
      if (beforeValue && afterBtnValue !== beforeValue) {
        return 'button';
      }
      if (btn.disabled) {
        log('  ❌ 按钮始终是 disabled, 提交可能失败', 'error');
      } else {
        log('  ⚠️ 点了按钮但输入框未变, 仍当作已提交继续等响应', 'warn');
      }
      return 'button';
    }

    log('  ❌ 没找到符合条件的发送按钮 (空间约束+白/黑名单都无候选)', 'error');
    return null;
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
      await setInputValue(inputEl, questionText);
      state.submittedQuestionText = questionText;
      await sleep(CONFIG.submitWaitMs);

      // [3] 拍快照, 准备捕获响应
      log('📍 [3/5] 给页面文本拍快照(用于响应增长检测)', 'info');
      state.elementSnapshot = snapshotPageText();
      log(`  └ 快照覆盖 ${state.elementSnapshot.size} 个文本元素`, 'debug');

      // [4] 提交 (v0.2.0: Enter 主路 + 按钮兜底)
      setStatus('busy', '📤 提交中...');
      log('📍 [4/5] 提交问题', 'info');
      const submitMethod = await submitMessage(inputEl);
      if (!submitMethod) {
        setStatus('error', '❌ 提交失败');
        return;
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
    __setSafeInnerHTML(panel, `
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
    if (!input) {
      log('❌ 未找到输入框', 'error');
      return;
    }
    log(`✅ 输入框: ${describeEl(input)}`, 'success');
    flashHighlight(input, '#26a69a');
    const ir = input.getBoundingClientRect();
    log(`  └ 位置 x=${ir.left.toFixed(0)} y=${ir.top.toFixed(0)} w=${ir.width.toFixed(0)} h=${ir.height.toFixed(0)}`, 'debug');

    // 现行算法的最佳候选
    const btn = findSubmitButton(input);
    if (btn) {
      log(`✅ 算法选中按钮: ${describeEl(btn)}`, 'success');
      flashHighlight(btn, '#ffb300');
      const r = btn.getBoundingClientRect();
      log(`  └ 位置 x=${r.left.toFixed(0)} y=${r.top.toFixed(0)} disabled=${btn.disabled}`, 'debug');
    } else {
      log('⚠️ 算法未找到符合条件的按钮', 'warn');
    }

    // v0.3.0 诊断: 列出输入框周围所有按钮 (不论 enabled/disabled, 不论黑名单)
    log('📊 [诊断] 输入框附近 (垂直<200px, 水平<400px) 所有 button:', 'info');
    const inputCenterY = (ir.top + ir.bottom) / 2;
    const allBtns = [];
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      if (b.closest('#nlh-panel')) return; // v0.4.0: 排除自己浮窗
      if (!isVisible(b)) return;
      const r = b.getBoundingClientRect();
      const verticalDist = Math.abs((r.top + r.bottom) / 2 - inputCenterY);
      const horizontalGap = r.left - ir.right;
      if (verticalDist > 200 || Math.abs(horizontalGap) > 400) return;
      allBtns.push({ b, verticalDist, horizontalGap, disabled: b.disabled });
    });
    allBtns.sort((a, b) => (Math.abs(a.horizontalGap) + a.verticalDist) - (Math.abs(b.horizontalGap) + b.verticalDist));
    if (allBtns.length === 0) {
      log('  ⚠️ 输入框附近完全没有 button', 'warn');
    } else {
      allBtns.slice(0, 10).forEach((c, i) => {
        const dis = c.disabled ? '🔒' : '✓';
        log(`  ${i + 1}. ${dis} ${describeEl(c.b)} | vert=${c.verticalDist.toFixed(0)} horiz=${c.horizontalGap.toFixed(0)}`, 'debug');
      });
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
    console.log('[NLH-DIAG] init() 被调用, document.body =', !!document.body);
    if (!document.body) { setTimeout(init, 100); return; }

    // 路径校验: 只在笔记本页激活
    if (!location.pathname.startsWith('/notebook/')) {
      console.log(`[NLH-DIAG] 不是笔记本页 (${location.pathname}), 浮窗不激活`);
      // 监听路由变化, 跳到 /notebook/ 时再激活
      watchForNotebookEntry();
      return;
    }

    try {
      buildPanel();
      log(`✅ NotebookLM 助手 v${VERSION} 已加载`, 'success');
      log(`🎯 当前阶段: ${STAGE_LABEL} (手动喂题测试)`, 'info');
      log('💡 操作步骤: 1) 粘一道完整题目  2) 点"测试问答"  3) 等 10-30 秒抓取', 'info');
      console.log('[NLH-DIAG] ✅ 浮窗已挂载到 body');
    } catch (e) {
      console.error('[NLH-DIAG] ❌ 浮窗构建失败:', e);
    }
  }

  /** 路由变化监听: 从笔记本列表页进笔记本时不刷新页面 */
  function watchForNotebookEntry() {
    let lastPath = location.pathname;
    const tryActivate = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (location.pathname.startsWith('/notebook/') && !document.getElementById('nlh-panel')) {
          console.log('[NLH-DIAG] 🔀 进入笔记本, 激活浮窗');
          init();
        }
      }
    };
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function () { orig.apply(this, arguments); tryActivate(); };
    });
    window.addEventListener('popstate', tryActivate);
    setInterval(tryActivate, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
