// ==UserScript==
// @name         iLearning 学习助手 (Stage 3 桥接版)
// @namespace    https://github.com/lucassu2012/
// @version      0.13.4
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
// v0.13.4 - 紧急修复 v0.13.0 引入的导入 bug: doImportFromCsvText 里 const qId = computeQId(stem, options) 写在 options 声明之前, 触发 temporal dead zone ReferenceError, 被 try-catch 捕获导致每行 skip. 现在调整顺序: 先解析 options 再算 qId. 同时加 Excel 大数字兼容: 导出 examId 用 \"=\"123...\"\" 包裹 (Excel 识别为文本公式不会科学计数法), 导入去壳.
// v0.13.3 - 修复 4 个问题: (1) 启动迁移冲突时不再跳过, 改为合并 (选 status=done 优先 / 时间戳新优先), 清理 v0.13.2 留下的孤儿双份 entry; (2) 撤销自动 fillCourseContext 行为, 改为 cache 命中时按需补全 (新题自动带 courseName/examId, 旧题保持空白直到下次被命中); (3) CSV 导出题型规范化为中文 "单选题/多选题/判断题" (不再 multi/single); CSV 导入识别中文题型保留原值; (4) 移除 "🔧 修复" 按钮 + fixCacheInteractive / fillCourseContext / __fixCacheNow.
// v0.13.2 - 修复 v0.13.0/v0.13.1 升级后两个问题: (1) 自动迁移旧 qId 公式 (脚本启动时静默扫描旧 cache, 用新公式重新算 qId 并改名, 保留所有 req+resp 数据, 解决"之前缓存的题被识别成新题"); (2) 新增"🔧 修复"按钮 (在导入按钮旁), 一键补全 KEY_REQ 缺失的 courseName/examId, 解决"导出 CSV 课程名空白". 旧 console 函数 __migrateLegacyCache 已弃用 (重命名为 __fixCacheNow 走同一逻辑).
// v0.13.1 - CSV 增加"课程名称"和"考试ID"两列, 让每条题目能追溯到具体考试. 课程名称从页面标题 (.title 选择器) 自动提取, 考试ID 从 URL 的 examId 参数解析. 这两个字段同步存储到 KEY_REQ, NotebookLM 端导出也带这两列. 导入功能向下兼容: 旧 CSV (8 列) 仍可导入, 新 CSV (10 列) 自动识别后两列.
// v0.13.0 - [BREAKING] qId 公式变更: 从 hash(stem) 改为 hash(stem + sorted-options-content). 修复"题干相同选项不同"被算同一题的 silent bug (例如 Q19/Q21). 选项按内容字母序排序后参与 hash, 让"打乱顺序的同一题"仍命中同一 qId, 与 detectOptionRemapping 字母重映射功能完美配合. 旧缓存全部失效 (qId 不匹配新公式), 建议导入 CSV 一键重建; 提供 window.__migrateLegacyCache() 控制台辅助函数清空孤儿缓存.
// v0.12.9 - 修复 v0.12.8 布局溢出 (explain 内的 verify/actions 跑到 log 区): 取消 #ilh-explain flex column 强制布局, 改为只固定 .ilh-explain-content 的 height (210px), 让 explain 整体走 normal flow; #ilh-question 和 #ilh-log 用 flex:1 + min-height 共享剩余空间, 整体浮窗高度仍固定.
// v0.12.8 - UI 稳定性: 浮窗整体固定高度 (不随内容变化伸缩), 解析模块固定高度 (内部滚动), 移除"复制解析"按钮 (操作栏更精简). 用 flex 布局让各功能模块各自固定, 日志区分到剩余空间.
// v0.12.7 - 回滚 v0.13.0 (Apple 风格 makeover 导致界面错乱), 恢复 v0.12.6 视觉; 新增"📂 导入题库"按钮: 解析 CSV (8列: 题号/题型/题干/选项/解析答案/是否已编辑/答案核对/处理时间), 完全清空原 GM 缓存, 用 CSV 数据重建 KEY_REQ + KEY_RESP, 题号、状态、答案核对一并恢复; 原"📥 CSV"按钮改名为"📤 导出题库"
// v0.12.6 - 括号内字母重映射纠正: 之前 v0.12.5 只映射第一个字母 (Q32 (A,B)→(B,B) 错误), 现在改为'全部映射' — 预处理时把括号内所有字母都按 mapping 替换 (用户期望)
// v0.12.5 - ① 模式 8 重做: 括号内多字母用 split 拆分, 只替换第一个匹配字母, 解决 (A, C)/(X, Y) 不全映射 ② 新增'答案核对'功能 (3 选 1: 正确/错误/未验证), 持久化到缓存 ③ CSV 导出新增'答案核对'列
// v0.12.4 - 字母重映射补 3 个模式: ① 字母+空格+错误/正确 ("D 错误") ② 字母+顿号/逗号 ("D、E错误") ③ 中文+(字母) ("TR5 (E)"); 用 PLACE+字母+SAFE 三明治防链式替换 bug
// v0.12.3 - 两个修复: ① 选项重排兼容 v0.12.2 之前的旧缓存 (originalOptions 缺失时回退到 KEY_REQ.options) ② 重新请求按钮同时删 KEY_REQ, 让单题重发不再被卡 '已在处理中'
// v0.12.2 - 选项重排 A+B 处理 (警告对照表 + 字母自动重映射) + 干掉启动自动去重 (保留函数+手动按钮)
// v0.12.1 - 三连修复: ① 缓存去重 (旧 q{pos}_xxx 与新 q_xxx 共存导致 1 题多份, 启动时自动跑一次去重 + 手动触发) ② 方向键拦截 (浮窗内按↑↓←→不再误切 iLearning 题) ③ 缓存数 pill 加去重按钮
// v0.12.0 - 4 个修复: ① qId 不再依赖 position (题号变了仍能命中缓存) ② 修 BatchManager 写 KEY_REQ 没 stem 的 bug ③ 统一 iLearning + NotebookLM CSV 格式 (都从 GM 全缓存读, 含批量 prompt 反查兜底) ④ iLearning 加缓存数 UI
// v0.11.0 - 新增编辑解析 + CSV 导出: ① 解析区加✏️编辑按钮, 用户可手动改答案 ② CSV 导出全部题目+答案 (UTF-8 BOM, Excel 中文不乱码)
// v0.10.2 - 修复两个问题: ① MouseEvent view 参数在 Tampermonkey sandbox 报错 → 移除 view 参数 ② startBatchProcessing 仍是阶段A占位 → 改为直接调 BatchManager.flushAll()
// v0.10.1 - 修复 sidebar 切题失败: iLearning 用 <a href=''> 包题号, 单纯 .click() 被 Vue 忽略 → 改用完整 mousedown/mouseup/click 事件序列, 失败重试 3 次
// v0.10.0 - 真正的批量预取 (Stage 3.5): 一个 prompt 含 N 题, NotebookLM 一次返回, 用 ===Q数字=== 分隔; batchSize=20 默认, 失败降级 20→10→5→1
// v0.9.0 - 策略 B 自动遍历: 脚本启动后自动 click sidebar 每道题, 流水线触发识别+入队 NotebookLM
//          已识别的题智能跳过 click 但补充入队, 用户可随时取消, 进度显示在 grid header
// v0.8.1 - UI 紧凑化: ① overview grid 暗色化 ② 删冗余信息 (题目识别状态行/已识别计数/全部识别完成) ③ 批处理控件合并为单行 ④ 题目区扩大
// v0.8.0 - UX 大改进: ① 加状态灯系统 (sidebar dots + 浮窗 overview grid) ② 修复重复提交 ③ 任意题后台完成后自动通知 + 当前题自动刷新解析
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

  // v0.13.4: Excel 兼容 - 把大数字包裹成 ="..." (Excel 当文本不科学计数法)
  function csvWrapBigNumber(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    // 纯数字且长度 > 15 (Excel 精度上限) 才包裹, 否则不动
    if (/^\d{16,}$/.test(v)) return `="${v}"`;
    return v;
  }

  // v0.13.4: 导入时剥掉 ="..." 外壳
  function csvUnwrapBigNumber(s) {
    const v = String(s || '').trim();
    const m = v.match(/^=\"(.+)\"$/);
    return m ? m[1] : v;
  }

  // v0.13.3: 共享 helper - 题型规范化为中文 (iLearning + NotebookLM 两端都能用)
  function normalizeTypeToChinese(t) {
    const s = String(t || '').trim();
    if (s === 'multi' || s === 'multiple') return '多选题';
    if (s === 'single') return '单选题';
    if (s === 'judge' || s === 'tof' || s === 'truefalse') return '判断题';
    if (['单选题', '多选题', '判断题'].includes(s)) return s;
    return s || '单选题';
  }

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
    KEY_NOTIFY: 'ilh:notify',     // v0.8.0: 全局通知 (任何题状态变化都写这里, iLearning 端用一个 listener 监听全部题)
    // v0.10.0: 批量预取协议
    KEY_BATCH_REQ: (id) => `ilh:batch_request:${id}`,
    KEY_BATCH_QUEUE: 'ilh:batch_queue',
    KEY_BATCH_NOTIFY: 'ilh:batch_notify',  // 批次成功/失败的全局通知

    /** iLearning 端: 发 request, 如已有缓存 response 则直接返回 */
    sendRequest(question) {
      const cached = GM_getValue(this.KEY_RESP(question.id), null);
      if (cached && cached.status === 'done') {
        // v0.13.3: cache 命中时, 如果旧 KEY_REQ 没有 courseName/examId, 用当前 question 的值补上
        // (用户要求: 历史缓存等被命中时再补全, 不要全局错误标记)
        try {
          const existingReq = GM_getValue(this.KEY_REQ(question.id), null);
          if (existingReq) {
            let dirty = false;
            if (!existingReq.courseName && question.courseName) {
              existingReq.courseName = question.courseName;
              dirty = true;
            }
            if (!existingReq.examId && question.examId) {
              existingReq.examId = question.examId;
              dirty = true;
            }
            if (dirty) GM_setValue(this.KEY_REQ(question.id), existingReq);
          }
        } catch (e) { /* 静默 */ }
        return cached;
      }

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
      // v0.8.0: 发出请求时也通知 (让 dot 立刻变黄 = pending)
      GM_setValue(this.KEY_NOTIFY, { qId: question.id, status: 'pending', ts: Date.now() });
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
      // v0.12.2: 同时保存 originalOptions/originalStem 快照, 用于后续选项重排检测
      const req = GM_getValue(this.KEY_REQ(qId), null);
      GM_setValue(this.KEY_RESP(qId), {
        id: qId,
        text,
        status,
        error,
        timestamp: Date.now(),
        originalOptions: req && req.options ? req.options : [],
        originalStem: req && req.stem ? req.stem : '',
      });
      const queue = GM_getValue(this.KEY_QUEUE, []);
      GM_setValue(this.KEY_QUEUE, queue.filter((id) => id !== qId));
      GM_setValue(this.KEY_NOTIFY, { qId, status, ts: Date.now() });
    },

    /** NotebookLM 端: 报告心跳(我活着) */
    reportAlive() {
      GM_setValue(this.KEY_STATUS, { alive: true, timestamp: Date.now() });
    },

    /* ───── v0.10.0: 批量预取协议 ───── */
    /** iLearning 端: 发批量请求 */
    sendBatch(batchData) {
      // batchData: { id, prompt, positions, positionMap, batchSize, attempt, questions[] }
      GM_setValue(this.KEY_BATCH_REQ(batchData.id), {
        ...batchData,
        timestamp: Date.now(),
        status: 'pending',
      });
      const queue = GM_getValue(this.KEY_BATCH_QUEUE, []);
      if (!queue.includes(batchData.id)) {
        queue.push(batchData.id);
        GM_setValue(this.KEY_BATCH_QUEUE, queue);
      }
      // v0.12.0: KEY_REQ 写完整 question 数据 (含 stem/options/type), 之前只写了 {id, position} 导致 CSV 题干为空
      const questionsByPos = {};
      (batchData.questions || []).forEach((q) => { questionsByPos[q.position] = q; });
      for (const pos of batchData.positions) {
        const qId = batchData.positionMap[pos];
        const q = questionsByPos[pos];
        GM_setValue(this.KEY_REQ(qId), {
          id: qId,
          position: pos,
          type: q ? q.type : '',
          stem: q ? q.stem : '',
          options: q ? q.options : [],
          total: q ? q.total : 0,
          // v0.13.1: 批量模式也带课程上下文
          courseName: q ? (q.courseName || '') : '',
          examId: q ? (q.examId || '') : '',
          timestamp: Date.now(),
          status: 'pending',
          batchId: batchData.id,
        });
        GM_setValue(this.KEY_NOTIFY, { qId, status: 'pending', ts: Date.now() });
      }
    },

    /** NotebookLM 端: 监听批量队列 */
    onBatchRequest(callback) {
      return GM_addValueChangeListener(
        this.KEY_BATCH_QUEUE,
        (key, oldVal, newVal, remote) => {
          if (newVal && Array.isArray(newVal) && newVal.length > 0) callback();
        }
      );
    },

    /** NotebookLM 端: 取队首批次 */
    peekNextBatch() {
      const queue = GM_getValue(this.KEY_BATCH_QUEUE, []);
      if (queue.length === 0) return null;
      const batchId = queue[0];
      return GM_getValue(this.KEY_BATCH_REQ(batchId), null);
    },

    /** NotebookLM 端: 标记批次完成, 从队列移除 */
    completeBatch(batchId) {
      const queue = GM_getValue(this.KEY_BATCH_QUEUE, []);
      GM_setValue(this.KEY_BATCH_QUEUE, queue.filter((id) => id !== batchId));
    },

    /** NotebookLM 端: 通知批次结果 (success / partial / failed) */
    notifyBatchResult(batchId, status, data = {}) {
      GM_setValue(this.KEY_BATCH_NOTIFY, {
        batchId,
        status,
        ...data,
        ts: Date.now(),
      });
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
      panelMaxHeight: 820,
      requestTimeoutMs: 90000, // 90 秒等不到响应就报错
      nlmCheckIntervalMs: 5000, // 每 5s 检查 NotebookLM 心跳
    };

    /* ───── v0.8.0: 状态灯系统 ───── */
    const StatusDot = {
      // 单题状态推断
      getStatus(qId) {
        if (!qId) return 'idle';
        const resp = GM_getValue(`ilh:response:${qId}`, null);
        if (resp && resp.status === 'done') return 'ready';
        if (resp && resp.status === 'error') return 'error';
        const req = GM_getValue(`ilh:request:${qId}`, null);
        if (req) return 'pending';
        // v0.10.0: 已识别但还没入队也算 pending (用户期望黄色)
        if (batchState.identifiedQuestions.has(qId)) return 'pending';
        return 'idle';
      },
      colorFor(s) {
        return ({ ready: '#22c55e', pending: '#eab308', error: '#ef4444', idle: '#9ca3af' })[s] || '#9ca3af';
      },
      labelFor(s) {
        return ({ ready: '✅ 解析已就绪 · 点开秒回', pending: '⏳ 获取中...', error: '❌ 获取失败 · 可重试', idle: '⚫ 未开始' })[s] || s;
      },

      // 找 iLearning sidebar 里的题项 (用 "第N题" 文本定位, 排除浮窗)
      findSidebarItems() {
        const items = new Map(); // pos -> element
        const RE = /^第\s*(\d+)\s*题\s*(?:[（(]\s*\d+\s*分\s*[)）])?\s*$/;
        document.querySelectorAll('div, span, li, a').forEach((el) => {
          if (el.closest('#ilh-panel')) return;
          if (el.children.length > 5) return;
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 30) return;
          const m = t.match(RE);
          if (m) {
            const pos = parseInt(m[1], 10);
            if (Number.isInteger(pos) && pos >= 1 && pos <= 200) {
              // 取最直接的容器 (子元素少 = 离文本最近)
              const existing = items.get(pos);
              if (!existing || el.children.length < existing.children.length) {
                items.set(pos, el);
              }
            }
          }
        });
        return items;
      },

      // 注入 sidebar dots
      injectSidebarDots() {
        const items = this.findSidebarItems();
        let injected = 0;
        items.forEach((el, pos) => {
          if (el.querySelector('.ilh-sidebar-dot')) return;
          const dot = document.createElement('span');
          dot.className = 'ilh-sidebar-dot';
          dot.dataset.pos = String(pos);
          dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:8px;background:#9ca3af;flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,0.06);transition:background 0.3s,transform 0.2s;vertical-align:middle;';
          dot.title = '⚫ 未开始';
          el.appendChild(dot);
          injected++;
        });
        return injected;
      },

      // 浮窗 overview grid - 4 行 x 10 列 = 40 个小点
      buildOverviewGrid(total = 40) {
        const container = document.getElementById('ilh-overview-grid-content');
        if (!container) return;
        container.innerHTML = '';
        for (let i = 1; i <= total; i++) {
          const dot = document.createElement('span');
          dot.className = 'ilh-grid-dot';
          dot.dataset.pos = String(i);
          dot.title = `第 ${i} 题: ⚫ 未开始`;
          dot.textContent = String(i);
          container.appendChild(dot);
        }
      },

      // 更新单个 dot
      updateOne(position, qId) {
        if (qId) state.qIdToPosition.set(qId, position);
        const status = qId ? this.getStatus(qId) : 'idle';
        const color = this.colorFor(status);
        const label = `第 ${position} 题: ${this.labelFor(status)}`;

        // sidebar dot
        const sbItems = this.findSidebarItems();
        const sbEl = sbItems.get(position);
        if (sbEl) {
          const sbDot = sbEl.querySelector('.ilh-sidebar-dot');
          if (sbDot) {
            sbDot.style.background = color;
            sbDot.title = label;
            if (status === 'pending') {
              sbDot.style.animation = 'ilh-pulse 1.2s ease-in-out infinite';
            } else {
              sbDot.style.animation = '';
            }
          }
        }

        // overview grid dot
        const gridDot = document.querySelector(`.ilh-grid-dot[data-pos="${position}"]`);
        if (gridDot) {
          gridDot.style.background = color;
          gridDot.title = label;
          gridDot.classList.toggle('pending', status === 'pending');
          gridDot.classList.toggle('ready', status === 'ready');
          gridDot.classList.toggle('error', status === 'error');
        }
      },

      // 全量更新
      updateAll() {
        state.qIdToPosition.forEach((pos, qId) => this.updateOne(pos, qId));
      },

      // 通过 qId 找 position 并更新
      updateByQId(qId) {
        const pos = state.qIdToPosition.get(qId);
        if (pos) this.updateOne(pos, qId);
      },

      // MutationObserver 自动注入新出现的 sidebar 项
      setupAutoInject() {
        let timer = null;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const n = this.injectSidebarDots();
            if (n > 0) {
              log(`🎯 注入 ${n} 个 sidebar 状态灯`, 'debug');
              this.updateAll();
            }
          }, 400);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // 初次延迟注入
        setTimeout(() => {
          const n = this.injectSidebarDots();
          if (n > 0) log(`🎯 初始化 ${n} 个 sidebar 状态灯`, 'info');
          this.updateAll();
        }, 1500);
      },
    };

    const state = {
      currentQuestion: null,
      lastQuestionId: null,
      panelCollapsed: false,
      logCollapsed: false,
      activeListeners: new Map(), // qId -> listenerId
      qIdToPosition: new Map(),   // v0.8.0: qId -> position 反向映射 (notify 收到 qId 后能找回 position)
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

    /* ───── v0.9.0: 策略 B 自动遍历 ───── */
    const AutoTraverse = {
      active: false,
      cancelled: false,
      visited: 0,
      total: 0,
      currentPos: null,

      // 找指定 position 对应已识别的 q
      findQuestionByPosition(pos) {
        for (const q of batchState.identifiedQuestions.values()) {
          if (q.position === pos) return q;
        }
        return null;
      },

      // v0.10.0: 标记题已识别 (批量模式下不再单题发请求, BatchManager.flushAll 统一处理)
      ensureQueued(q) {
        if (!q || !q.id) return false;
        state.qIdToPosition.set(q.id, q.position);
        const cached = GM_getValue(`ilh:response:${q.id}`, null);
        if (cached && (cached.status === 'done' || cached.status === 'error')) {
          StatusDot.updateOne(q.position, q.id);
          return false;
        }
        const existingReq = GM_getValue(`ilh:request:${q.id}`, null);
        if (existingReq) {
          StatusDot.updateOne(q.position, q.id);
          return false;
        }
        // 批量模式: 只标记已识别, 不发单题 (StatusDot.getStatus 会因 identifiedQuestions 含此 qId 返回 pending)
        if (batchState.enabled) {
          StatusDot.updateOne(q.position, q.id);  // 触发重算 → 显示 pending (黄)
          return false;
        }
        // 单题模式: 立即发请求
        Bridge.sendRequest(q);
        StatusDot.updateOne(q.position, q.id);
        log(`📤 自动入队 (单题模式): ${q.id} (题号 ${q.position})`, 'info');
        return true;
      },

      async start() {
        if (this.active) return;
        // 等 sidebar 完全渲染
        await sleep(2000);
        const items = StatusDot.findSidebarItems();
        if (items.size === 0) {
          log('⚠️ 未识别到 sidebar 题项, 跳过自动遍历 (你也许在非考试页面)', 'warn');
          return;
        }
        const positions = Array.from(items.keys()).sort((a, b) => a - b);
        this.active = true;
        this.cancelled = false;
        this.visited = 0;
        this.total = positions.length;
        log(`🤖 开始自动遍历 ${positions.length} 道题 (策略 B 流水线模式)`, 'info');
        this.updateUI();

        for (const pos of positions) {
          if (this.cancelled) break;
          this.visited++;
          this.currentPos = pos;
          this.updateUI();

          // 已识别 → 智能跳过 click, 但补充入队
          if (batchState.identifiedPositions.has(pos)) {
            const q = this.findQuestionByPosition(pos);
            if (q) {
              const queued = this.ensureQueued(q);
              if (!queued) {
                // 没新发请求, 至少更新 dot 状态
                StatusDot.updateOne(pos, q.id);
              }
            }
            continue;  // 不点击 sidebar, 不触发渲染, 节省 ~900ms
          }

          // 未识别 → 点击 sidebar 触发渲染 + extractQuestion
          const currItems = StatusDot.findSidebarItems();
          const el = currItems.get(pos);
          if (!el) {
            log(`  ⚠️ 第 ${pos} 题在 sidebar 找不到, 跳过`, 'warn');
            continue;
          }
          // v0.10.1: 用完整 mouse 事件序列 + 多目标重试 (iLearning 是 Vue + <a href=''>, .click() 不生效)
          let switched = false;
          for (let attempt = 1; attempt <= 3 && !switched && !this.cancelled; attempt++) {
            this.robustClick(el, pos);
            // 等 iLearning Vue 渲染 + handleQuestionChange (含 350ms debounce)
            await sleep(attempt === 1 ? 1000 : 1500);
            if (state.currentQuestion && state.currentQuestion.position === pos) {
              switched = true;
              break;
            }
            if (attempt < 3) {
              log(`  🔄 第 ${pos} 题尝试 ${attempt} 失败, 重试...`, 'debug');
            }
          }

          if (this.cancelled) break;

          if (switched) {
            this.ensureQueued(state.currentQuestion);
          } else {
            log(`  ⚠️ 切到第 ${pos} 题失败 (当前: ${state.currentQuestion?.position || '无'}, 重试 3 次仍失败), 跳过`, 'warn');
          }
        }

        this.active = false;
        this.currentPos = null;
        this.updateUI();
        if (this.cancelled) {
          log(`⏹️ 自动遍历已取消, 已识别 ${batchState.identifiedQuestions.size} 题`, 'warn');
          return;
        }
        log(`✅ 自动遍历完成: ${this.visited}/${this.total} 题已识别 (batchState 含 ${batchState.identifiedQuestions.size} 题)`, 'success');

        // v0.10.0: 批量模式下, 识别完毕后触发批量预取
        if (batchState.enabled) {
          log('🚀 触发批量预取...', 'info');
          BatchManager.flushAll();
        }
      },

      // v0.10.2: 强力点击 - mousedown/mouseup/click + native click 多目标重试
      // 注意: Tampermonkey sandbox 下 window 不是真 Window, MouseEvent 不能传 view 参数
      robustClick(el, pos) {
        const li = el.matches('li') ? el : el.closest('li');
        const a = el.matches('a') ? el : (li ? li.querySelector('a') : el.querySelector('a'));
        const span = el.matches('span') ? el : el.querySelector('span');
        // 优先 <li> (避开 <a href=""> 的 navigation 默认行为)
        const candidates = [li, a, span, el].filter((x, i, arr) => x && arr.indexOf(x) === i);

        // 在每个候选目标上都 dispatch 一次, 提高命中率
        const opts = {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX: 0,
          clientY: 0,
        };
        for (const target of candidates) {
          try {
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            // 双保险: 同时调原生 click()
            if (typeof target.click === 'function') target.click();
          } catch (e) {
            log(`  ⚠️ click dispatch 异常 (${target.tagName}): ${e.message}`, 'warn');
          }
        }
      },

      cancel() {
        if (!this.active) return;
        this.cancelled = true;
        log('⏹️ 用户取消自动遍历, 等待当前题处理完再停', 'info');
      },

      updateUI() {
        const ind = document.getElementById('ilh-traverse-indicator');
        const btn = document.getElementById('ilh-traverse-cancel');
        if (!ind) return;
        if (this.active) {
          ind.textContent = `🤖 ${this.visited}/${this.total}` + (this.currentPos ? ` (第 ${this.currentPos} 题)` : '');
          ind.style.display = 'inline-block';
          if (btn) btn.style.display = 'inline-block';
        } else {
          ind.style.display = 'none';
          if (btn) btn.style.display = 'none';
        }
      },
    };

    /* ───── v0.10.0: 真正的批量预取管理 ───── */
    const BatchManager = {
      currentBatchSize: 20,        // 当前批次大小 (会因失败降级)
      consecutiveFailures: 0,      // 连续失败次数 (达 2 触发降级)
      batchHistory: new Map(),     // batchId -> { questions, attempt }

      // 把所有未完成的题按当前 batchSize 切分发送
      flushAll() {
        const allQs = Array.from(batchState.identifiedQuestions.values())
          .sort((a, b) => a.position - b.position);
        const todoQs = allQs.filter((q) => {
          const cached = GM_getValue(`ilh:response:${q.id}`, null);
          if (cached && cached.status === 'done') return false;  // 已完成跳过
          const req = GM_getValue(`ilh:request:${q.id}`, null);
          if (req && req.batchId) {
            // 已经在某批次中
            const b = GM_getValue(`ilh:batch_request:${req.batchId}`, null);
            if (b && b.status === 'pending') return false;  // 还在处理中
          }
          return true;
        });

        if (todoQs.length === 0) {
          log('✅ 所有题已完成或在处理中, 无需批量发送', 'info');
          return;
        }

        const batches = [];
        for (let i = 0; i < todoQs.length; i += this.currentBatchSize) {
          batches.push(todoQs.slice(i, i + this.currentBatchSize));
        }

        log(`🚀 准备发 ${batches.length} 个批次, 每批最多 ${this.currentBatchSize} 题 (共 ${todoQs.length} 题)`, 'info');
        for (const batchQs of batches) {
          this.sendOne(batchQs);
        }
        batchState.batchStarted = true;
        updateBatchPanel();
      },

      // 发送单个批次
      sendOne(questions, attempt = 1) {
        if (questions.length === 0) return;
        const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const positions = questions.map((q) => q.position);
        const positionMap = {};
        questions.forEach((q) => { positionMap[q.position] = q.id; });

        const prompt = this.buildPrompt(questions);

        Bridge.sendBatch({
          id: batchId,
          prompt: prompt,
          positions: positions,
          positionMap: positionMap,
          batchSize: questions.length,
          attempt: attempt,
          questions: questions,  // v0.12.0: 传完整 questions, 让 KEY_REQ 含 stem/options
        });

        this.batchHistory.set(batchId, { questions, attempt });

        // 更新 dots
        questions.forEach((q) => {
          state.qIdToPosition.set(q.id, q.position);
          StatusDot.updateOne(q.position, q.id);
        });

        log(`📦 发出批次 ${batchId.slice(-8)}: ${questions.length} 题 [${positions.slice(0, 5).join(',')}${positions.length > 5 ? '...' : ''}] (尝试 ${attempt})`, 'info');
      },

      // 构造批量 prompt
      buildPrompt(questions) {
        const N = questions.length;
        const parts = [
          `请基于知识库, 严格按以下格式分别给出每道题的正确答案和完整解析。`,
          `规则:`,
          `1. 每道题的解析必须以 "===Q数字===" 标记开头, 数字必须严格对应题号 (例如第 5 题用 ===Q5===)`,
          `2. 不要省略任何一道题, 共 ${N} 题`,
          `3. 每道题先给"正确答案", 再给"完整解析"`,
          ``,
          `下面是 ${N} 道题:`,
          ``,
        ];
        for (const q of questions) {
          parts.push(`===Q${q.position}===`);
          parts.push(`[${q.type}] 第 ${q.position}/${q.total} 题`);
          parts.push(q.stem);
          if (q.options.length > 0) {
            for (const o of q.options) {
              parts.push(`${o.letter}. ${o.content}`);
            }
          }
          parts.push(``);
        }
        parts.push(`请严格按 "===Q数字===" 分隔的格式逐题输出, 不要漏题。`);
        return parts.join('\n');
      },

      // 批次部分成功 (NotebookLM 端通知)
      onBatchPartial(batchId, splitResults, failedPositions) {
        const history = this.batchHistory.get(batchId);
        if (!history) {
          log(`⚠️ 收到未知批次结果 ${batchId.slice(-8)}, 忽略`, 'warn');
          return;
        }
        const total = history.questions.length;
        const successCount = total - failedPositions.length;
        const successRate = successCount / total;

        if (successRate >= 0.7) {
          // 整批视为成功 (>= 70%)
          this.consecutiveFailures = 0;
          log(`✅ 批次 ${batchId.slice(-8)} 完成: ${successCount}/${total} 题 (${(successRate*100).toFixed(0)}%)`, 'success');
          // 失败的少数题, 后续单独重试
          if (failedPositions.length > 0) {
            const failedQs = failedPositions.map((p) => history.questions.find((q) => q.position === p)).filter(Boolean);
            if (failedQs.length > 0) {
              log(`  ↪️ ${failedQs.length} 题没拆出, 单独重试`, 'info');
              setTimeout(() => {
                for (const q of failedQs) this.sendOne([q], 2);
              }, 2000);
            }
          }
        } else {
          // 整批失败
          this.consecutiveFailures++;
          log(`❌ 批次 ${batchId.slice(-8)} 失败: 仅 ${(successRate*100).toFixed(0)}% (连续 ${this.consecutiveFailures} 次失败)`, 'error');
          if (this.consecutiveFailures >= 2) {
            const oldSize = this.currentBatchSize;
            // 降级路径: 20 → 10 → 5 → 1
            if (this.currentBatchSize > 10) this.currentBatchSize = 10;
            else if (this.currentBatchSize > 5) this.currentBatchSize = 5;
            else if (this.currentBatchSize > 1) this.currentBatchSize = 1;
            else this.currentBatchSize = 1;
            log(`📉 batchSize 降级: ${oldSize} → ${this.currentBatchSize}`, 'warn');
            this.consecutiveFailures = 0;
          }
          // 重打包失败的题, 按新 batchSize 发
          const failedQs = failedPositions.map((p) => history.questions.find((q) => q.position === p)).filter(Boolean);
          if (failedQs.length > 0) {
            const sortedFailed = failedQs.sort((a, b) => a.position - b.position);
            for (let i = 0; i < sortedFailed.length; i += this.currentBatchSize) {
              const newBatch = sortedFailed.slice(i, i + this.currentBatchSize);
              setTimeout(() => this.sendOne(newBatch, history.attempt + 1), 2000 * (i / this.currentBatchSize + 1));
            }
          }
        }
      },
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
      // v0.8.1: 大幅简化 - 状态只通过 button disabled + grid 颜色表达, 不再渲染文字
      const startBtn = document.getElementById('ilh-batch-start');
      const panelEl = document.getElementById('ilh-batch-panel');
      if (!startBtn || !panelEl) return;

      panelEl.classList.toggle('disabled', !batchState.enabled);

      if (!batchState.enabled) {
        startBtn.disabled = true;
        startBtn.title = '已关闭批量预取';
        return;
      }

      if (batchState.totalQuestions > 0) {
        const missing = getMissingPositions();
        if (batchState.batchStarted) {
          startBtn.disabled = true;
          startBtn.title = '批处理运行中';
        } else if (missing.length === 0) {
          startBtn.disabled = false;
          startBtn.title = '全部题已识别, 点击启动批处理';
        } else {
          startBtn.disabled = true;
          startBtn.title = `还需识别 ${missing.length} 题: ${compactRanges(new Set(missing))}`;
        }
      } else {
        startBtn.disabled = true;
        startBtn.title = '等待第一题识别';
      }
    }

    function startBatchProcessing() {
      if (batchState.batchStarted) return;
      // v0.10.2: 直接调 BatchManager 真正发批次
      log(`🚀 全部题已识别完毕, 启动真正的批量预取...`, 'info');
      BatchManager.flushAll();
      if (state.currentQuestion) {
        showExplain('waiting', `🚀 批处理已启动\n\n${batchState.identifiedQuestions.size} 道题分批发给 NotebookLM, 每批 ${BatchManager.currentBatchSize} 题\n\n(NotebookLM 处理完会自动同步, 通常 2-3 分钟)`, '批处理中');
      }
    }

    // === STYLES ===
    GM_addStyle(`
      #ilh-panel {
        position: fixed; bottom: 24px; right: 24px;
        width: ${CONFIG.panelWidth}px;
        /* v0.12.8: 固定高度, 不随内容变化伸缩 */
        height: min(${CONFIG.panelMaxHeight}px, calc(100vh - 48px));
        background: linear-gradient(135deg, #1a1d2e 0%, #232842 100%);
        color: #e8eaf6;
        font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06);
        z-index: 2147483646;
        overflow: hidden;
        display: flex; flex-direction: column;
        transition: height 0.25s ease;
      }
      #ilh-panel.collapsed { height: 44px; }

      /* v0.12.8: 各模块固定高度, 不随内容塌缩或撑大 */
      #ilh-panel > #ilh-header,
      #ilh-panel > #ilh-batch-panel,
      #ilh-panel > #ilh-overview-grid {
        flex-shrink: 0;
      }

      /* v0.8.1: overview grid - 暗色系, 与浮窗一致 */
      #ilh-overview-grid {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 6px;
        padding: 7px 10px 9px;
        margin: 8px 12px 0;
        font-size: 11px;
      }
      .ilh-overview-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 6px;
        color: #b0bec5;
        font-weight: 500;
        font-size: 11px;
      }
      .ilh-overview-legend { font-size: 9.5px; color: #78909c; }
      .ilh-overview-legend span { margin-right: 7px; }
      .ilh-overview-legend i {
        display: inline-block; width: 7px; height: 7px; border-radius: 50%;
        margin-right: 3px; vertical-align: middle;
      }
      #ilh-overview-grid-content {
        display: grid;
        grid-template-columns: repeat(10, 1fr);
        gap: 3px;
      }
      .ilh-grid-dot {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 18px;
        border-radius: 3px;
        background: #4a5568;
        color: rgba(255,255,255,0.85);
        font-size: 9px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.3s, transform 0.15s, box-shadow 0.15s;
        user-select: none;
      }
      .ilh-grid-dot:hover {
        transform: scale(1.18);
        box-shadow: 0 2px 6px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.18);
        z-index: 2;
      }
      .ilh-grid-dot.pending { animation: ilh-pulse 1.2s ease-in-out infinite; }

      /* v0.9.0: 自动遍历进度指示 */
      #ilh-traverse-indicator {
        margin-left: 8px;
        padding: 2px 8px;
        font-size: 10px;
        color: #fbbf24;
        background: rgba(251,191,36,0.12);
        border-radius: 10px;
        font-weight: 500;
        animation: ilh-pulse 1.6s ease-in-out infinite;
      }
      .ilh-traverse-cancel-btn {
        margin-left: 5px;
        padding: 1px 6px;
        background: rgba(239,68,68,0.2);
        color: #fca5a5;
        border: 1px solid rgba(239,68,68,0.3);
        border-radius: 3px;
        cursor: pointer;
        font-size: 10px;
        line-height: 1.2;
        transition: background 0.15s;
      }
      .ilh-traverse-cancel-btn:hover {
        background: rgba(239,68,68,0.4);
        color: #fff;
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
      .ilh-toggle { cursor: pointer; padding: 2px 6px; opacity: 0.5; font-family: monospace; }
      .ilh-toggle:hover { opacity: 1; }

      /* v0.8.1: batch-panel 单行紧凑布局 */
      #ilh-batch-panel {
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        background: rgba(33,150,243,0.04);
        font-size: 11px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ilh-batch-toggle {
        display: flex; align-items: center; gap: 5px;
        cursor: pointer;
        font-weight: 500;
        opacity: 0.9;
        white-space: nowrap;
      }
      .ilh-batch-toggle input[type="checkbox"] {
        cursor: pointer;
      }
      .ilh-batch-config {
        display: flex; align-items: center; gap: 5px;
        opacity: 0.9;
        white-space: nowrap;
      }
      .ilh-batch-config input {
        width: 44px; padding: 2px 4px;
        background: rgba(0,0,0,0.28);
        color: #e8eaf6;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 3px;
        font-size: 11px;
        text-align: center;
      }
      #ilh-batch-start {
        margin-left: auto;
        font-size: 10.5px;
        padding: 4px 10px;
        white-space: nowrap;
      }
      #ilh-batch-start:disabled {
        opacity: 0.32; cursor: not-allowed;
      }
      #ilh-batch-panel.disabled {
        opacity: 0.5;
      }
      #ilh-batch-panel.disabled .ilh-batch-config,
      #ilh-batch-panel.disabled #ilh-batch-start {
        opacity: 0.5;
      }

      #ilh-question {
        /* v0.12.9: flex:1 吃剩余空间 (浮窗高度固定, explain 整体自然高度, log 也 flex:1 共享) */
        flex: 1 1 0;
        min-height: 100px;
        padding: 12px 14px;
        overflow-y: auto;
      }
      .ilh-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; align-items: center; }
      .ilh-pill.cache-count {
        background: rgba(34,197,94,0.16);
        color: #86efac;
        cursor: pointer;
        margin-left: auto;
      }
      .ilh-pill.cache-count:hover { background: rgba(34,197,94,0.28); }
      .ilh-pill {
        font-size: 10px; padding: 2px 7px;
        border-radius: 10px;
        background: rgba(33,150,243,0.18);
        color: #90caf9;
      }
      .ilh-pill.position { background: rgba(255,193,7,0.18); color: #ffd54f; }
      .ilh-stem {
        font-size: 13px; line-height: 1.55;
        margin-bottom: 8px;
        color: #f0f3ff;
      }
      .ilh-options { display: flex; flex-direction: column; gap: 5px; }
      .ilh-option {
        font-size: 12px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.04);
        border-radius: 5px;
        line-height: 1.45;
      }
      .ilh-option-letter { font-weight: 600; color: #64b5f6; margin-right: 6px; }

      #ilh-explain {
        /* v0.12.9: 不强制 flex column, 用 normal flow + flex-shrink: 0 (整体高度由内部子元素累加, 但 explain-content 是固定高度的) */
        flex-shrink: 0;
        padding: 12px 14px;
        border-top: 1px solid rgba(255,255,255,0.06);
        background: rgba(0,0,0,0.18);
      }
      .ilh-explain-header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 8px; font-size: 12px;
      }
      .ilh-explain-status { font-size: 10px; opacity: 0.65; }
      .ilh-explain-content {
        /* v0.12.9: 固定高度 210px (解析模块尺寸稳定, 不论内容多少都不撑大) */
        height: 210px;
        background: rgba(34,197,94,0.07);
        border-left: 2px solid #22c55e;
        padding: 10px 12px;
        border-radius: 5px;
        font-size: 12px;
        line-height: 1.6;
        color: #e8f5e9;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-y: auto;
        box-sizing: border-box;
      }
      .ilh-explain-content.waiting {
        border-left-color: #2196f3;
        background: rgba(33,150,243,0.07);
        color: #90caf9;
        font-style: italic;
      }
      .ilh-explain-content.error {
        border-left-color: #ef4444;
        background: rgba(239,68,68,0.07);
        color: #fca5a5;
      }
      /* v0.12.5: 答案核对栏 */
      .ilh-verify-bar {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 0 4px;
        margin-top: 4px;
        font-size: 11px;
      }
      .ilh-verify-label { opacity: 0.7; color: #94a3b8; }
      .ilh-verify-btn {
        padding: 3px 9px;
        border-radius: 11px;
        font-size: 11px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.10);
        color: #cbd5e1;
        cursor: pointer;
        transition: all 0.15s;
      }
      .ilh-verify-btn:hover { background: rgba(255,255,255,0.10); }
      .ilh-verify-btn.active[data-state="correct"] {
        background: #22c55e; border-color: #22c55e; color: #fff;
      }
      .ilh-verify-btn.active[data-state="incorrect"] {
        background: #ef4444; border-color: #ef4444; color: #fff;
      }
      .ilh-verify-btn.active[data-state="unverified"] {
        background: rgba(148,163,184,0.3); border-color: #94a3b8; color: #fff;
      }

      /* v0.12.2: 选项重排警告 */
      .ilh-remap-warning {
        background: rgba(251,191,36,0.08);
        border-left: 2px solid #fbbf24;
        padding: 8px 11px;
        margin-bottom: 9px;
        border-radius: 4px;
        font-size: 11.5px;
      }
      .ilh-remap-title {
        color: #fde68a;
        font-weight: 600;
        margin-bottom: 4px;
      }
      .ilh-remap-details summary {
        cursor: pointer;
        color: #94a3b8;
        font-size: 10.5px;
        padding: 1px 0;
        opacity: 0.85;
      }
      .ilh-remap-details summary:hover { opacity: 1; }
      .ilh-remap-details[open] summary { margin-bottom: 4px; }
      .ilh-remap-row {
        font-size: 10.5px;
        padding: 1px 0 1px 12px;
        line-height: 1.6;
      }
      .ilh-remap-orig { color: #94a3b8; font-family: "SF Mono", monospace; }
      .ilh-remap-arrow { color: #fbbf24; margin-left: 6px; }
      .ilh-remap-arrow b { color: #fde68a; font-size: 12px; }
      .ilh-remap-same { color: #6b7280; font-size: 10px; margin-left: 6px; }

      .ilh-explain-content[contenteditable="true"] {
        outline: none;
        background: rgba(33,150,243,0.05);
        border-left-color: #2196f3;
        cursor: text;
      }
      .ilh-mini-btn.ilh-btn-primary {
        background: #2196f3;
        border-color: #2196f3;
        color: #fff;
      }
      .ilh-mini-btn.ilh-btn-primary:hover {
        background: #1e88e5;
      }
      .ilh-explain-actions {
        display: flex; gap: 6px; margin-top: 8px;
        align-items: center;
      }
      .ilh-mini-btn {
        padding: 4px 9px;
        font-size: 11px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
        color: #e8eaf6;
        border-radius: 4px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s;
      }
      .ilh-mini-btn:hover { background: rgba(255,255,255,0.13); }

      #ilh-log-section {
        /* v0.12.8: 占用剩余空间, 让浮窗高度稳定 */
        flex: 1;
        min-height: 80px;
        display: flex; flex-direction: column;
        border-top: 1px solid rgba(255,255,255,0.06);
        background: rgba(0,0,0,0.20);
      }
      #ilh-log-section > #ilh-log-header { flex-shrink: 0; }
      #ilh-log-section > #ilh-log {
        flex: 1;
        min-height: 0;
      }
      #ilh-log-header {
        padding: 7px 14px;
        font-size: 11px;
        opacity: 0.65;
        cursor: pointer;
        display: flex; justify-content: space-between;
        user-select: none;
      }
      #ilh-log-header:hover { opacity: 1; }
      #ilh-log {
        padding: 0 14px 10px;
        overflow-y: auto;
        font-family: "SF Mono", Monaco, Consolas, monospace;
        font-size: 10.5px;
        line-height: 1.55;
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
        margin-bottom: 4px;
      }
      .ilh-explain-content ul.ilh-md-list {
        list-style: disc;
        padding-left: 22px;
        margin: 4px 0;
      }
      .ilh-explain-content ul.ilh-md-list ul.ilh-md-list {
        padding-left: 18px;
      }
      .ilh-explain-content li {
        margin-bottom: 2px;
      }
      .ilh-explain-content.md-rendered {
        white-space: normal;
      }
      .ilh-explain-content strong {
        font-weight: 600;
        color: #fff;
      }
      .ilh-explain-content em { font-style: italic; }

      #ilh-empty {
        padding: 20px 14px;
        text-align: center;
        color: #90a4ae;
        font-size: 12px;
      }
      .ilh-hint {
        display: block;
        margin-top: 6px;
        font-size: 10.5px;
        opacity: 0.7;
      }

      .ilh-sidebar-dot {
        flex-shrink: 0;
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
        // v0.13.0: qId = hash(stem + sorted-options-content), 修复 Q19/Q21 撞 ID; 选项打乱顺序仍命中同一 qId
        const id = computeQId(stem, options);
        return {
          id, type: questionType,
          position: positionInfo.position,
          total: positionInfo.total,
          stem, options,
          // v0.13.1: 携带课程上下文, CSV 导出时能追溯到具体考试
          courseName: getCourseName(),
          examId: getExamId(),
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

    /** v0.13.3: 在两个 resp 里选"最好"的一份 (合并去重时用)
     *  规则: status=done 优先 > edited=true 优先 > verified=correct 优先 > timestamp 新优先
     */
    function selectBestResp(a, b) {
      if (!a) return b;
      if (!b) return a;
      const da = a.status === 'done', db = b.status === 'done';
      if (da && !db) return a;
      if (db && !da) return b;
      if (a.edited && !b.edited) return a;
      if (b.edited && !a.edited) return b;
      const va = a.verified === 'correct', vb = b.verified === 'correct';
      if (va && !vb) return a;
      if (vb && !va) return b;
      return (a.timestamp || 0) >= (b.timestamp || 0) ? a : b;
    }

    /**
     * v0.13.0: 统一的 qId 计算函数 (整个脚本唯一入口, 不要直接调 hashString)
     *
     * 公式: hash(stem_normalized + '||' + options_content_sorted_joined)
     *
     * 为什么按内容排序?
     *   - 同一题不同试卷, 选项 ABCD 顺序常被打乱 (防背答案)
     *   - 按内容排序后, "A.红 B.绿 C.蓝" 和 "A.绿 B.红 C.蓝" 算同一 qId
     *   - 与 detectOptionRemapping 配合: 缓存命中 + 字母自动重映射
     *
     * 为什么这能修 Q19/Q21 bug?
     *   - 题干相同但选项**内容不同** (Q19: 路标/设计/算法/专利 vs Q21: 客户/货源/产销/招标)
     *   - 内容集合不同 -> 排序后字符串不同 -> hash 不同 -> 不同 qId -> 不撞车
     */
    function computeQId(stem, options) {
      const stemNorm = (stem || '').replace(/\s+/g, '').trim();
      const optionsKey = (options || [])
        .map((o) => (o && o.content) ? o.content.replace(/\s+/g, '').trim() : '')
        .filter((c) => c.length > 0)
        .sort()
        .join('|');
      return `q_${hashString(stemNorm + '||' + optionsKey)}`;
    }

    /**
     * v0.13.1: 从页面 DOM 提取课程名称
     * - 优先用 .title 元素的 title 属性 (完整文本, 不被截断)
     * - 兜底用 textContent
     * - 去掉首尾空格, 保留括号和特殊字符 (CSV 会自动转义)
     */
    function getCourseName() {
      try {
        const el = document.querySelector('.title span[title], .title');
        if (!el) return '';
        const raw = (el.getAttribute('title') || el.textContent || '').trim();
        return raw;
      } catch (e) {
        return '';
      }
    }

    /**
     * v0.13.1: 从 URL 提取考试 ID
     * URL 形如: https://ilearning.huawei.com/iexam/100000/examContent?examId=1836939435779674113
     */
    function getExamId() {
      try {
        const params = new URLSearchParams(location.search);
        return params.get('examId') || '';
      } catch (e) {
        return '';
      }
    }

    /**
     * v0.13.3: 迁移 + 合并 旧 qId 到新公式
     * - 扫所有 ilh:request:<qId>
     * - 用 computeQId(stem, options) 重算
     * - 如果新旧不同:
     *   - 新 qId 未占用 → 简单改名 (req + resp 一起搬)
     *   - 新 qId 已占用 → 合并 (选最佳 resp + 合并 courseName/examId 字段), 然后删旧 entry
     * 返回 { scanned, renamed, mergedConflicts, skipped }
     */
    function migrateLegacyQIds() {
      const reqKeys = GM_listValues().filter((k) => k.startsWith('ilh:request:'));
      let renamed = 0, mergedConflicts = 0, skipped = 0;

      for (const k of reqKeys) {
        const oldQId = k.slice('ilh:request:'.length);
        const req = GM_getValue(k, null);
        if (!req || !req.stem || !req.options || req.options.length === 0) {
          skipped++;
          continue;
        }
        const newQId = computeQId(req.stem, req.options);
        if (newQId === oldQId) continue;

        const existingNewReq = GM_getValue(`ilh:request:${newQId}`, null);
        const oldResp = GM_getValue(`ilh:response:${oldQId}`, null);

        if (!existingNewReq) {
          // 无冲突: 简单改名
          try {
            GM_setValue(`ilh:request:${newQId}`, { ...req, id: newQId });
            GM_deleteValue(`ilh:request:${oldQId}`);
            if (oldResp) {
              GM_setValue(`ilh:response:${newQId}`, { ...oldResp, id: newQId });
              GM_deleteValue(`ilh:response:${oldQId}`);
            }
            renamed++;
          } catch (e) {
            console.warn('[ilh] migrate rename failed for', oldQId, e);
          }
        } else {
          // 冲突: 合并去重 (v0.13.3 关键修复)
          try {
            // req: 用 existingNew 为底, 补全 courseName/examId
            const mergedReq = { ...existingNewReq, id: newQId };
            if (!mergedReq.courseName && req.courseName) mergedReq.courseName = req.courseName;
            if (!mergedReq.examId && req.examId) mergedReq.examId = req.examId;
            GM_setValue(`ilh:request:${newQId}`, mergedReq);

            // resp: 选最佳
            const newResp = GM_getValue(`ilh:response:${newQId}`, null);
            const bestResp = selectBestResp(newResp, oldResp);
            if (bestResp) {
              GM_setValue(`ilh:response:${newQId}`, { ...bestResp, id: newQId });
            }

            // 删除旧 entry
            GM_deleteValue(`ilh:request:${oldQId}`);
            GM_deleteValue(`ilh:response:${oldQId}`);
            mergedConflicts++;
          } catch (e) {
            console.warn('[ilh] migrate merge failed for', oldQId, e);
          }
        }
      }
      return { scanned: reqKeys.length, renamed, mergedConflicts, skipped };
    }

    /**
     * v0.13.3: 一次性扫描 cache, 把所有 "应该是同一 qId 但实际是分开 entry" 的合并掉
     * (清理 v0.13.2 留下的孤儿)
     * 与 migrateLegacyQIds 的区别:
     *   migrateLegacyQIds: 处理 oldQId !== newQId 的迁移
     *   deduplicateNewQIds: 处理 oldQId === newQId 但有多个 entry 算出相同 newQId 的情况
     */
    function deduplicateNewQIds() {
      const reqKeys = GM_listValues().filter((k) => k.startsWith('ilh:request:'));
      const groups = new Map(); // newQId → [{qId, req}, ...]

      for (const k of reqKeys) {
        const qId = k.slice('ilh:request:'.length);
        const req = GM_getValue(k, null);
        if (!req || !req.stem || !req.options || req.options.length === 0) continue;
        const newQId = computeQId(req.stem, req.options);
        if (!groups.has(newQId)) groups.set(newQId, []);
        groups.get(newQId).push({ qId, req });
      }

      let merged = 0, totalGroups = 0;
      for (const [newQId, items] of groups) {
        if (items.length <= 1) continue;
        totalGroups++;

        // 选最完整的 req (含 courseName/examId 优先)
        let bestReq = items[0].req;
        for (const it of items) {
          // courseName 优先
          if (!bestReq.courseName && it.req.courseName) bestReq = it.req;
          // examId 同时优先
          else if (!bestReq.examId && it.req.examId) bestReq = it.req;
        }
        const finalReq = { ...bestReq, id: newQId };
        // 把所有 items 的 courseName/examId 合并到 finalReq
        for (const it of items) {
          if (!finalReq.courseName && it.req.courseName) finalReq.courseName = it.req.courseName;
          if (!finalReq.examId && it.req.examId) finalReq.examId = it.req.examId;
        }

        // 选最佳 resp
        let bestResp = null;
        for (const it of items) {
          const resp = GM_getValue(`ilh:response:${it.qId}`, null);
          bestResp = selectBestResp(bestResp, resp);
        }

        try {
          GM_setValue(`ilh:request:${newQId}`, finalReq);
          if (bestResp) GM_setValue(`ilh:response:${newQId}`, { ...bestResp, id: newQId });

          // 删除其他 items
          for (const it of items) {
            if (it.qId === newQId) continue;
            GM_deleteValue(`ilh:request:${it.qId}`);
            GM_deleteValue(`ilh:response:${it.qId}`);
            merged++;
          }
        } catch (e) {
          console.warn('[ilh] dedup failed for', newQId, e);
        }
      }
      return { dupGroups: totalGroups, merged };
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
        <div id="ilh-batch-panel">
          <label class="ilh-batch-toggle" title="批量预取: 启用后会自动把未抓取的题目分批发给 NotebookLM">
            <input type="checkbox" id="ilh-batch-enabled" checked>
            <span>批量预取</span>
          </label>
          <div class="ilh-batch-config">
            每批 <input type="number" id="ilh-batch-size" value="20" min="1" max="50"> 题
          </div>
          <button class="ilh-mini-btn" id="ilh-batch-start" disabled title="所有题识别完后启用">▷ 立即批处理</button>
        </div>
        <div id="ilh-overview-grid">
          <div class="ilh-overview-header">
            <span>
              🎯 题目状态总览
              <span id="ilh-traverse-indicator" style="display:none"></span>
              <button id="ilh-traverse-cancel" class="ilh-traverse-cancel-btn" style="display:none" title="取消自动遍历">⏹</button>
            </span>
            <span class="ilh-overview-legend">
              <span><i style="background:#4a5568"></i>未开始</span>
              <span><i style="background:#eab308"></i>获取中</span>
              <span><i style="background:#22c55e"></i>已就绪</span>
              <span><i style="background:#ef4444"></i>失败</span>
            </span>
          </div>
          <div id="ilh-overview-grid-content"></div>
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
          <div class="ilh-verify-bar" id="ilh-verify-bar" style="display:none">
            <span class="ilh-verify-label">答案核对:</span>
            <button class="ilh-verify-btn" data-state="correct">✓ 正确</button>
            <button class="ilh-verify-btn" data-state="incorrect">✗ 错误</button>
            <button class="ilh-verify-btn" data-state="unverified">? 未验证</button>
          </div>
          <div class="ilh-explain-actions" id="ilh-actions-view">
            <button class="ilh-mini-btn" id="ilh-btn-edit">✏️ 编辑</button>
            <button class="ilh-mini-btn" id="ilh-btn-redo">🔄 重新请求</button>
            <span style="flex:1"></span>
            <button class="ilh-mini-btn" id="ilh-btn-csv" title="导出全部题目和解析为 CSV (Excel 可打开)">📤 导出题库</button>
            <button class="ilh-mini-btn" id="ilh-btn-import" title="从 CSV 文件导入题库 (会完全清空当前缓存!)">📂 导入题库</button>

          </div>
          <div class="ilh-explain-actions" id="ilh-actions-edit" style="display:none">
            <button class="ilh-mini-btn ilh-btn-primary" id="ilh-btn-save">💾 保存</button>
            <button class="ilh-mini-btn" id="ilh-btn-cancel-edit">❌ 取消</button>
            <span style="flex:1"></span>
            <span style="font-size:10px;opacity:0.65;align-self:center">编辑后保存到本地缓存, 下次切回此题秒回</span>
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
      // v0.12.8: 移除"复制解析"按钮 (用户可双击解析框选中再复制, 或用浏览器自带功能)
      // v0.12.5: 答案核对按钮组事件 (点击切换状态, 立即保存到 KEY_RESP)
      document.querySelectorAll('#ilh-verify-bar .ilh-verify-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!state.currentQuestion) return;
          const qId = state.currentQuestion.id;
          const newState = btn.dataset.state;
          const cached = GM_getValue(`ilh:response:${qId}`, null);
          if (!cached) {
            log('⚠️ 当前题没有缓存解析, 无法标记答案核对状态', 'warn');
            return;
          }
          cached.verified = newState;
          GM_setValue(`ilh:response:${qId}`, cached);
          // 更新 UI
          document.querySelectorAll('#ilh-verify-bar .ilh-verify-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.state === newState);
          });
          const stateLabel = { correct: '✓ 正确', incorrect: '✗ 错误', unverified: '? 未验证' }[newState];
          log(`📝 第 ${state.currentQuestion.position} 题 答案核对: ${stateLabel}`, 'info');
        });
      });

      document.getElementById('ilh-btn-redo').addEventListener('click', () => {
        if (!state.currentQuestion) return;
        const qId = state.currentQuestion.id;
        // v0.12.3: 同时删 KEY_RESP 和 KEY_REQ, 否则下面 requestExplanation 看到 KEY_REQ 残留会判定 "已在处理中"
        GM_deleteValue(`ilh:response:${qId}`);
        GM_deleteValue(`ilh:request:${qId}`);
        log(`🔄 已清除 ${qId} 的缓存 (request + response), 重新请求`, 'info');
        requestExplanation(state.currentQuestion);
      });

      // v0.11.0: 编辑解析
      document.getElementById('ilh-btn-edit').addEventListener('click', () => {
        if (!state.currentQuestion) return log('⚠️ 当前没有题目可编辑', 'warn');
        const cached = GM_getValue(`ilh:response:${state.currentQuestion.id}`, null);
        if (!cached || !cached.text) return log('⚠️ 当前题暂无解析可编辑', 'warn');
        EditMode.enter(state.currentQuestion.id, cached.text);
      });
      document.getElementById('ilh-btn-save').addEventListener('click', () => EditMode.save());
      document.getElementById('ilh-btn-cancel-edit').addEventListener('click', () => EditMode.cancel());

      // v0.11.0: CSV 导出
      document.getElementById('ilh-btn-csv').addEventListener('click', () => exportCSV());
      document.getElementById('ilh-btn-import').addEventListener('click', () => importCsvAsBank());


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

      // v0.8.0: 初始化 overview grid (默认 40 题, 第一题识别后会按 q.total 重建)
      StatusDot.buildOverviewGrid(40);
      // 点击 grid 上的题号 → 模拟点击 sidebar 跳过去 (v0.10.1: 用 robustClick)
      document.getElementById('ilh-overview-grid-content').addEventListener('click', (e) => {
        const dot = e.target.closest('.ilh-grid-dot');
        if (!dot) return;
        const pos = parseInt(dot.dataset.pos, 10);
        const items = StatusDot.findSidebarItems();
        const sbEl = items.get(pos);
        if (sbEl) {
          AutoTraverse.robustClick(sbEl, pos);
          log(`🎯 跳到第 ${pos} 题`, 'info');
        } else {
          log(`⚠️ sidebar 找不到第 ${pos} 题, 无法跳转`, 'warn');
        }
      });

      // v0.9.0: 取消自动遍历按钮
      document.getElementById('ilh-traverse-cancel').addEventListener('click', () => {
        AutoTraverse.cancel();
      });
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
      // v0.8.1: ilh-status div 已删除, 只更新 header dot 的颜色 (题目识别状态信息会在 ilh-meta pill 里显示)
      const dot = document.querySelector('#ilh-header .ilh-dot');
      if (dot) dot.className = 'ilh-dot' + (level ? ' ' + level : '');
      // 同时把 text 设为 dot 的 title (hover 提示)
      if (dot && text) dot.title = text;
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
          <span class="ilh-pill cache-count" id="ilh-cache-count" title="GM 缓存中已有的题目数">📚 缓存 …</span>
        </div>
        <div class="ilh-stem">${escapeHtml(q.stem)}</div>
        ${optionsHtml}
      `);
      updateCacheCount();
    }

    // v0.12.0: 更新 iLearning 浮窗的缓存数显示 (与 NotebookLM 端 nlh-stat-cache 一致)
    function updateCacheCount() {
      const el = document.getElementById('ilh-cache-count');
      if (!el) return;
      try {
        const allKeys = Bridge.listAllKeys();
        const cacheCount = allKeys.filter((k) => k.startsWith('ilh:response:')).length;
        el.textContent = `📚 缓存 ${cacheCount}`;
        el.title = `GM 缓存中已有 ${cacheCount} 题解析 (跨试卷共享)\n点击: 检查并清理重复缓存`;
        el.style.cursor = 'pointer';
      } catch (e) {
        el.textContent = '📚 缓存 ?';
      }
    }

    // v0.12.1: 点击缓存 pill 触发去重
    function setupCacheDedupClick() {
      // 用事件委托 (因为 ilh-cache-count 是 renderQuestion 时动态生成的)
      const panel = document.getElementById('ilh-panel');
      if (!panel || panel.__dedupBound) return;
      panel.__dedupBound = true;
      panel.addEventListener('click', (e) => {
        const el = e.target.closest('#ilh-cache-count');
        if (!el) return;
        const allKeys = Bridge.listAllKeys();
        const before = allKeys.filter((k) => k.startsWith('ilh:response:')).length;
        if (!confirm(`扫描 GM 缓存中的重复题目并去重?\n\n当前缓存: ${before} 题\n规则: 题干相同视为同题, 优先保留 [已编辑 > 完成解析 > 新格式 > 最新时间] 的版本`)) return;
        const r = deduplicateCache(log);
        const after = Bridge.listAllKeys().filter((k) => k.startsWith('ilh:response:')).length;
        alert(`✅ 去重完成\n\n扫描: ${r.total} 条\n重复组: ${r.dupGroups}\n删除: ${r.removed} 条\n剩余缓存: ${after} 题`);
        updateCacheCount();
      });
    }

    /* ───── v0.11.0: 编辑模式 ───── */
    const EditMode = {
      active: false,
      qId: null,
      originalText: null,

      enter(qId, currentText) {
        this.active = true;
        this.qId = qId;
        this.originalText = currentText;
        const contentEl = document.getElementById('ilh-explain-content');
        const statusEl = document.getElementById('ilh-explain-status');
        const viewActions = document.getElementById('ilh-actions-view');
        const editActions = document.getElementById('ilh-actions-edit');
        if (!contentEl) return;
        // 切到纯文本可编辑模式 (markdown 源码)
        contentEl.classList.remove('md-rendered');
        contentEl.textContent = currentText;
        contentEl.setAttribute('contenteditable', 'true');
        contentEl.focus();
        statusEl.textContent = '✏️ 编辑模式';
        viewActions.style.display = 'none';
        editActions.style.display = 'flex';
        log(`✏️ 进入编辑模式: ${qId}`, 'info');
      },

      save() {
        if (!this.active) return;
        const contentEl = document.getElementById('ilh-explain-content');
        const newText = contentEl.textContent.trim();
        if (newText.length < 5) {
          log('⚠️ 解析内容过短, 拒绝保存', 'warn');
          return;
        }
        // 写入 GM 缓存, 标记 edited
        const oldVal = GM_getValue(`ilh:response:${this.qId}`, null);
        GM_setValue(`ilh:response:${this.qId}`, {
          ...(oldVal || {}),
          id: this.qId,
          text: newText,
          status: 'done',
          edited: true,
          editedAt: Date.now(),
          textOriginal: oldVal && !oldVal.edited ? oldVal.text : (oldVal && oldVal.textOriginal) || '',
          timestamp: Date.now(),
        });
        // 触发 notify (其他实例如果有也会同步)
        GM_setValue(Bridge.KEY_NOTIFY, { qId: this.qId, status: 'done', ts: Date.now() });
        log(`💾 已保存编辑后的解析: ${this.qId} (${newText.length} 字符)`, 'success');
        this.exit(newText, true);
      },

      cancel() {
        if (!this.active) return;
        log(`❌ 取消编辑: ${this.qId}`, 'info');
        this.exit(this.originalText, false);
      },

      exit(displayText, wasEdited) {
        const contentEl = document.getElementById('ilh-explain-content');
        const statusEl = document.getElementById('ilh-explain-status');
        const viewActions = document.getElementById('ilh-actions-view');
        const editActions = document.getElementById('ilh-actions-edit');
        if (contentEl) {
          contentEl.removeAttribute('contenteditable');
          contentEl.classList.add('md-rendered');
          setSafeHTML(contentEl, renderMarkdown(displayText));
        }
        if (statusEl) {
          // 如果保存后, 显示"已编辑"标记; 否则查 cached 看是否之前编辑过
          if (wasEdited) {
            statusEl.textContent = '✏️ 已编辑 · 已保存';
          } else {
            const cached = GM_getValue(`ilh:response:${this.qId}`, null);
            statusEl.textContent = cached && cached.edited ? '✏️ 已编辑' : '✅ 缓存命中 · 秒回';
          }
        }
        if (viewActions) viewActions.style.display = 'flex';
        if (editActions) editActions.style.display = 'none';
        this.active = false;
        this.qId = null;
        this.originalText = null;
      },
    };

    /* ───── v0.12.0: 从 batch prompt 反查 stem (兜底) ───── */
    function parseStemFromBatchPrompt(prompt, position) {
      if (!prompt) return null;
      const startMarker = `===Q${position}===`;
      const startIdx = prompt.indexOf(startMarker);
      if (startIdx < 0) return null;
      const afterStart = startIdx + startMarker.length;
      const restPrompt = prompt.slice(afterStart);
      const nextMatch = restPrompt.match(/===\s*Q\d+\s*===/);
      const segment = nextMatch ? restPrompt.slice(0, nextMatch.index) : restPrompt;
      const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);
      let type = '', stem = '';
      const options = [];
      for (const line of lines) {
        const tm = line.match(/^\[(.+?)\]\s*第\s*\d+/);
        if (tm) { type = tm[1]; continue; }
        const om = line.match(/^([A-Z])[\.、]\s*(.+)/);
        if (om) { options.push({ letter: om[1], content: om[2] }); continue; }
        if (!stem) stem = line;
      }
      return { type, stem, options };
    }

    /* ───── v0.12.2: 选项重排检测 + 答案字母自动重映射 ───── */
    function detectOptionRemapping(currentOptions, originalOptions) {
      if (!Array.isArray(currentOptions) || !Array.isArray(originalOptions)) return null;
      if (currentOptions.length === 0 || originalOptions.length === 0) return null;
      if (currentOptions.length !== originalOptions.length) return null;
      const norm = (s) => (s || '').replace(/\s+/g, '').trim();
      const fwd = new Map();  // 原 letter → 当前 letter
      let changed = false;
      for (const orig of originalOptions) {
        const found = currentOptions.find((c) => norm(c.content) === norm(orig.content));
        if (!found) return null;  // 内容对不上 (可能选项内容也变了, 不安全, 不重映射)
        fwd.set(orig.letter, found.letter);
        if (orig.letter !== found.letter) changed = true;
      }
      return changed ? { forward: fwd, originalOptions } : null;
    }

    // v0.12.6: 字母重映射 (3 步式, 括号内所有字母都映射)
    //   ① 预处理: 把括号内所有 [A-F] 单字母按 mapping 一次性替换为 PLACE+新字母+SAFE
    //      (这样后续主循环不会再处理这些字母, 也不会被列表模式 9 误伤)
    //   ② 主循环 8 个模式 (模式 8 不再需要, 已被预处理覆盖)
    //   ③ 清理占位符
    function applyAnswerRemapping(text, mapping) {
      if (!text || !mapping || !mapping.forward) return text;
      const fwd = mapping.forward;
      const PLACE = '\uE000';
      const SAFE = '\uE001';
      let result = text;

      // ===== ① 预处理: 括号内所有字母都按 mapping 替换 (一次性处理) =====
      // 例: "(A, B)" mapping {A→B, B→A} → "(\uE000B\uE001, \uE000A\uE001)" → 清理后 "(B, A)"
      // 即使 newL === trimmed (恒等映射), 也要包裹保护, 防止后续 for 循环误伤
      result = result.replace(/([\(（])([^\(（\)）]+?)([\)）])/g, (match, lp, inner, rp) => {
        const parts = inner.split(/([,，、,])/);
        let touched = false;
        for (let i = 0; i < parts.length; i += 2) {
          const trimmed = parts[i].trim();
          if (/^[A-F]$/.test(trimmed) && fwd.has(trimmed)) {
            const newL = fwd.get(trimmed);
            parts[i] = parts[i].replace(/[A-F]/, PLACE + newL + SAFE);
            touched = true;
          }
        }
        return touched ? lp + parts.join('') + rp : match;
      });

      // ===== ② 主循环: 8 个模式 (取消模式 8) =====
      for (const [origL, newL] of fwd) {
        if (origL === newL) continue;
        const o = origL;
        const W = PLACE + newL + SAFE;

        // 1. 行首/换行后 字母+点/顿号
        result = result.replace(new RegExp(`(^|[\\n\\r])${o}([\\.、])`, 'g'), `$1${W}$2`);
        // 2. 加粗 **字母. 或 **字母**
        result = result.replace(new RegExp(`\\*\\*${o}(\\.|\\*\\*)`, 'g'), `**${W}$1`);
        // 3. (正确)答案 + 字母
        result = result.replace(new RegExp(`(?<=(?:正确)?答案[:：\\s]?\\s*)${o}(?![a-zA-Z0-9_])`, 'g'), W);
        // 4. 选项/选 + 字母
        result = result.replace(new RegExp(`(?<=选(?:项)?\\s*[:：]?\\s*)${o}(?![a-zA-Z0-9_])`, 'g'), W);
        // 5. 字母 + "选项"
        result = result.replace(new RegExp(`(^|[^a-zA-Z0-9])${o}(\\s*选项)`, 'g'), `$1${W}$2`);
        // 6. 字母 + 顿号/逗号/分号
        result = result.replace(new RegExp(`(^|[^a-zA-Z0-9])${o}(\\s*[、，；])`, 'g'), `$1${W}$2`);
        // 7. 字母 + (可选空白) + 评价词
        result = result.replace(
          new RegExp(`(^|[^a-zA-Z0-9])${o}(\\s*(?:错误|正确|不正确|不准确|是错|是对|对|不对))`, 'g'),
          `$1${W}$2`
        );
        // (模式 8 已删除 — 括号已被预处理覆盖)
        // 9. 列表分隔符 + 字母 (e.g. "A、B、C" 末尾 C)
        result = result.replace(
          new RegExp(`([、，；,])(\\s*)${o}(?![a-zA-Z0-9_])`, 'g'),
          `$1$2${W}`
        );
      }

      // ===== ③ 清理占位符 =====
      return result.replace(new RegExp(`[${PLACE}${SAFE}]`, 'g'), '');
    }

    // 生成重映射对照表 HTML (用于警告区)
    function buildRemapWarningHTML(mapping) {
      if (!mapping || !mapping.forward) return '';
      const lines = [];
      for (const orig of mapping.originalOptions) {
        const newL = mapping.forward.get(orig.letter);
        const sameOrChanged = (newL === orig.letter)
          ? '<span class="ilh-remap-same">(位置不变)</span>'
          : `<span class="ilh-remap-arrow">→ <b>${newL}</b></span>`;
        const contentShort = (orig.content || '').slice(0, 40) + ((orig.content || '').length > 40 ? '…' : '');
        lines.push(`<div class="ilh-remap-row"><span class="ilh-remap-orig">原 ${orig.letter}</span> · ${contentShort} ${sameOrChanged}</div>`);
      }
      return `<div class="ilh-remap-warning">
        <div class="ilh-remap-title">⚠️ 选项顺序与缓存时不同 — 解析中字母已自动调整</div>
        <details class="ilh-remap-details"><summary>查看映射 (${mapping.originalOptions.length} 项)</summary>
          ${lines.join('')}
        </details>
      </div>`;
    }

    /* ───── v0.12.1: 缓存去重 ───── */
    function deduplicateCache(logFn) {
      const log_ = logFn || ((msg) => console.log(msg));
      const allKeys = (typeof Bridge !== 'undefined' && Bridge.listAllKeys)
        ? Bridge.listAllKeys()
        : GM_listValues().filter((k) => k.startsWith('ilh:'));
      // 收集所有 qId
      const qIds = new Set();
      const batchReqs = {};
      allKeys.forEach((k) => {
        if (k.startsWith('ilh:request:')) qIds.add(k.slice('ilh:request:'.length));
        else if (k.startsWith('ilh:response:')) qIds.add(k.slice('ilh:response:'.length));
        else if (k.startsWith('ilh:batch_request:')) batchReqs[k.slice('ilh:batch_request:'.length)] = GM_getValue(k, null);
      });

      // 按 normalized stem hash 分组
      const groups = new Map();
      let withoutStem = 0;
      for (const qId of qIds) {
        const req = GM_getValue(`ilh:request:${qId}`, null);
        const resp = GM_getValue(`ilh:response:${qId}`, null);
        let stem = (req && req.stem) || '';
        // 兜底: 从 batch prompt 反查
        if (!stem && req && req.batchId && batchReqs[req.batchId]) {
          const batchReq = batchReqs[req.batchId];
          if (batchReq.questions && Array.isArray(batchReq.questions)) {
            const q = batchReq.questions.find((qq) => qq.id === qId || qq.position === req.position);
            if (q && q.stem) stem = q.stem;
          }
          if (!stem && batchReq.prompt && req.position) {
            const startMarker = `===Q${req.position}===`;
            const startIdx = batchReq.prompt.indexOf(startMarker);
            if (startIdx >= 0) {
              const afterStart = startIdx + startMarker.length;
              const rest = batchReq.prompt.slice(afterStart);
              const nm = rest.match(/===\s*Q\d+\s*===/);
              const segment = nm ? rest.slice(0, nm.index) : rest;
              const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);
              for (const line of lines) {
                if (/^\[(.+?)\]\s*第\s*\d+/.test(line)) continue;
                if (/^[A-Z][\.、]/.test(line)) continue;
                if (line) { stem = line; break; }
              }
            }
          }
        }
        if (!stem) {
          withoutStem++;
          continue;
        }
        // v0.13.0: 按完整 qId 分组 (stem + sorted options), 不再单看 stem (避免错认 Q19/Q21 为重复)
        const opts = (req && req.options) || [];
        const groupKey = computeQId(stem, opts);
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push({
          qId,
          stem,
          hasResp: !!resp,
          status: resp ? resp.status : null,
          edited: !!(resp && resp.edited),
          timestamp: (resp && resp.timestamp) || (req && req.timestamp) || 0,
          isNewFormat: qId.startsWith('q_'),
        });
      }

      // 处理重复
      let dupGroups = 0;
      let removed = 0;
      let totalRedundant = 0;
      for (const [stemHash, items] of groups) {
        if (items.length <= 1) continue;
        dupGroups++;
        totalRedundant += items.length - 1;
        // 排序: 已编辑 > 有 done 解析 > 新格式 qId > 最新时间
        items.sort((a, b) => {
          if (a.edited !== b.edited) return a.edited ? -1 : 1;
          const aDone = a.status === 'done', bDone = b.status === 'done';
          if (aDone !== bDone) return aDone ? -1 : 1;
          if (a.isNewFormat !== b.isNewFormat) return a.isNewFormat ? -1 : 1;
          return b.timestamp - a.timestamp;
        });
        const keep = items[0];
        for (let i = 1; i < items.length; i++) {
          const dropQid = items[i].qId;
          GM_deleteValue(`ilh:request:${dropQid}`);
          GM_deleteValue(`ilh:response:${dropQid}`);
          removed++;
        }
      }
      log_(`🧹 缓存去重: 总计 ${qIds.size} 条, 发现 ${dupGroups} 组重复 (冗余 ${totalRedundant} 条), 删除 ${removed} 条, 无题干跳过 ${withoutStem} 条`, dupGroups > 0 ? 'success' : 'info');
      return { total: qIds.size, dupGroups, removed, withoutStem };
    }

    /* ───── v0.12.0: 统一的 CSV 导出 (iLearning + NotebookLM 共用) ───── */
    function exportAllCachedAsCSV(filename, logFn) {
      const log_ = logFn || ((msg) => console.log(msg));
      const allKeys = (typeof Bridge !== 'undefined' && Bridge.listAllKeys)
        ? Bridge.listAllKeys()
        : GM_listValues().filter((k) => k.startsWith('ilh:'));
      const requests = {}, responses = {}, batchReqs = {};
      allKeys.forEach((k) => {
        const v = GM_getValue(k, null);
        if (k.startsWith('ilh:request:')) requests[k.slice('ilh:request:'.length)] = v;
        else if (k.startsWith('ilh:response:')) responses[k.slice('ilh:response:'.length)] = v;
        else if (k.startsWith('ilh:batch_request:')) batchReqs[k.slice('ilh:batch_request:'.length)] = v;
      });

      // 收集所有题 (有 request 或 response 的都算)
      const allQIds = new Set([...Object.keys(requests), ...Object.keys(responses)]);
      const allQuestions = [];
      for (const qId of allQIds) {
        const req = requests[qId] || {};
        const resp = responses[qId] || null;
        let position = req.position || 0;
        let type = req.type || '';
        let stem = req.stem || '';
        let options = (req.options && req.options.length) ? req.options : [];

        // 兜底: stem 为空 + 有 batchId → 从 batch prompt 反查
        if (!stem && req.batchId && batchReqs[req.batchId]) {
          const batchReq = batchReqs[req.batchId];
          // 新格式: batchReq.questions
          if (batchReq.questions && Array.isArray(batchReq.questions)) {
            const q = batchReq.questions.find((qq) => qq.id === qId || qq.position === position);
            if (q) {
              type = type || q.type;
              stem = stem || q.stem;
              options = options.length ? options : (q.options || []);
            }
          }
          // 旧格式: 解析 prompt
          if (!stem && batchReq.prompt) {
            const parsed = parseStemFromBatchPrompt(batchReq.prompt, position);
            if (parsed) {
              type = type || parsed.type;
              stem = parsed.stem || stem;
              options = options.length ? options : (parsed.options || []);
            }
          }
        }

        allQuestions.push({
          qId, position, type, stem, options,
          status: resp ? resp.status : 'pending',
          text: resp ? (resp.text || '') : '',
          edited: !!(resp && resp.edited),
          verified: resp ? (resp.verified || 'unverified') : 'unverified',
          error: resp ? (resp.error || '') : '',
          timestamp: resp ? resp.timestamp : (req.timestamp || 0),
          // v0.13.1: 课程上下文 (从 KEY_REQ 读, 若没有则空)
          courseName: req.courseName || '',
          examId: req.examId || '',
        });
      }

      if (allQuestions.length === 0) {
        log_('⚠️ GM 缓存为空, 无可导出', 'warn');
        alert('缓存为空, 无可导出');
        return;
      }

      // 排序: 先按 position, 再按 timestamp
      allQuestions.sort((a, b) => (a.position - b.position) || (a.timestamp - b.timestamp));

      const rows = [];
      // v0.12.5: 新增 "答案核对" 列
      // v0.13.1: 新增 "课程名称" + "考试ID" 两列
      rows.push(['题号', '题型', '题干', '选项', '解析答案', '是否已编辑', '答案核对', '处理时间', '课程名称', '考试ID'].map(csvEscape).join(','));
      let stat = { total: allQuestions.length, withAnswer: 0, edited: 0, withStem: 0, verified: 0 };
      const verifyMap = { correct: '✓ 正确', incorrect: '✗ 错误', unverified: '未验证' };
      for (const q of allQuestions) {
        const optionsText = (q.options || []).map((o) => `${o.letter}. ${o.content}`).join('\n');
        const explanation = q.status === 'done' ? q.text : (q.status === 'error' ? `[错误] ${q.error || '解析失败'}` : '[未获取]');
        const isEdited = q.edited ? '是' : '否';
        const verifyText = verifyMap[q.verified] || '未验证';
        const ts = q.timestamp ? new Date(q.timestamp).toLocaleString('zh-CN') : '';
        if (q.status === 'done') stat.withAnswer++;
        if (q.edited) stat.edited++;
        if (q.stem) stat.withStem++;
        if (q.verified && q.verified !== 'unverified') stat.verified++;
        rows.push([
          q.position || '',
          normalizeTypeToChinese(q.type),
          q.stem || '',
          optionsText,
          explanation,
          isEdited,
          verifyText,
          ts,
          q.courseName || '',
          csvWrapBigNumber(q.examId || ''),
        ].map(csvEscape).join(','));
      }
      const csv = '\ufeff' + rows.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log_(`📥 已导出 CSV: ${stat.total} 题 (含题干 ${stat.withStem}, 含解析 ${stat.withAnswer}, 已编辑 ${stat.edited}, 已核对 ${stat.verified})`, 'success');
    }

    /* ───── v0.11.0: CSV 导出 ───── */
    function csvEscape(field) {
      if (field == null) return '';
      const s = String(field);
      // 含逗号 / 双引号 / 换行 → 用双引号包裹, 内部双引号变两个
      if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    function exportCSV() {
      const filename = (() => {
        let examName = '';
        const titleEl = document.querySelector('.title span[title], .title');
        if (titleEl) {
          examName = (titleEl.getAttribute('title') || titleEl.textContent || '').trim().replace(/[\\\/:*?"<>|]/g, '_').slice(0, 40);
        }
        const ts = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
        return `iLearning_答案_${examName || '全部题库'}_${ts}.csv`;
      })();
      exportAllCachedAsCSV(filename, log);
    }

    /* ───── v0.12.7: 题库导入 ─────
     * CSV 格式 (8 列, UTF-8 BOM):
     *   1. 题号        - 整数 (可重复, 因不同试卷同位置不同题)
     *   2. 题型        - "单选题" / "多选题"
     *   3. 题干        - 字符串
     *   4. 选项        - "A. xxx\nB. xxx\nC. xxx" (\n 分隔, CSV 标准引号包裹真换行)
     *   5. 解析答案    - markdown 格式, 含正确答案标记
     *   6. 是否已编辑  - "是" / "否"
     *   7. 答案核对    - "✓ 正确" / "✗ 错误" / "未验证"
     *   8. 处理时间    - 本地时间字符串
     *
     * 导入流程:
     *   1) 弹文件选择框
     *   2) 二次确认 (会清空 N 条旧缓存, 用 M 题替换)
     *   3) 清空所有 ilh:request:* / ilh:response:* / ilh:batch_* / ilh:queue
     *   4) 逐题用 stem hash 算 qId, 写 KEY_REQ + KEY_RESP
     *   5) 刷新当前页面 (用户感受到题库已切换)
     */
    function importCsvAsBank() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.style.display = 'none';
      input.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        log(`📂 选择文件: ${file.name} (${(file.size/1024).toFixed(1)} KB)`, 'info');
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            doImportFromCsvText(ev.target.result, file.name);
          } catch (err) {
            log(`❌ 导入失败: ${err.message}`, 'error');
            alert(`❌ 导入失败:\n${err.message}`);
          } finally {
            input.remove();
          }
        };
        reader.onerror = () => {
          log(`❌ 文件读取失败`, 'error');
          alert('❌ 文件读取失败, 请重试');
          input.remove();
        };
        reader.readAsText(file, 'utf-8');
      });
      document.body.appendChild(input);
      input.click();
    }

    function doImportFromCsvText(text, filename) {
      // 去 BOM
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('CSV 行数太少 (至少需要表头 + 1 行数据)');

      const header = rows[0];
      const expectedHeader = ['题号', '题型', '题干', '选项', '解析答案', '是否已编辑', '答案核对', '处理时间', '课程名称', '考试ID'];
      // 至少前 5 列要对得上 (后 5 列向下兼容: 8 列旧版 / 10 列新版都接受)
      const headerOK = expectedHeader.slice(0, 5).every((h, i) => (header[i] || '').trim() === h);
      if (!headerOK) {
        throw new Error(`CSV 表头不匹配, 期望前 5 列为:\n  ${expectedHeader.slice(0,5).join(' | ')}\n实际:\n  ${header.slice(0,5).join(' | ')}`);
      }
      const hasNewCols = header.length >= 10 && (header[8] || '').trim() === '课程名称' && (header[9] || '').trim() === '考试ID';

      const dataRows = rows.slice(1).filter((r) => r.some((c) => c && c.trim()));
      if (dataRows.length === 0) throw new Error('CSV 没有数据行');

      // 先统计现有缓存
      const allKeys = (typeof Bridge !== 'undefined' && Bridge.listAllKeys)
        ? Bridge.listAllKeys()
        : GM_listValues().filter((k) => k.startsWith('ilh:'));
      const oldReqCount = allKeys.filter((k) => k.startsWith('ilh:request:')).length;
      const oldRespCount = allKeys.filter((k) => k.startsWith('ilh:response:')).length;

      const ok = confirm(
        `⚠️ 即将导入题库\n\n` +
        `文件: ${filename}\n` +
        `导入: ${dataRows.length} 题\n\n` +
        `这将完全清空当前缓存:\n` +
        `  • request 缓存: ${oldReqCount} 条\n` +
        `  • response 缓存: ${oldRespCount} 条\n` +
        `  • batch 任务、队列等\n\n` +
        `用 CSV 数据替换。是否继续?`
      );
      if (!ok) {
        log(`📂 用户取消导入`, 'info');
        return;
      }

      // === 1. 清空所有 ilh:* (除 ilh:nlm_status 心跳, 不破坏 NotebookLM 端状态) ===
      let cleared = 0;
      for (const k of allKeys) {
        if (k === 'ilh:nlm_status') continue; // 保留心跳
        try {
          GM_deleteValue(k);
          cleared++;
        } catch (e) {
          console.warn(`[ilh] delete ${k} failed:`, e);
        }
      }
      log(`🗑 已清空 ${cleared} 条旧缓存`, 'info');

      // === 2. 逐题写 KEY_REQ + KEY_RESP ===
      let imported = 0, skipped = 0;
      const total = dataRows.length;
      const importTs = Date.now();

      for (const row of dataRows) {
        try {
          const [posStr, typeStr, stem, optionsStr, explainText, editedStr, verifyStr, timeStr, courseNameStr, examIdStr] = row;
          if (!stem || stem.trim().length < 2) {
            skipped++;
            continue;
          }
          const position = parseInt((posStr || '0').trim(), 10) || 0;
          // v0.13.3: 保留中文题型, 不再 multi/single
          const typeText = (typeStr || '').trim();
          const type = ['单选题', '多选题', '判断题'].includes(typeText) ? typeText : '单选题';

          // 解析选项 "A. xxx\nB. xxx\nC. xxx" → [{letter, content}]
          // v0.13.4: 必须先解析 options 才能算 qId (之前顺序写反了, 触发 temporal dead zone)
          const options = [];
          if (optionsStr) {
            const lines = optionsStr.split(/\r?\n/);
            for (const ln of lines) {
              const m = ln.match(/^\s*([A-F])[\.、]\s*(.+)$/);
              if (m) options.push({ letter: m[1], content: m[2].trim() });
            }
          }

          // v0.13.0: 用统一 computeQId, 包含选项内容; "题干同选项异" 的题会被算成不同 qId
          const qId = computeQId(stem, options);

          // 解析时间戳
          let ts = importTs;
          if (timeStr && timeStr.trim()) {
            const parsed = Date.parse(timeStr.trim().replace(/\//g, '-'));
            if (!isNaN(parsed)) ts = parsed;
          }

          // KEY_REQ (v0.13.1: 含课程上下文)
          GM_setValue(`ilh:request:${qId}`, {
            id: qId,
            position,
            type,
            stem,
            options,
            courseName: hasNewCols ? (courseNameStr || '').trim() : '',
            examId: hasNewCols ? csvUnwrapBigNumber(examIdStr || '') : '',
            timestamp: ts,
            status: 'imported',
          });

          // KEY_RESP (有解析就 done)
          if (explainText && explainText.trim()) {
            const verified = (verifyStr || '').trim();
            const verifyMap = {
              '✓ 正确': 'correct',
              '✗ 错误': 'incorrect',
              '未验证': 'unverified',
            };
            GM_setValue(`ilh:response:${qId}`, {
              id: qId,
              text: explainText,
              status: 'done',
              error: null,
              timestamp: ts,
              edited: (editedStr || '').trim() === '是',
              verified: verifyMap[verified] || 'unverified',
              originalOptions: options.slice(),
              importedFrom: filename,
            });
          }

          imported++;
        } catch (e) {
          console.warn(`[ilh] import row failed:`, row, e);
          skipped++;
        }
      }

      log(`✅ 导入完成: ${imported}/${total} 题 (跳过 ${skipped})`, 'success');
      alert(
        `✅ 题库导入完成!\n\n` +
        `成功: ${imported} 题\n` +
        `跳过: ${skipped} 题\n` +
        `已清空: ${cleared} 条旧缓存\n\n` +
        `页面将刷新, 请稍候...`
      );

      // === 3. 刷新页面 ===
      setTimeout(() => location.reload(), 600);
    }

    /** 简单 CSV 解析: 支持引号包裹、多行字段、""转义 */
    function parseCsv(text) {
      const rows = [];
      let row = [];
      let cell = '';
      let inQuote = false;
      let i = 0;
      const n = text.length;
      while (i < n) {
        const c = text[i];
        if (inQuote) {
          if (c === '"') {
            if (text[i+1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            inQuote = false;
            i++;
            continue;
          }
          cell += c;
          i++;
          continue;
        }
        // 非引号内
        if (c === '"') {
          inQuote = true;
          i++;
          continue;
        }
        if (c === ',') {
          row.push(cell);
          cell = '';
          i++;
          continue;
        }
        if (c === '\r') {
          // 跳过 \r, 等待 \n
          i++;
          continue;
        }
        if (c === '\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
          i++;
          continue;
        }
        cell += c;
        i++;
      }
      // 最后一个 cell
      if (cell || row.length) {
        row.push(cell);
        rows.push(row);
      }
      return rows;
    }


    function showExplain(kind, content = '', statusText = '') {
      const wrap = document.getElementById('ilh-explain');
      const contentEl = document.getElementById('ilh-explain-content');
      const statusEl = document.getElementById('ilh-explain-status');
      if (!wrap) return;
      wrap.style.display = 'block';
      contentEl.className = 'ilh-explain-content ' + (kind || '');

      // v0.12.2: 选项重排检测 + 字母自动重映射 (仅成功状态 + 有当前题)
      // v0.12.3: 兼容旧缓存 — originalOptions 缺失时回退到 KEY_REQ.options
      let remapWarningHTML = '';
      let finalStatus = statusText;
      if ((!kind || kind === '') && content && state.currentQuestion) {
        const qId = state.currentQuestion.id;
        const cached = GM_getValue(`ilh:response:${qId}`, null);
        if (cached) {
          // 优先用 originalOptions, 没有就 fallback 到 KEY_REQ.options (v0.12.2 之前的缓存)
          let originalOptions = (cached.originalOptions && cached.originalOptions.length > 0)
            ? cached.originalOptions
            : null;
          if (!originalOptions) {
            const req = GM_getValue(`ilh:request:${qId}`, null);
            if (req && req.options && req.options.length > 0) {
              originalOptions = req.options;
            }
          }
          if (originalOptions) {
            const remap = detectOptionRemapping(state.currentQuestion.options, originalOptions);
            if (remap) {
              content = applyAnswerRemapping(content, remap);
              remapWarningHTML = buildRemapWarningHTML(remap);
              finalStatus = '⚠️ 选项已重排 · 字母已调整';
            }
          }
          if (cached.edited && !remapWarningHTML) {
            finalStatus = '✏️ 已编辑 · 秒回';
          }
        }
      }

      // v0.5.6: 成功状态用 markdown 渲染, 等待/错误状态保持纯文本
      if ((kind === '' || !kind) && content) {
        contentEl.classList.add('md-rendered');
        // 警告 HTML 放在 markdown 渲染结果之前
        const html = remapWarningHTML + renderMarkdown(content);
        setSafeHTML(contentEl, html);
      } else {
        contentEl.classList.remove('md-rendered');
        contentEl.textContent = content;
      }
      statusEl.textContent = finalStatus;

      // v0.12.5: 渲染答案核对栏 (仅成功状态显示)
      const verifyBar = document.getElementById('ilh-verify-bar');
      if (verifyBar) {
        if ((!kind || kind === '') && content && state.currentQuestion) {
          verifyBar.style.display = 'flex';
          const cached = GM_getValue(`ilh:response:${state.currentQuestion.id}`, null);
          const verifyState = (cached && cached.verified) || 'unverified';
          verifyBar.querySelectorAll('.ilh-verify-btn').forEach((b) => {
            b.classList.toggle('active', b.dataset.state === verifyState);
          });
        } else {
          verifyBar.style.display = 'none';
        }
      }
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
      // v0.8.0: 记录 qId → position 映射 (供全局 notify listener 反查)
      state.qIdToPosition.set(q.id, q.position);

      // 缓存优先(命中就秒回, 不依赖 NotebookLM 活跃状态)
      const cached = GM_getValue(`ilh:response:${q.id}`, null);
      if (cached && cached.status === 'done') {
        showExplain('', cached.text, '✅ 缓存命中 · 秒回');
        log(`💾 缓存命中: ${q.id}`, 'success');
        StatusDot.updateOne(q.position, q.id);
        return;
      }
      if (cached && cached.status === 'error') {
        showExplain('error', cached.error || '上次请求失败 · 点"重新请求"重试', '上次失败');
        log(`⚠️ 缓存的错误响应, 不重试 (用户可手动重试)`, 'warn');
        StatusDot.updateOne(q.position, q.id);
        return;
      }

      // v0.8.0: 检查是否已经在 pending (request 已发, response 还没回) - 不再重复发
      const existingReq = GM_getValue(`ilh:request:${q.id}`, null);
      if (existingReq) {
        const elapsed = Math.round((Date.now() - (existingReq.timestamp || Date.now())) / 1000);
        showExplain('waiting', `⏳ 上次请求还在处理 (已等 ${elapsed} 秒)\n\nNotebookLM 通常需要 10-30 秒, 请耐心等待。\n完成后会自动显示, 不用反复点击。`, '处理中');
        log(`⏳ ${q.id} 已在处理中, 不重复发送 (已 ${elapsed}s)`, 'info');
        StatusDot.updateOne(q.position, q.id);
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
      StatusDot.updateOne(q.position, q.id);
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

    // v0.13.3: 启动时静默执行 qId 迁移 + 去重 (修复 v0.13.2 留下的孤儿)
    try {
      const mig = migrateLegacyQIds();
      const parts = [];
      if (mig.renamed > 0) parts.push(`改名 ${mig.renamed}`);
      if (mig.mergedConflicts > 0) parts.push(`合并冲突 ${mig.mergedConflicts}`);
      if (parts.length > 0) {
        log(`🔄 qId 迁移: ${parts.join(', ')} (扫描 ${mig.scanned})`, 'success');
      }

      const dedup = deduplicateNewQIds();
      if (dedup.merged > 0) {
        log(`♻️ qId 去重: 合并 ${dedup.merged} 条孤儿 (${dedup.dupGroups} 组)`, 'success');
      }
    } catch (e) {
      log(`⚠️ qId 自动迁移失败: ${e.message}`, 'warn');
    }
    log(`🎯 当前阶段: ${STAGE} (开题自动出解析)`, 'info');

    setTimeout(() => handleQuestionChange(true), 800);
    setupObserver();
    updateBatchPanel(); // v0.6.0: 初始化批量面板

    // v0.8.0: 启动状态灯系统 (sidebar 自动注入 + 全量更新)
    StatusDot.setupAutoInject();

    // v0.12.2: 删除启动自动去重 (v0.12.0 之后新数据不会重复, 仅保留手动按钮)
    // 绑定缓存 pill 点击 → 手动触发去重
    setTimeout(setupCacheDedupClick, 1500);

    // v0.12.1: 方向键拦截 - 浮窗内按 ↑↓←→ 不再误切 iLearning 题目
    // 在 capture 阶段于 window 上监听, 比 iLearning 更早抓到, 用 stopImmediatePropagation 阻止后续 listener
    const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'];
    const blockArrows = (e) => {
      if (!ARROW_KEYS.includes(e.key)) return;
      const tgt = e.target;
      if (tgt && tgt.closest && tgt.closest('#ilh-panel')) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        // 注: 不调 preventDefault, 让浮窗内 input/textarea 的方向键光标移动正常工作
      }
    };
    window.addEventListener('keydown', blockArrows, true);
    window.addEventListener('keyup', blockArrows, true);
    document.addEventListener('keydown', blockArrows, true);
    document.addEventListener('keyup', blockArrows, true);
    log('⌨️  已启用浮窗方向键拦截 (浮窗内按 ↑↓←→ 不会切 iLearning 题)', 'debug');

    // v0.9.0: 自动遍历 - 延迟 3 秒后启动 (留时间给 iLearning 渲染 sidebar 和首题)
    setTimeout(() => {
      AutoTraverse.start().catch((e) => {
        log(`❌ 自动遍历异常: ${e.message}`, 'error');
        AutoTraverse.active = false;
        AutoTraverse.updateUI();
      });
    }, 3000);

    // v0.10.0: 监听批次结果通知
    GM_addValueChangeListener(Bridge.KEY_BATCH_NOTIFY, (key, oldVal, newVal) => {
      if (!newVal || !newVal.batchId) return;
      if (newVal.status === 'partial' || newVal.status === 'failed') {
        BatchManager.onBatchPartial(newVal.batchId, newVal.splitResults || {}, newVal.failedPositions || []);
      } else if (newVal.status === 'success') {
        BatchManager.onBatchPartial(newVal.batchId, newVal.splitResults || {}, []);
      }
    });

    // v0.8.0: 全局 notify listener - 监听任何题状态变化, 更新 dot + 自动刷新当前题显示
    GM_addValueChangeListener(Bridge.KEY_NOTIFY, (key, oldVal, newVal) => {
      if (!newVal || !newVal.qId) return;
      // 更新对应 dot
      StatusDot.updateByQId(newVal.qId);
      // v0.12.0: 任何题状态变化都刷新缓存数 UI (NotebookLM 写 done 后 iLearning 端能立刻看到 +1)
      if (typeof updateCacheCount === 'function') updateCacheCount();
      // 如果是当前显示的题且状态变 done/error, 自动刷新解析显示
      if (state.currentQuestion && state.currentQuestion.id === newVal.qId) {
        const cached = GM_getValue(`ilh:response:${newVal.qId}`, null);
        if (cached && cached.status === 'done') {
          showExplain('', cached.text, '✅ 已完成');
          log(`✅ 收到解析: ${newVal.qId}, ${cached.text.length} 字符 (后台到达)`, 'success');
        } else if (cached && cached.status === 'error') {
          showExplain('error', cached.error || '处理失败', '失败');
          log(`❌ 解析失败: ${cached.error}`, 'error');
        }
      } else if (newVal.status === 'done') {
        // 不是当前题但完成了 - 仅在 dot 上提示, 不打扰用户
        const pos = state.qIdToPosition.get(newVal.qId);
        if (pos) log(`🟢 第 ${pos} 题 后台已就绪`, 'info');
      }
    });

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

    /* v0.12.0: 复用 iLearning 端的统一 exportAllCachedAsCSV 函数 (格式与 iLearning CSV 完全一致) */
    function exportCacheCSV() {
      const filename = `iLearning_全部题库_${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}.csv`;
      // 同 iLearning 端共享的函数 (定义在 iLearning 分支, 但 NotebookLM 分支也能调到 — 通过 helper 直接 inline 一份)
      __exportAllCachedAsCSV_shared(filename, log);
    }

    /* v0.12.1: NotebookLM 端 inline 缓存去重逻辑 */
    function __deduplicateCache_shared(logFn) {
      const log_ = logFn || ((msg) => console.log(msg));
      const hashStr = (s) => {
        let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
        return Math.abs(h).toString(36);
      };
      const allKeys = Bridge.listAllKeys();
      const qIds = new Set();
      const batchReqs = {};
      allKeys.forEach((k) => {
        if (k.startsWith('ilh:request:')) qIds.add(k.slice('ilh:request:'.length));
        else if (k.startsWith('ilh:response:')) qIds.add(k.slice('ilh:response:'.length));
        else if (k.startsWith('ilh:batch_request:')) batchReqs[k.slice('ilh:batch_request:'.length)] = GM_getValue(k, null);
      });
      const groups = new Map();
      let withoutStem = 0;
      for (const qId of qIds) {
        const req = GM_getValue(`ilh:request:${qId}`, null);
        const resp = GM_getValue(`ilh:response:${qId}`, null);
        let stem = (req && req.stem) || '';
        if (!stem && req && req.batchId && batchReqs[req.batchId]) {
          const batchReq = batchReqs[req.batchId];
          if (batchReq.questions && Array.isArray(batchReq.questions)) {
            const q = batchReq.questions.find((qq) => qq.id === qId || qq.position === req.position);
            if (q && q.stem) stem = q.stem;
          }
          if (!stem && batchReq.prompt && req.position) {
            const startMarker = `===Q${req.position}===`;
            const startIdx = batchReq.prompt.indexOf(startMarker);
            if (startIdx >= 0) {
              const rest = batchReq.prompt.slice(startIdx + startMarker.length);
              const nm = rest.match(/===\s*Q\d+\s*===/);
              const segment = nm ? rest.slice(0, nm.index) : rest;
              const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);
              for (const line of lines) {
                if (/^\[(.+?)\]\s*第\s*\d+/.test(line)) continue;
                if (/^[A-Z][\.、]/.test(line)) continue;
                if (line) { stem = line; break; }
              }
            }
          }
        }
        if (!stem) { withoutStem++; continue; }
        const stemHash = hashStr(stem.replace(/\s+/g, '').trim());
        if (!groups.has(stemHash)) groups.set(stemHash, []);
        groups.get(stemHash).push({
          qId,
          edited: !!(resp && resp.edited),
          status: resp ? resp.status : null,
          timestamp: (resp && resp.timestamp) || (req && req.timestamp) || 0,
          isNewFormat: qId.startsWith('q_'),
        });
      }
      let dupGroups = 0, removed = 0;
      for (const [_, items] of groups) {
        if (items.length <= 1) continue;
        dupGroups++;
        items.sort((a, b) => {
          if (a.edited !== b.edited) return a.edited ? -1 : 1;
          const aDone = a.status === 'done', bDone = b.status === 'done';
          if (aDone !== bDone) return aDone ? -1 : 1;
          if (a.isNewFormat !== b.isNewFormat) return a.isNewFormat ? -1 : 1;
          return b.timestamp - a.timestamp;
        });
        for (let i = 1; i < items.length; i++) {
          GM_deleteValue(`ilh:request:${items[i].qId}`);
          GM_deleteValue(`ilh:response:${items[i].qId}`);
          removed++;
        }
      }
      return { total: qIds.size, dupGroups, removed, withoutStem };
    }

    /* v0.12.0: NotebookLM 端 inline 一份共享 CSV 导出逻辑 (因为函数定义在 iLearning 分支) */
    function __exportAllCachedAsCSV_shared(filename, logFn) {
      const log_ = logFn || ((msg) => console.log(msg));
      const allKeys = Bridge.listAllKeys();
      const requests = {}, responses = {}, batchReqs = {};
      allKeys.forEach((k) => {
        const v = GM_getValue(k, null);
        if (k.startsWith('ilh:request:')) requests[k.slice('ilh:request:'.length)] = v;
        else if (k.startsWith('ilh:response:')) responses[k.slice('ilh:response:'.length)] = v;
        else if (k.startsWith('ilh:batch_request:')) batchReqs[k.slice('ilh:batch_request:'.length)] = v;
      });
      const allQIds = new Set([...Object.keys(requests), ...Object.keys(responses)]);
      const allQuestions = [];
      for (const qId of allQIds) {
        const req = requests[qId] || {};
        const resp = responses[qId] || null;
        let position = req.position || 0;
        let type = req.type || '';
        let stem = req.stem || '';
        let options = (req.options && req.options.length) ? req.options : [];
        // 兜底: 从 batch_request 反查
        if (!stem && req.batchId && batchReqs[req.batchId]) {
          const batchReq = batchReqs[req.batchId];
          if (batchReq.questions && Array.isArray(batchReq.questions)) {
            const q = batchReq.questions.find((qq) => qq.id === qId || qq.position === position);
            if (q) {
              type = type || q.type;
              stem = stem || q.stem;
              options = options.length ? options : (q.options || []);
            }
          }
          if (!stem && batchReq.prompt) {
            const startMarker = `===Q${position}===`;
            const startIdx = batchReq.prompt.indexOf(startMarker);
            if (startIdx >= 0) {
              const afterStart = startIdx + startMarker.length;
              const rest = batchReq.prompt.slice(afterStart);
              const nm = rest.match(/===\s*Q\d+\s*===/);
              const segment = nm ? rest.slice(0, nm.index) : rest;
              const lines = segment.split('\n').map((l) => l.trim()).filter(Boolean);
              let parsedType = '', parsedStem = '';
              const parsedOpts = [];
              for (const line of lines) {
                const tm = line.match(/^\[(.+?)\]\s*第\s*\d+/);
                if (tm) { parsedType = tm[1]; continue; }
                const om = line.match(/^([A-Z])[\.、]\s*(.+)/);
                if (om) { parsedOpts.push({ letter: om[1], content: om[2] }); continue; }
                if (!parsedStem) parsedStem = line;
              }
              type = type || parsedType;
              stem = stem || parsedStem;
              options = options.length ? options : parsedOpts;
            }
          }
        }
        allQuestions.push({
          qId, position, type, stem, options,
          status: resp ? resp.status : 'pending',
          text: resp ? (resp.text || '') : '',
          edited: !!(resp && resp.edited),
          verified: resp ? (resp.verified || 'unverified') : 'unverified',
          error: resp ? (resp.error || '') : '',
          timestamp: resp ? resp.timestamp : (req.timestamp || 0),
          courseName: req.courseName || '',
          examId: req.examId || '',
        });
      }
      if (allQuestions.length === 0) {
        log_('⚠️ GM 缓存为空, 无可导出', 'warn');
        return;
      }
      allQuestions.sort((a, b) => (a.position - b.position) || (a.timestamp - b.timestamp));
      const csvEsc = (field) => {
        const s = String(field == null ? '' : field);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = [['题号', '题型', '题干', '选项', '解析答案', '是否已编辑', '答案核对', '处理时间', '课程名称', '考试ID'].map(csvEsc).join(',')];
      let stat = { total: allQuestions.length, withAnswer: 0, edited: 0, withStem: 0, verified: 0 };
      const verifyMap = { correct: '✓ 正确', incorrect: '✗ 错误', unverified: '未验证' };
      for (const q of allQuestions) {
        const optionsText = (q.options || []).map((o) => `${o.letter}. ${o.content}`).join('\n');
        const explanation = q.status === 'done' ? q.text : (q.status === 'error' ? `[错误] ${q.error || '解析失败'}` : '[未获取]');
        const isEdited = q.edited ? '是' : '否';
        const verifyText = verifyMap[q.verified] || '未验证';
        const ts = q.timestamp ? new Date(q.timestamp).toLocaleString('zh-CN') : '';
        if (q.status === 'done') stat.withAnswer++;
        if (q.edited) stat.edited++;
        if (q.stem) stat.withStem++;
        if (q.verified && q.verified !== 'unverified') stat.verified++;
        rows.push([q.position || '', normalizeTypeToChinese(q.type), q.stem || '', optionsText, explanation, isEdited, verifyText, ts, q.courseName || '', csvWrapBigNumber(q.examId || '')].map(csvEsc).join(','));
      }
      const csv = '\ufeff' + rows.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log_(`📥 已导出 CSV: ${stat.total} 题 (含题干 ${stat.withStem}, 含解析 ${stat.withAnswer}, 已编辑 ${stat.edited}, 已核对 ${stat.verified})`, 'success');
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

    // v0.10.0: 拆批量响应 — 用 ===Q\d+=== 切片
    function splitBatchResponse(responseText, expectedPositions) {
      const results = {};
      const pattern = /===\s*Q(\d+)\s*===/g;
      const matches = [];
      let m;
      while ((m = pattern.exec(responseText)) !== null) {
        matches.push({ pos: parseInt(m[1], 10), index: m.index, length: m[0].length });
      }
      log(`  🔍 在响应中找到 ${matches.length} 个 ===Q数字=== 标记`, 'debug');
      for (let i = 0; i < matches.length; i++) {
        const pos = matches[i].pos;
        const start = matches[i].index + matches[i].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : responseText.length;
        const content = responseText.slice(start, end).trim();
        if (content.length >= 30) {
          results[pos] = content;
        }
      }
      return results;
    }

    // v0.10.0: 处理一个批次 — 输入打包 prompt, 等响应, 拆解, 写入每题
    async function processOneBatch(batchReq) {
      state.busy = true;
      state.currentRequest = batchReq;
      const N = batchReq.batchSize;
      setStatus('busy', `⏳ 处理批次 ${batchReq.id.slice(-8)} (${N} 题)...`);
      log(`📦 接到批次 ${batchReq.id.slice(-8)}: ${N} 题 [${batchReq.positions.slice(0, 5).join(',')}${batchReq.positions.length > 5 ? '...' : ''}] (尝试 ${batchReq.attempt})`, 'info');

      try {
        // 1. 找输入框
        const inputEl = findInputElement();
        if (!inputEl) {
          log('❌ 未找到 NotebookLM 输入框', 'error');
          batchReq.positions.forEach((p) => {
            const qId = batchReq.positionMap[p];
            Bridge.writeResponse(qId, '', 'error', '找不到 NotebookLM 输入框');
          });
          Bridge.completeBatch(batchReq.id);
          Bridge.notifyBatchResult(batchReq.id, 'failed', { failedPositions: batchReq.positions });
          return;
        }

        // 2. 输入 prompt
        await setInputValue(inputEl, batchReq.prompt);
        await sleep(CONFIG.submitWaitMs);

        // 3. 提交
        const method = await submitMessage(inputEl);
        if (!method) {
          log('❌ 批次提交失败', 'error');
          Bridge.completeBatch(batchReq.id);
          Bridge.notifyBatchResult(batchReq.id, 'failed', { failedPositions: batchReq.positions });
          return;
        }
        await sleep(CONFIG.responseInitialDelayMs);

        // 4. 等响应 (用 prompt 头部固定字符串作 user msg 指纹)
        const fakeReq = {
          stem: '请基于知识库, 严格按以下格式',  // prompt 头 18 字, 稳定指纹
          type: 'batch',
          position: '0',
          total: '0',
          isBatch: true,
        };
        const responseText = await waitForResponse(fakeReq);
        if (!responseText || responseText.length < 100) {
          log(`❌ 批次响应过短 (${responseText?.length || 0} 字符)`, 'error');
          batchReq.positions.forEach((p) => {
            const qId = batchReq.positionMap[p];
            Bridge.writeResponse(qId, '', 'error', '批次响应过短或未抓到');
          });
          Bridge.completeBatch(batchReq.id);
          Bridge.notifyBatchResult(batchReq.id, 'failed', { failedPositions: batchReq.positions });
          return;
        }

        // 5. 拆响应
        const splitResults = splitBatchResponse(responseText, batchReq.positions);
        const successPositions = [];
        const failedPositions = [];

        for (const pos of batchReq.positions) {
          const qId = batchReq.positionMap[pos];
          if (splitResults[pos]) {
            Bridge.writeResponse(qId, splitResults[pos], 'done');
            successPositions.push(pos);
          } else {
            failedPositions.push(pos);
            // 不写 error, 留给 iLearning BatchManager 重试 (single 模式)
            // 但要清掉 KEY_REQ pending 才能重新入队
          }
        }

        const successRate = successPositions.length / batchReq.positions.length;
        log(`📦 批次解析结果: ${successPositions.length}/${batchReq.positions.length} 题 (${(successRate*100).toFixed(0)}%) [失败题号: ${failedPositions.join(',') || '无'}]`, successRate >= 0.7 ? 'success' : 'warn');

        Bridge.completeBatch(batchReq.id);
        Bridge.notifyBatchResult(batchReq.id,
          successRate === 1 ? 'success' : (successRate >= 0.7 ? 'partial' : 'failed'),
          { failedPositions, successCount: successPositions.length, totalCount: batchReq.positions.length });

      } catch (e) {
        log(`❌ 批次处理异常: ${e.message}`, 'error');
        Bridge.completeBatch(batchReq.id);
        Bridge.notifyBatchResult(batchReq.id, 'failed', { failedPositions: batchReq.positions });
      } finally {
        state.busy = false;
        state.currentRequest = null;
        updateCurrent(null);
        updateStats();
      }
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

    // === 队列循环 (v0.10.0: 优先批量请求) ===
    async function tryProcessQueue() {
      if (state.busy) return;
      // 优先处理批量请求
      const batchReq = Bridge.peekNextBatch();
      if (batchReq) {
        await processOneBatch(batchReq);
        setTimeout(tryProcessQueue, 800);
        return;
      }
      // 然后单题
      const req = Bridge.peekNextRequest();
      if (!req) {
        setStatus('idle', '⏸ 等待 iLearning 发题...');
        return;
      }
      await processOneRequest(req);
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
      log('🔔 检测到新单题请求', 'info');
      tryProcessQueue();
    });

    // v0.10.0: 监听批量请求
    Bridge.onBatchRequest(() => {
      log('🔔 检测到新批量请求', 'info');
      tryProcessQueue();
    });

    // 启动时也试一次(防止启动前已有积压)
    setTimeout(tryProcessQueue, 1500);

    // v0.12.2: 删除启动自动去重 (v0.12.0 之后新数据不会重复)

    // 定期更新统计
    setInterval(updateStats, 2000);
    updateStats();
  }
})();
