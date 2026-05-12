// ==UserScript==
// @name         华为会议室自动抢订
// @namespace    huawei-meetingroom-autobook
// @version      0.14.0
// @description  在系统开放预订时刻自动抢订会议室。带并发限制的工作队列 / 提前连续重试 / 精确对时 / Apple 风格界面 / GUI 配置。
// @author       Lucas
// @match        https://inner.welink.huawei.com/meetingroom/*
// @grant        none
// @run-at       document-start
// 把下面两行的 URL 替换成实际托管地址(以 .user.js 结尾),粘贴时去掉前面的 //
// // @updateURL    https://YOUR_INTERNAL_HOST/huawei-meetingroom-autobook.user.js
// // @downloadURL  https://YOUR_INTERNAL_HOST/huawei-meetingroom-autobook.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     📦  配置存储 (localStorage 持久化)
     ═══════════════════════════════════════════════════════════ */
  const STORAGE_KEY = 'mr-autobook-v2';

  const DEFAULTS = {
    timing: {
      bookingOpenTime: '08:30:00',
      daysAhead: 7,                 // "滚动模式": 在执行那一刻 today + daysAhead 算预订日期
      targetDate: null,             // "固定日期模式": ISO 字符串如 '2026-05-18',若设置则覆盖 daysAhead
      preTriggerMs: 100,            // 提前 N 毫秒开始尝试 (默认 100ms)
                                    // 实战数据: 300ms 浪费 3 个 bucket 令牌, 100ms 是最佳平衡
                                    // 进一步可调 50/0ms 更激进, 但需要时钟同步精度好
      maxAttemptDurationSec: 90,    // 最长持续重试 90 秒
    },
    meeting: {
      subject: '团队工作时间',
      timezone: '(UTC+08:00)Beijing',
      timeOffset: 480,
    },
    rooms: [
      { name: 'D02R', roomId: '547157686546268160' },
      { name: 'D05R', roomId: '547157686693068800' },
      { name: 'D34R', roomId: '547157687120887808' },
      { name: 'D45R', roomId: '547157687179612158' },
      { name: 'D47R', roomId: '547157687221551104' },
      { name: 'D53R', roomId: '547157687288659968' },
      { name: 'D61R', roomId: '547157687393517568' },
      { name: 'D67R', roomId: '547157687615819774' },
      { name: 'D70R', roomId: '547157687657758720' },
      { name: 'D71R', roomId: '547157687796170752' },
    ],
    bookings: [],
    advanced: {
      concurrency: 3,               // 同时最多 N 个请求 (服务器约 4 并发上限,留 1 余量)
      interReqDelayMs: 80,
      retryDelayMs: 200,
      maxAttemptsPerTask: 30,
    },
  };

  let CONFIG = loadConfig();

  function loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // 深度合并:确保新增字段(如 v0.4 的 preTriggerSeconds)被填上默认值
        const cfg = deepMerge(deepClone(DEFAULTS), parsed);
        // v0.2 → v0.3 迁移: 重命名旧的 "D45R 示例" 为 "D45R"
        if (cfg.rooms) {
          cfg.rooms.forEach(r => {
            if (r.name === 'D45R 示例') r.name = 'D45R';
          });
        }
        // v0.3 → v0.4 迁移: 移除已废弃的 triggerOffsetMs / retryAttempts / retryIntervalMs
        if (cfg.timing && 'triggerOffsetMs' in cfg.timing) delete cfg.timing.triggerOffsetMs;
        if (cfg.advanced && 'retryAttempts' in cfg.advanced) delete cfg.advanced.retryAttempts;
        if (cfg.advanced && 'retryIntervalMs' in cfg.advanced) delete cfg.advanced.retryIntervalMs;
        // v0.4 → v0.5 迁移: preTriggerSeconds → preTriggerMs
        if (cfg.timing && 'preTriggerSeconds' in cfg.timing) {
          if (!('preTriggerMs' in cfg.timing) || cfg.timing.preTriggerMs === DEFAULTS.timing.preTriggerMs) {
            cfg.timing.preTriggerMs = cfg.timing.preTriggerSeconds * 1000;
          }
          delete cfg.timing.preTriggerSeconds;
        }
        // v0.7 → v0.8 迁移: 老默认 preTriggerMs=1000 实战发现太大,自动迁移到新默认 300
        // 用户如果手动设过其它值(500, 800 等)则保留
        if (cfg.timing && cfg.timing.preTriggerMs === 1000) {
          cfg.timing.preTriggerMs = 300;
        }
        // v0.12 → v0.13 迁移: 真实 8:30 实战发现 300ms 浪费 3 个 bucket 令牌, 改为 100ms
        if (cfg.timing && cfg.timing.preTriggerMs === 300) {
          cfg.timing.preTriggerMs = 100;
        }
        return cfg;
      }
    } catch (e) { /* fall through */ }
    return deepClone(DEFAULTS);
  }

  function deepMerge(target, source) {
    if (!source) return target;
    Object.keys(source).forEach(key => {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    });
    return target;
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
    } catch (e) {
      log('⚠️ 配置保存失败: ' + e.message, 'warn');
    }
  }

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ═══════════════════════════════════════════════════════════
     🔐  Token 捕获 + JWT 解码 (修复 base64url + UTF-8)
     ═══════════════════════════════════════════════════════════ */
  let authToken = null;
  const _origFetch = window.fetch;

  window.fetch = function (...args) {
    try {
      const init = args[1];
      if (init && init.headers) {
        const h = new Headers(init.headers);
        const auth = h.get('Authorization');
        if (auth) authToken = auth;
      }
    } catch (e) { /* ignore */ }
    return _origFetch.apply(this, args);
  };

  const _origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === 'authorization' && value) {
      authToken = value;
    }
    return _origXHRSetHeader.apply(this, arguments);
  };

  function getXSRFToken() {
    const m = document.cookie.match(/X-XSRF-TOKEN=([^;]+)/);
    return m ? m[1] : null;
  }

  function decodeJWT(token) {
    if (!token) return null;
    try {
      const tok = token.replace(/^Bearer\s+/i, '');
      let b64 = tok.split('.')[1];
      b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = atob(b64);
      const jsonStr = decodeURIComponent(
        decoded.split('').map(c =>
          '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        ).join('')
      );
      return JSON.parse(jsonStr);
    } catch (e) {
      return null;
    }
  }

  function getUserAccount() {
    const p = decodeJWT(authToken);
    return (p && (p.preferred_username || p.sub)) || null;
  }

  function getUserDisplayName() {
    const p = decodeJWT(authToken);
    return (p && (p.displayName || p.name)) || null;
  }

  /* ═══════════════════════════════════════════════════════════
     🕐  服务器对时 (NTP 风格,~50ms 精度)
     ═══════════════════════════════════════════════════════════ */
  let serverOffsetMs = 0;
  let lastSyncAt = null;
  let syncQuality = 'NONE';
  let isSyncing = false;

  function getServerNow() {
    return Date.now() + serverOffsetMs;
  }

  async function syncServerTimeQuick() {
    try {
      const resp = await _origFetch.call(window, window.location.origin + '/meetingroom/', {
        method: 'HEAD',
        cache: 'no-store',
      });
      const dateHeader = resp.headers.get('Date');
      if (!dateHeader) throw new Error('无 Date 响应头');
      const serverMs = new Date(dateHeader).getTime();
      serverOffsetMs = (serverMs + 500) - Date.now();
      lastSyncAt = Date.now();
      if (syncQuality !== 'PRECISE') syncQuality = 'COARSE';
      return serverOffsetMs;
    } catch (e) {
      return null;
    }
  }

  async function syncServerTimePrecise() {
    if (isSyncing) {
      log('🕐 对时进行中,稍候...', 'info');
      return null;
    }
    isSyncing = true;
    log('🕐 开始精确对时 (探测服务器秒边界)...', 'info');
    try {
      let lastSec = null;
      const maxAttempts = 25;
      for (let i = 0; i < maxAttempts; i++) {
        const localBefore = Date.now();
        const resp = await _origFetch.call(window, window.location.origin + '/meetingroom/', {
          method: 'HEAD',
          cache: 'no-store',
        });
        const localAfter = Date.now();
        const dateHeader = resp.headers.get('Date');
        if (!dateHeader) continue;
        const serverSec = new Date(dateHeader).getTime();

        if (lastSec !== null && serverSec > lastSec) {
          const localMid = Math.round((localBefore + localAfter) / 2);
          serverOffsetMs = serverSec - localMid;
          lastSyncAt = Date.now();
          syncQuality = 'PRECISE';
          const sign = serverOffsetMs >= 0 ? '慢' : '快';
          log(`🕐 精确对时完成: 本地${sign} ${Math.abs(serverOffsetMs)}ms,用 ${i + 1} 次探测`, 'success');
          isSyncing = false;
          return serverOffsetMs;
        }
        lastSec = serverSec;
        await sleep(80);
      }
      log('⚠️ 未捕获服务器秒数跳变,使用粗对时', 'warn');
      isSyncing = false;
      return await syncServerTimeQuick();
    } catch (e) {
      isSyncing = false;
      log('💥 对时失败: ' + e.message, 'error');
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     📅  时间计算
     ═══════════════════════════════════════════════════════════ */

  // 解析 'YYYY-MM-DD' 字符串为 Date 对象 (本地时区凌晨 0:00)
  function parseTargetDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (isNaN(d.getTime())) return null;
    return d;
  }

  // 计算最终会被预订的那一天的 Date (优先 targetDate, 否则 today + daysAhead)
  function getEffectiveBookingDate() {
    const target = parseTargetDate(CONFIG.timing.targetDate);
    if (target) return target;
    const t = new Date();
    t.setDate(t.getDate() + CONFIG.timing.daysAhead);
    t.setHours(0, 0, 0, 0);
    return t;
  }

  // 计算"距今天还有几天"(用于服务器 ≤ 7 校验)
  function getEffectiveDaysAhead() {
    const target = parseTargetDate(CONFIG.timing.targetDate);
    if (!target) return CONFIG.timing.daysAhead;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  function computeBookingStartTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const t = getEffectiveBookingDate();
    t.setHours(h, m, 0, 0);
    return Math.floor(t.getTime() / 1000);
  }

  function formatBookingDate() {
    const t = getEffectiveBookingDate();
    const w = ['日', '一', '二', '三', '四', '五', '六'][t.getDay()];
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} 周${w}`;
  }

  function computeNextTriggerLocalTime() {
    const [h, m, s] = CONFIG.timing.bookingOpenTime.split(':').map(Number);
    const preTriggerMs = CONFIG.timing.preTriggerMs || 0;

    // 关键逻辑: 设了目标日期时, 触发日 = (目标日期 - 7 天) 当天的 8:30
    // 因为服务器规则是"今天 8:30 开放今天+7 天的槽位", 所以 5/18 = 5/11 的 8:30 才能订
    const targetDate = parseTargetDate(CONFIG.timing.targetDate);
    if (targetDate) {
      const fireDate = new Date(targetDate);
      fireDate.setDate(fireDate.getDate() - 7);
      fireDate.setHours(h, m, s, 0);
      // fireDate.getTime() 是"本地时区的 fire 当天 8:30:00", 也就是服务器的 8:30:00
      // 因为 setHours 是按本地时区算, 而触发时刻应该是"服务器 8:30:00 时的本地时刻"
      const fireLocal = fireDate.getTime() - serverOffsetMs - preTriggerMs;
      // 容忍 60 秒以内的过期 (用户刚错过), 还是按这个时刻算
      if (fireLocal > Date.now() - 60000) {
        return fireLocal;
      }
      // 否则: 触发日已经远远过去, 落到滚动模式 (下一个 8:30)
      // 此时 effective daysAhead 通常 < 7, 会"立即抢" (booking 已经开放)
    }

    // 滚动模式 / targetDate 已过期: 下一个 8:30
    const serverNow = new Date(getServerNow());
    const t = new Date(serverNow);
    t.setHours(h, m, s, 0);
    if (t.getTime() <= serverNow.getTime()) {
      t.setDate(t.getDate() + 1);
    }
    return t.getTime() - serverOffsetMs - preTriggerMs;
  }

  function computeEndTime(startTime, durationMinutes) {
    const [h, m] = startTime.split(':').map(Number);
    const total = h * 60 + m + durationMinutes;
    const eh = Math.floor(total / 60) % 24;
    const em = total % 60;
    return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
  }

  /* ═══════════════════════════════════════════════════════════
     📤  发起预订 + 错误归类
     ═══════════════════════════════════════════════════════════ */
  function buildPayload(booking) {
    return {
      topic: CONFIG.meeting.subject,
      convenerId: getUserAccount(),
      timeOffset: CONFIG.meeting.timeOffset,
      language: 'zh',
      timeZoneDisplayName: CONFIG.meeting.timezone,
      roomBookings: [{
        roomId: booking.roomId,
        startTime: computeBookingStartTime(booking.startTime),
        length: booking.durationMinutes,
      }],
    };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function categorizeError(httpStatus, data) {
    // 提取消息
    const code = data && data.code;
    const msgStr = ((data && (data.message || data.msg || data.error)) || '').toString();
    const detailMsg = (data && data.details && data.details[0] && data.details[0].message) || '';
    const fullMsg = (msgStr + ' ' + detailMsg).trim();
    const m = fullMsg.toLowerCase();

    // ── 业务错误优先识别 (welink 用 code 字段) ──
    // code=8 RESOURCE_EXHAUSTED = 速率限制
    if (code === 8 || m.includes('resource_exhausted') || m.includes('请求次数过多') || m.includes('过于频繁')) {
      return { type: 'RATE_LIMIT', tip: `⏱ 请求频率限制 · 自动重试中`, retry: true, retryDelayMs: 200 };
    }
    // 尚未到开放时刻 (服务器英文错误码) - 跟"日期还没滚到"是不同概念
    // 这是"今天 8:30 还没到"的语义,必须持续重试,无关 daysAhead 设置
    if (m.includes('not_reaching_schedule_start') || m.includes('not_reaching') || m.includes('schedule_start_time')) {
      return { type: 'NOT_OPEN', tip: `⏳ 尚未到开放时刻 · 持续尝试`, retry: true, retryDelayMs: 150 };
    }
    // 超过提前预订天数 - 当 effective daysAhead<=7 时,这是"尚未滚动到第7天",必须持续重试
    // 注意: 80ms 太快会触发服务器限流 (10 任务 × 38 req/s = 限流爆炸), 用 150ms 平衡
    if (m.includes('exceed_booking_advance') || m.includes('exceed_advance')) {
      const effDays = getEffectiveDaysAhead();
      if (effDays <= 7) {
        return { type: 'NOT_OPEN', tip: `⏳ 尚未开放 (advance limit) · 持续尝试`, retry: true, retryDelayMs: 150 };
      }
      return { type: 'OUT_OF_RANGE', tip: `📅 超出可预订范围 · 距今 ${effDays} 天 > 7`, retry: false };
    }
    // 中文 fallback - 持续重试直到放开
    if (m.includes('尚未') || m.includes('未开放') || m.includes('未到') || m.includes('not_open') || m.includes('not open')) {
      return { type: 'NOT_OPEN', tip: `⏳ 尚未开放预订 · 持续尝试中`, retry: true, retryDelayMs: 150 };
    }
    // 时间冲突 (与他人预订冲突 OR 与自己已有预订重叠)
    if (m.includes('冲突') || m.includes('占用') || m.includes('被预订') || m.includes('已订') || m.includes('overlap') || m.includes('已有预订') || m.includes('span_in_use') || m.includes('in_use')) {
      return { type: 'CONFLICT', tip: `🔴 时间冲突 · ${detailMsg || msgStr || '与已有预订重叠或被他人占用'}`, retry: false };
    }
    // 超出范围 (中文)
    if (m.includes('范围') || m.includes('提前') || m.includes('超出') || m.includes('only allow')) {
      return { type: 'OUT_OF_RANGE', tip: `📅 超出可预订范围 · ${detailMsg || msgStr}`, retry: false };
    }
    // 重复
    if (m.includes('重复')) {
      return { type: 'DUPLICATE', tip: `🔁 重复预订 · ${detailMsg || msgStr}`, retry: false };
    }
    // 不存在
    if (m.includes('不存在') || m.includes('找不到')) {
      return { type: 'NOT_FOUND', tip: `❓ 房间不存在 · ${detailMsg || msgStr}`, retry: false };
    }

    // ── HTTP 状态码兜底 ──
    if (httpStatus === 401) return { type: 'AUTH', tip: '🔒 Token 已过期 · 请刷新页面重新登录', retry: false };
    if (httpStatus === 403) return { type: 'PERMISSION', tip: '🚫 权限不足', retry: false };
    if (httpStatus === 409) return { type: 'CONFLICT', tip: `🔴 时间冲突 · ${detailMsg || msgStr || '已被占用'}`, retry: false };
    if (httpStatus === 429) return { type: 'RATE_LIMIT', tip: '⏱ HTTP 429 · 请求过于频繁', retry: true, retryDelayMs: 200 };
    if (httpStatus === 400) {
      // 400 通常是请求被业务规则拒绝,重试无意义
      return { type: 'BAD_REQUEST', tip: `⚠️ 请求被拒绝 · ${detailMsg || msgStr || 'BAD_REQUEST'}`, retry: false };
    }
    if (httpStatus >= 500) return { type: 'SERVER_ERROR', tip: `🔥 服务器异常 (${httpStatus})`, retry: true, retryDelayMs: 500 };

    // 其它未知,允许少量重试
    return { type: 'OTHER', tip: `⚠️ ${detailMsg || msgStr || '未知错误'}`, retry: true, retryDelayMs: 200 };
  }

  // 单次尝试,不做内部重试。重试由 executeAllBookings 的工作池调度。
  async function attemptBooking(booking, label) {
    if (!authToken) return { success: false, retriable: false, type: 'NO_AUTH', tip: '🔒 无 Token' };
    const xsrfToken = getXSRFToken();
    if (!xsrfToken) return { success: false, retriable: false, type: 'NO_XSRF', tip: '🔒 无 XSRF' };

    const url = `https://inner.welink.huawei.com/meetingroom/schedule/v1/bookings?_t=${Date.now()}`;
    const payload = buildPayload(booking);

    try {
      const t0 = performance.now();
      const resp = await _origFetch.call(window, url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh',
          'Content-Type': 'application/json',
          'Authorization': authToken,
          'X-XSRF-TOKEN': xsrfToken,
          'X-WeLink-Source': '0',
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const elapsed = Math.round(performance.now() - t0);

      let data = {};
      try { data = await resp.json(); } catch (e) { /* not json */ }

      const success = resp.ok && (
        data.code === 0 ||
        data.code === undefined ||
        data.code === null ||
        data.success === true ||
        (data.id && !data.error)
      );

      if (success) {
        return { success: true, orderId: data.id, elapsed };
      }
      const cat = categorizeError(resp.status, data);
      return {
        success: false,
        retriable: cat.retry,
        type: cat.type,
        tip: cat.tip,
        retryDelayMs: cat.retryDelayMs || CONFIG.advanced.retryDelayMs,
        rawData: data,
        elapsed,
      };
    } catch (err) {
      return {
        success: false,
        retriable: true,
        type: 'NETWORK',
        tip: `💥 网络异常: ${err.message}`,
        retryDelayMs: 200,
      };
    }
  }

  async function executeAllBookings() {
    if (!CONFIG.bookings.length) {
      log('⚠️ 没有任何任务,请在 [任务] 标签页里添加', 'warn');
      return;
    }

    const concurrency = Math.max(1, CONFIG.advanced.concurrency || 3);
    const interReqDelay = Math.max(0, CONFIG.advanced.interReqDelayMs || 0);
    const maxAttempts = Math.max(1, CONFIG.advanced.maxAttemptsPerTask || 30);
    const maxDurationMs = Math.max(5, CONFIG.timing.maxAttemptDurationSec || 90) * 1000;
    const deadline = Date.now() + maxDurationMs;

    log(`🚀 开始抢订 ${CONFIG.bookings.length} 个任务 (并发=${concurrency},单任务最多 ${maxAttempts} 次,持续上限 ${maxDurationMs / 1000}s)`);
    const t0 = performance.now();

    // 每个任务的运行状态
    const states = CONFIG.bookings.map((b, i) => {
      const room = CONFIG.rooms.find(r => r.roomId === b.roomId);
      const roomLabel = room ? room.name : b.roomId.slice(-6);
      return {
        booking: b,
        index: i + 1,
        label: `[#${i + 1} ${roomLabel} ${b.startTime}]`,
        status: 'pending',  // pending | inflight | success | failed
        attempts: 0,
        result: null,
        nextEarliestAt: 0,  // 下一次可尝试的最早时刻 (用于错误退避)
        consecutiveRateLimit: 0,  // 连续被限流次数, 用于指数退避
      };
    });

    setStatus('firing', `🔴 抢订中 · 0/${states.length} 已成功`, 60);

    function refreshFiringStatus() {
      const ok = states.filter(s => s.status === 'success').length;
      const failed = states.filter(s => s.status === 'failed').length;
      setStatus('firing', `🔴 抢订中 · ${ok} 成功 / ${failed} 失败 / ${states.length - ok - failed} 进行中`, 60);
    }

    // 工作池: concurrency 个 worker 并行从队列里抽任务
    async function worker(workerId) {
      while (true) {
        const now = Date.now();
        if (now >= deadline) {
          // 全局超时, 把所有 pending 标为失败
          states.filter(s => s.status === 'pending').forEach(s => {
            s.status = 'failed';
            s.result = { tip: `⏱ 超时 (${maxDurationMs / 1000}s)`, type: 'TIMEOUT' };
          });
          return;
        }

        // 找一个可以尝试的任务: pending 且 nextEarliestAt 已到
        const state = states.find(s => s.status === 'pending' && now >= s.nextEarliestAt);
        if (!state) {
          // 没有立即可执行的, 看看还有没有 pending(等待退避)
          const stillPending = states.some(s => s.status === 'pending' || s.status === 'inflight');
          if (!stillPending) return;
          await sleep(20);
          continue;
        }

        if (state.attempts >= maxAttempts) {
          state.status = 'failed';
          state.result = { tip: `⏱ 达到最大尝试次数 ${maxAttempts}`, type: 'MAX_RETRY' };
          refreshFiringStatus();
          continue;
        }

        state.status = 'inflight';
        state.attempts++;
        const result = await attemptBooking(state.booking, state.label);

        if (result.success) {
          state.status = 'success';
          state.result = result;
          state.consecutiveRateLimit = 0;
          log(`✅ ${state.label} 第 ${state.attempts} 次成功 (${result.elapsed}ms)`, 'success');
          if (result.orderId) log(`   订单号: ${result.orderId}`, 'debug');
        } else if (result.retriable && Date.now() < deadline && state.attempts < maxAttempts) {
          // 排回队列, 设置最早重试时刻
          state.status = 'pending';
          // 指数退避: 连续被限流时退避时间翻倍 (200→350→500→700→800ms 上限)
          if (result.type === 'RATE_LIMIT') {
            state.consecutiveRateLimit++;
            const backoff = Math.min(200 + 150 * (state.consecutiveRateLimit - 1), 800);
            state.nextEarliestAt = Date.now() + backoff;
          } else {
            state.consecutiveRateLimit = 0;
            state.nextEarliestAt = Date.now() + (result.retryDelayMs || 200);
          }
          // 重要错误首 3 次都显示, 之后每 5 次显示一次, 避免刷屏
          if (state.attempts <= 3 || state.attempts % 5 === 0) {
            log(`⏳ ${state.label} 第 ${state.attempts} 次: ${result.tip}`, 'warn');
          }
        } else {
          state.status = 'failed';
          state.result = result;
          log(`❌ ${state.label} 终止: ${result.tip}`, 'warn');
        }

        refreshFiringStatus();

        // 同 worker 两次请求最小间隔
        if (interReqDelay > 0) await sleep(interReqDelay);
      }
    }

    await Promise.all(Array(concurrency).fill().map((_, i) => worker(i)));

    const ok = states.filter(s => s.status === 'success').length;
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    // 统计失败原因
    const failGroups = {};
    states.filter(s => s.status === 'failed').forEach(s => {
      const r = (s.result && s.result.tip) || '未知';
      failGroups[r] = (failGroups[r] || 0) + 1;
    });
    const failSummary = Object.entries(failGroups).map(([r, c]) => `${c}×「${r}」`).join('  ');

    if (ok === states.length) {
      log(`🎉 全部抢订成功 (${ok}/${states.length},耗时 ${elapsed}s)`, 'success');
      setStatus('done', `✅ 全部成功 ${ok}/${states.length}`, 60);
    } else if (ok > 0) {
      log(`⚠️ 部分成功 (${ok}/${states.length},耗时 ${elapsed}s)`, 'warn');
      if (failSummary) log(`   失败原因汇总: ${failSummary}`, 'debug');
      setStatus('partial', `⚠️ ${ok}/${states.length} 成功`, 60);
    } else {
      log(`❌ 全部失败 (耗时 ${elapsed}s)`, 'error');
      if (failSummary) log(`   失败原因汇总: ${failSummary}`, 'debug');
      setStatus('error', `❌ 全部失败 0/${states.length}`, 30);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     ⏰  定时触发
     ═══════════════════════════════════════════════════════════ */
  let scheduledTimerId = null;
  let scheduledLocalTime = null;
  let preTriggerSyncTimerId = null;
  let preTriggerSync5sTimerId = null;

  function scheduleAutoBook() {
    if (!CONFIG.bookings.length) {
      log('⚠️ 没有任务,先在[任务]标签页添加', 'warn');
      return;
    }
    cancelSchedule();

    syncServerTimePrecise().finally(() => {
      scheduledLocalTime = computeNextTriggerLocalTime();
      const waitMs = scheduledLocalTime - Date.now();
      const fireDateObj = new Date(scheduledLocalTime);
      const localFireTime = formatTimeWithMs(fireDateObj);
      const fireDateStr = `${fireDateObj.getMonth() + 1}月${fireDateObj.getDate()}日`;
      const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][fireDateObj.getDay()];
      const preTriggerMs = CONFIG.timing.preTriggerMs || 0;
      const targetDateStr = CONFIG.timing.targetDate ? ` (订 ${formatBookingDate()})` : '';
      log(`⏰ 服务器 ${CONFIG.timing.bookingOpenTime} 开放预订${targetDateStr}`, 'info');
      log(`   工具将在 ${fireDateStr} ${dayName} ${localFireTime} 启动 (提前 ${preTriggerMs}ms)`, 'info');
      const hours = Math.floor(waitMs / 3600000);
      const minutes = Math.floor((waitMs % 3600000) / 60000);
      const seconds = Math.floor((waitMs % 60000) / 1000);
      log(`   ⏳ 还剩 ${hours > 0 ? hours + '小时 ' : ''}${minutes > 0 ? minutes + '分 ' : ''}${seconds}秒`, 'info');
      // 状态栏显示触发日 (清晰表达"会在哪天哪刻动")
      const fireTimeShort = `${String(fireDateObj.getHours()).padStart(2, '0')}:${String(fireDateObj.getMinutes()).padStart(2, '0')}`;
      setStatus('armed', `🟢 已就绪 · ${fireDateStr} ${dayName} ${fireTimeShort} 开抢`);

      if (waitMs > 35000) {
        preTriggerSyncTimerId = setTimeout(() => {
          if (scheduledLocalTime) {
            const prevOffset = serverOffsetMs;
            log('🕐 抢订前 30 秒重新对时...', 'info');
            syncServerTimePrecise().finally(() => {
              const drift = serverOffsetMs - prevOffset;
              if (Math.abs(drift) > 100) {
                log(`⚠️ 时钟漂移 ${drift > 0 ? '+' : ''}${drift}ms · 系统时钟不稳, 可能影响抢订精度`, 'warn');
                log(`   建议: 管理员 cmd 跑 'w32tm /resync /force' 修复系统时间同步`, 'debug');
              }
              scheduledLocalTime = computeNextTriggerLocalTime();
            });
          }
        }, waitMs - 30000);
      }

      // v0.14 新增: 抢订前 5 秒补一次对时, catch 任何最后时刻的时钟跳跃
      // 这是 8:29:55 左右触发, 5s 给 sync 完成 + busy-wait 预备时间
      if (waitMs > 6000) {
        preTriggerSync5sTimerId = setTimeout(() => {
          if (scheduledLocalTime) {
            const prevOffset = serverOffsetMs;
            log('🕐 抢订前 5 秒最终对时...', 'info');
            syncServerTimePrecise().finally(() => {
              const drift = serverOffsetMs - prevOffset;
              if (Math.abs(drift) > 50) {
                log(`⚠️ 5 秒内时钟又漂了 ${drift > 0 ? '+' : ''}${drift}ms · 抢订精度受损`, 'warn');
              }
              scheduledLocalTime = computeNextTriggerLocalTime();
              const newWait = scheduledLocalTime - Date.now();
              log(`   触发时刻修正为本地 ${formatTimeWithMs(new Date(scheduledLocalTime))} (还剩 ${newWait}ms)`, 'debug');
            });
          }
        }, waitMs - 5000);
      }

      scheduledTimerId = setTimeout(() => {
        busyWaitThenFire();
      }, Math.max(0, waitMs - 500));
    });
  }

  function busyWaitThenFire() {
    if (!scheduledLocalTime) return;
    const target = scheduledLocalTime;
    const remaining = target - Date.now();

    if (remaining <= 0) {
      // 已过期, 立即开火
      scheduledLocalTime = null;
      scheduledTimerId = null;
      executeAllBookings();
      return;
    }

    if (remaining > 250) {
      // 距离 > 250ms, 继续用 setTimeout 等待 (省 CPU)
      // 提前 100ms 进入下一次检查, 避免 setTimeout 不精确的影响
      scheduledTimerId = setTimeout(busyWaitThenFire, Math.max(remaining - 200, 10));
      return;
    }

    // 距离 ≤ 250ms: 进入真·busy-wait (堵 JS 主线程, 避免 setTimeout 节流)
    // 注意: 这会卡 UI 200ms 左右, 但能保证毫秒级精度
    scheduledLocalTime = null;
    scheduledTimerId = null;
    while (Date.now() < target) { /* spin */ }
    executeAllBookings();
  }

  function cancelSchedule() {
    if (scheduledTimerId) {
      clearTimeout(scheduledTimerId);
      scheduledTimerId = null;
    }
    if (preTriggerSyncTimerId) {
      clearTimeout(preTriggerSyncTimerId);
      preTriggerSyncTimerId = null;
    }
    if (preTriggerSync5sTimerId) {
      clearTimeout(preTriggerSync5sTimerId);
      preTriggerSync5sTimerId = null;
    }
    if (scheduledLocalTime) {
      scheduledLocalTime = null;
      log('⏹ 已取消定时', 'info');
      setStatus('idle', '⏸ 待命中');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     🎨  UI 浮窗
     ═══════════════════════════════════════════════════════════ */
  function buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      /* ── Apple Human Interface 风格 ── */
      #mr-panel{position:fixed;bottom:20px;right:20px;width:420px;
        background:rgba(255,255,255,0.92);
        backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);
        border:0.5px solid rgba(0,0,0,0.08);border-radius:14px;
        box-shadow:0 10px 40px rgba(0,0,0,0.12),0 1px 3px rgba(0,0,0,0.04);
        font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
        font-size:12px;z-index:99999;color:#1d1d1f;line-height:1.5;letter-spacing:-0.01em}
      #mr-panel *{box-sizing:border-box}
      #mr-panel .h{display:flex;justify-content:space-between;align-items:center;
        padding:11px 16px;border-bottom:0.5px solid rgba(0,0,0,0.08);cursor:move;user-select:none;
        background:transparent;border-radius:14px 14px 0 0}
      #mr-panel .tt{font-weight:600;font-size:13px;letter-spacing:-0.02em;color:#1d1d1f}
      #mr-panel .tg{cursor:pointer;color:#86868b;font-size:18px;line-height:1;padding:0 4px;font-weight:300}
      #mr-panel .tg:hover{color:#1d1d1f}
      #mr-panel .body{padding:12px 16px}
      #mr-panel .body.col{display:none}
      #mr-panel .st{padding:8px 12px;background:rgba(142,142,147,0.12);border-radius:9px;font-size:12px;
        margin-bottom:10px;text-align:center;font-weight:500}
      #mr-panel .st.armed{background:rgba(48,209,88,0.15);color:#248a3d}
      #mr-panel .st.firing{background:rgba(255,159,10,0.15);color:#c93400}
      #mr-panel .st.warn{background:rgba(255,204,0,0.18);color:#9a7400}
      #mr-panel .st.idle{background:rgba(48,209,88,0.15);color:#248a3d}
      #mr-panel .st.error{background:rgba(255,59,48,0.15);color:#d70015}
      #mr-panel .st.done{background:rgba(48,209,88,0.18);color:#248a3d}
      #mr-panel .st.partial{background:rgba(255,159,10,0.15);color:#c93400}
      #mr-panel .cd{font-family:"SF Mono","Menlo","Consolas",monospace;font-size:30px;text-align:center;
        margin:6px 0 4px;font-weight:300;letter-spacing:-0.02em;color:#1d1d1f;font-variant-numeric:tabular-nums}
      #mr-panel .sync{font-size:11px;color:#86868b;text-align:center;margin-bottom:10px}
      #mr-panel .sync.precise{color:#248a3d}
      #mr-panel .sync.coarse{color:#c93400}
      #mr-panel .sync.none{color:#d70015}
      #mr-panel .info{font-size:12px;color:#3a3a3c;text-align:center;margin-bottom:10px;line-height:1.7}
      #mr-panel .btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
      #mr-panel .btns2{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
      /* 表单控件 */
      #mr-panel button,#mr-panel input[type=text],#mr-panel input[type=number],
      #mr-panel input[type=time],#mr-panel select{padding:7px 10px;font-size:12px;
        border:0.5px solid rgba(0,0,0,0.12);background:rgba(255,255,255,0.85);border-radius:8px;
        font-family:inherit;color:#1d1d1f;outline:none;transition:all .15s}
      #mr-panel input:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,0.15)}
      #mr-panel button{cursor:pointer;font-weight:500}
      #mr-panel button:hover{background:rgba(0,0,0,0.04);border-color:rgba(0,0,0,0.18)}
      #mr-panel button.pri{background:#0071e3;color:#fff;border-color:#0071e3;font-weight:500}
      #mr-panel button.pri:hover{background:#0077ed;border-color:#0077ed}
      #mr-panel button.sec{color:#86868b}
      #mr-panel .tabs{display:flex;border-bottom:0.5px solid rgba(0,0,0,0.08);margin:0 -16px 10px;padding:0 4px}
      #mr-panel .tab{flex:1;padding:8px 4px;text-align:center;cursor:pointer;font-size:12px;font-weight:500;
        border-bottom:2px solid transparent;color:#86868b;transition:all .15s}
      #mr-panel .tab.active{color:#0071e3;border-bottom-color:#0071e3}
      #mr-panel .tab:hover:not(.active){color:#3a3a3c}
      #mr-panel .pane{display:none;height:340px;overflow-y:auto;padding-right:2px}
      #mr-panel .pane.active{display:block}
      #mr-panel .pane#pane-log.active{display:flex;flex-direction:column}
      /* 任务条 */
      #mr-panel .task-header{display:flex;justify-content:space-between;align-items:center;
        padding:6px 10px;margin-bottom:8px;font-size:12px;background:rgba(142,142,147,0.08);border-radius:8px}
      #mr-panel .task-clear-btn{cursor:pointer;color:#ff3b30;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:500}
      #mr-panel .task-clear-btn:hover{background:rgba(255,59,48,0.1)}
      #mr-panel .empty{text-align:center;color:#86868b;padding:24px 8px;font-size:12px}
      #mr-panel .item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;
        border:0.5px solid rgba(0,0,0,0.06);border-radius:8px;margin-bottom:5px;
        background:rgba(255,255,255,0.6);font-size:12px;transition:all .15s}
      #mr-panel .item:hover{background:rgba(255,255,255,0.9);border-color:rgba(0,0,0,0.12)}
      #mr-panel .item .left{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #mr-panel .item .x{color:#ff3b30;cursor:pointer;padding:2px 8px;font-size:16px;line-height:1;border-radius:6px;font-weight:300}
      #mr-panel .item .x:hover{background:rgba(255,59,48,0.1)}
      /* 房间网格 4 列 */
      #mr-panel .rooms-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
      #mr-panel .room-cell{display:flex;justify-content:space-between;align-items:center;padding:6px 7px;
        border:0.5px solid rgba(0,0,0,0.08);border-radius:8px;background:rgba(255,255,255,0.7);
        font-size:11px;overflow:hidden;transition:all .15s;font-weight:500}
      #mr-panel .room-cell:hover{background:rgba(255,255,255,0.95);border-color:rgba(0,0,0,0.16)}
      #mr-panel .room-cell .rn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #mr-panel .room-cell .x{color:#ff3b30;cursor:pointer;padding:0 4px;font-size:13px;line-height:1;flex-shrink:0;font-weight:300}
      #mr-panel .room-cell .x:hover{background:rgba(255,59,48,0.1);border-radius:4px}
      #mr-panel .add-btn{width:100%;padding:9px;border:1px dashed rgba(0,0,0,0.18);
        background:rgba(255,255,255,0.5);border-radius:9px;
        cursor:pointer;color:#86868b;font-size:12px;margin-bottom:6px;font-weight:500;transition:all .15s}
      #mr-panel .add-btn:hover{background:rgba(255,255,255,0.85);border-color:rgba(0,113,227,0.4);color:#0071e3}
      #mr-panel .form{background:rgba(142,142,147,0.06);border:0.5px solid rgba(0,0,0,0.06);
        padding:12px;border-radius:10px;margin-bottom:8px}
      #mr-panel .form-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      #mr-panel .form-row label{font-size:12px;color:#3a3a3c;min-width:54px;flex-shrink:0;font-weight:500}
      #mr-panel .form-row input,#mr-panel .form-row select{flex:1}
      #mr-panel .preset-row{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
      #mr-panel .preset-btn{padding:5px 10px;font-size:11px;background:rgba(255,255,255,0.85);
        border:0.5px solid rgba(0,0,0,0.1);border-radius:7px;cursor:pointer;font-weight:500}
      #mr-panel .preset-btn:hover{background:#fff}
      #mr-panel .preset-btn.on{background:#0071e3;color:#fff;border-color:#0071e3}
      #mr-panel .slot-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;
        background:rgba(255,255,255,0.7);border:0.5px solid rgba(0,0,0,0.08);
        border-radius:8px;padding:6px}
      #mr-panel .slot-cb{display:flex;align-items:center;padding:5px 8px;cursor:pointer;
        font-size:12px;border-radius:6px;font-weight:500}
      #mr-panel .slot-cb:hover{background:rgba(0,113,227,0.08)}
      #mr-panel .slot-cb input{margin-right:8px;accent-color:#0071e3}
      #mr-panel .form-buttons{display:flex;gap:6px;margin-top:8px}
      #mr-panel .form-buttons button{flex:1;padding:7px;font-size:12px}
      #mr-panel .form-buttons button.save{background:#0071e3;color:#fff;border-color:#0071e3;font-weight:500}
      #mr-panel .form-buttons button.save:hover{background:#0077ed}
      /* 房间多选 5 列网格 */
      #mr-panel .checkbox-list{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;
        max-height:120px;overflow-y:auto;border:0.5px solid rgba(0,0,0,0.08);
        border-radius:8px;background:rgba(255,255,255,0.7);padding:6px}
      #mr-panel .checkbox-list label{display:flex;align-items:center;padding:4px 6px;cursor:pointer;
        font-size:11px;border-radius:6px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #mr-panel .checkbox-list label:hover{background:rgba(0,113,227,0.08)}
      #mr-panel .checkbox-list input{margin-right:5px;flex-shrink:0;accent-color:#0071e3}
      /* 日志 */
      #mr-panel .ll{font-size:11px;color:#86868b;margin-bottom:6px;display:flex;
        justify-content:space-between;flex-shrink:0;font-weight:500}
      #mr-panel .clr{cursor:pointer;color:#0071e3}
      #mr-panel .clr:hover{text-decoration:underline}
      #mr-panel .log{background:rgba(0,0,0,0.03);border:0.5px solid rgba(0,0,0,0.06);
        border-radius:8px;padding:8px 10px;flex:1;min-height:0;overflow-y:auto;
        font-family:"SF Mono","Menlo","Consolas",monospace;font-size:11px;line-height:1.55}
      #mr-panel .log .l-info{color:#3a3a3c}
      #mr-panel .log .l-debug{color:#86868b}
      #mr-panel .log .l-success{color:#248a3d;font-weight:500}
      #mr-panel .log .l-warn{color:#c93400}
      #mr-panel .log .l-error{color:#d70015;font-weight:500}
      #mr-panel .help{font-size:11px;color:#86868b;line-height:1.6;padding:8px 0}
      #mr-panel .warn-text{color:#c93400;font-size:11px;margin-top:6px;font-weight:500}
      /* 滚动条美化 (Apple 风格) */
      #mr-panel ::-webkit-scrollbar{width:6px;height:6px}
      #mr-panel ::-webkit-scrollbar-track{background:transparent}
      #mr-panel ::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.18);border-radius:3px}
      #mr-panel ::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.3)}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'mr-panel';
    panel.innerHTML = `
      <div class="h">
        <span class="tt">📅 会议室自动抢订 v0.14</span>
        <span class="tg" id="tg">−</span>
      </div>
      <div class="body" id="body">
        <div class="st" id="st">⏳ 初始化中...</div>
        <div class="cd" id="cd">--:--:--</div>
        <div class="sync" id="sync">未对时</div>
        <div class="info" id="info"></div>
        <div class="btns2">
          <button id="btn-now" class="pri">🚀 立即抢订</button>
          <button id="btn-sc">⏰ 定时启动</button>
        </div>
        <div class="btns2">
          <button id="btn-cl" class="sec">取消定时</button>
          <button id="btn-sync" class="sec">手动对时</button>
        </div>
        <div class="tabs">
          <div class="tab active" data-pane="pane-tasks">📋 任务</div>
          <div class="tab" data-pane="pane-rooms">🏢 房间</div>
          <div class="tab" data-pane="pane-set">⚙️ 设置</div>
          <div class="tab" data-pane="pane-log">📜 日志</div>
        </div>
        <div class="pane active" id="pane-tasks"></div>
        <div class="pane" id="pane-rooms"></div>
        <div class="pane" id="pane-set"></div>
        <div class="pane" id="pane-log">
          <div class="ll"><span>实时日志</span><span class="clr" id="log-clr">清屏</span></div>
          <div class="log" id="log"></div>
        </div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        panel.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.pane).classList.add('active');
      });
    });

    document.getElementById('btn-now').onclick = () => {
      if (!CONFIG.bookings.length) { alert('请先在[任务]标签页添加抢订任务'); return; }
      if (confirm(`⚠️ 立即抢订会真实发送 ${CONFIG.bookings.length} 个预订请求,可能产生真实预约。\n确认继续?`)) {
        executeAllBookings();
      }
    };
    document.getElementById('btn-sc').onclick = scheduleAutoBook;
    document.getElementById('btn-cl').onclick = cancelSchedule;
    document.getElementById('btn-sync').onclick = () => syncServerTimePrecise();
    document.getElementById('log-clr').onclick = () => { document.getElementById('log').innerHTML = ''; };
    document.getElementById('tg').onclick = (e) => {
      const body = document.getElementById('body');
      const collapsed = body.classList.toggle('col');
      e.target.textContent = collapsed ? '+' : '−';
    };

    enableDrag(panel);
    renderTasksPane();
    renderRoomsPane();
    renderSettingsPane();
    updateUI();
  }

  function enableDrag(panel) {
    const header = panel.querySelector('.h');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'tg') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - dx) + 'px';
      panel.style.top = (e.clientY - dy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ═══════════════════════════════════════════════════════════
     📋  任务 Tab
     ═══════════════════════════════════════════════════════════ */
  function renderTasksPane() {
    const pane = document.getElementById('pane-tasks');
    if (!pane) return;

    let html = '';
    if (!CONFIG.bookings.length) {
      html += '<div class="empty">还没有抢订任务,点击下方按钮添加</div>';
    } else {
      // 顶部头:任务计数 + 清空全部
      html += `<div class="task-header">
        <span style="color:#666">共 <b>${CONFIG.bookings.length}</b> 个任务</span>
        <span class="task-clear-btn" id="clear-all-tasks">🗑 清空全部</span>
      </div>`;
      const dateStr = formatBookingDate();
      CONFIG.bookings.forEach((b, i) => {
        const room = CONFIG.rooms.find(r => r.roomId === b.roomId);
        const roomLabel = room ? room.name : `<未知房间 ${b.roomId.slice(-6)}>`;
        const endTime = computeEndTime(b.startTime, b.durationMinutes);
        html += `
          <div class="item">
            <div class="left">📌 <b>${escapeHtml(roomLabel)}</b> · ${dateStr} · ${b.startTime}~${endTime}</div>
            <span class="x" data-action="del-task" data-idx="${i}" title="删除">×</span>
          </div>`;
      });
    }
    html += '<button class="add-btn" id="add-task-btn">+ 添加抢订任务</button>';
    html += '<div id="task-form-host"></div>';
    pane.innerHTML = html;

    pane.querySelectorAll('[data-action=del-task]').forEach(el => {
      el.onclick = () => {
        if (confirm('确认删除这个任务?')) {
          CONFIG.bookings.splice(parseInt(el.dataset.idx), 1);
          saveConfig();
          renderTasksPane();
          updateUI();
        }
      };
    });
    document.getElementById('add-task-btn').onclick = showAddTaskForm;

    const clearBtn = document.getElementById('clear-all-tasks');
    if (clearBtn) {
      clearBtn.onclick = () => {
        if (confirm(`⚠️ 确认清空全部 ${CONFIG.bookings.length} 个任务? 此操作不可撤销。`)) {
          const n = CONFIG.bookings.length;
          CONFIG.bookings = [];
          saveConfig();
          renderTasksPane();
          updateUI();
          log(`🗑 已清空 ${n} 个任务`, 'info');
        }
      };
    }
  }

  function showAddTaskForm() {
    const host = document.getElementById('task-form-host');
    if (!host) return;

    if (!CONFIG.rooms.length) {
      host.innerHTML = `<div class="form"><div class="warn-text">⚠️ 还没有任何会议室,请先到[房间]标签页添加</div></div>`;
      return;
    }

    const roomCheckboxes = CONFIG.rooms.map(r =>
      `<label><input type="checkbox" name="task-room" value="${r.roomId}"> ${escapeHtml(r.name)}</label>`
    ).join('');

    host.innerHTML = `
      <div class="form">
        <div style="font-size:11px;color:#666;margin-bottom:4px">选择房间 (可多选)</div>
        <div class="checkbox-list">${roomCheckboxes}</div>
        <div style="font-size:11px;color:#666;margin:8px 0 4px">时段 (可多选, 会与房间组合展开)</div>
        <div class="slot-row">
          <label class="slot-cb"><input type="checkbox" name="slot" value="morning" checked> 上午 08:30~12:00</label>
          <label class="slot-cb"><input type="checkbox" name="slot" value="afternoon"> 下午 14:00~18:00</label>
          <label class="slot-cb"><input type="checkbox" name="slot" value="custom" id="slot-custom-cb"> 自定义</label>
        </div>
        <div id="slot-custom-row" style="display:none">
          <div class="form-row">
            <label>开始</label>
            <input type="time" id="task-start" value="09:00" step="1800">
          </div>
          <div class="form-row">
            <label>结束</label>
            <input type="time" id="task-end" value="11:00" step="1800">
            <span style="font-size:11px;color:#666">30 分钟颗粒</span>
          </div>
        </div>
        <div class="form-buttons">
          <button id="task-save" class="save">保存</button>
          <button id="task-cancel">取消</button>
        </div>
        <div class="warn-text" id="task-warn" style="display:none"></div>
      </div>`;

    // 自定义勾选时显示自定义时间输入
    const customCb = document.getElementById('slot-custom-cb');
    const customRow = document.getElementById('slot-custom-row');
    customCb.onchange = () => {
      customRow.style.display = customCb.checked ? 'block' : 'none';
    };

    document.getElementById('task-cancel').onclick = () => { host.innerHTML = ''; };
    document.getElementById('task-save').onclick = () => {
      const checkedRooms = Array.from(host.querySelectorAll('input[name=task-room]:checked')).map(c => c.value);
      const checkedSlots = Array.from(host.querySelectorAll('input[name=slot]:checked')).map(c => c.value);
      const warn = document.getElementById('task-warn');

      if (!checkedRooms.length) { warn.style.display = 'block'; warn.textContent = '⚠️ 至少选择一个房间'; return; }
      if (!checkedSlots.length) { warn.style.display = 'block'; warn.textContent = '⚠️ 至少选择一个时段'; return; }

      // 收集所有要展开的时段
      const slots = [];
      if (checkedSlots.includes('morning'))   slots.push({ start: '08:30', end: '12:00' });
      if (checkedSlots.includes('afternoon')) slots.push({ start: '14:00', end: '18:00' });
      if (checkedSlots.includes('custom')) {
        const startTime = document.getElementById('task-start').value;
        const endTime = document.getElementById('task-end').value;
        if (!startTime || !startTime.match(/^\d{2}:\d{2}$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ 自定义开始时间格式错误'; return; }
        if (!endTime || !endTime.match(/^\d{2}:\d{2}$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ 自定义结束时间格式错误'; return; }
        const [csh, csm] = startTime.split(':').map(Number);
        const [ceh, cem] = endTime.split(':').map(Number);
        const cdur = (ceh * 60 + cem) - (csh * 60 + csm);
        if (cdur <= 0) { warn.style.display = 'block'; warn.textContent = '⚠️ 自定义: 结束时间必须晚于开始'; return; }
        if (cdur > 240) { warn.style.display = 'block'; warn.textContent = `⚠️ 自定义: 单段最长 4 小时,你设置了 ${cdur} 分钟`; return; }
        if (cdur < 30) { warn.style.display = 'block'; warn.textContent = '⚠️ 自定义: 时长不能少于 30 分钟'; return; }
        if (cdur % 30 !== 0) { warn.style.display = 'block'; warn.textContent = `⚠️ 自定义: 时长必须是 30 分钟整数倍 (${cdur} 分钟)`; return; }
        if (csm % 30 !== 0 || cem % 30 !== 0) { warn.style.display = 'block'; warn.textContent = '⚠️ 自定义: 时刻必须整点或半点'; return; }
        slots.push({ start: startTime, end: endTime });
      }

      // 展开为 房间 × 时段
      let count = 0;
      checkedRooms.forEach(roomId => {
        slots.forEach(slot => {
          const [sh, sm] = slot.start.split(':').map(Number);
          const [eh, em] = slot.end.split(':').map(Number);
          const duration = (eh * 60 + em) - (sh * 60 + sm);
          CONFIG.bookings.push({ roomId, startTime: slot.start, durationMinutes: duration });
          count++;
        });
      });
      saveConfig();
      host.innerHTML = '';
      renderTasksPane();
      updateUI();
      const slotDesc = slots.map(s => `${s.start}~${s.end}`).join(', ');
      log(`✅ 添加 ${count} 个任务 (${checkedRooms.length} 房间 × ${slots.length} 时段: ${slotDesc})`, 'success');
    };
  }

  /* ═══════════════════════════════════════════════════════════
     🏢  房间 Tab
     ═══════════════════════════════════════════════════════════ */
  function renderRoomsPane() {
    const pane = document.getElementById('pane-rooms');
    if (!pane) return;

    let html = '';
    if (!CONFIG.rooms.length) {
      html += '<div class="empty">还没有保存的会议室</div>';
    } else {
      html += '<div class="rooms-grid">';
      CONFIG.rooms.forEach((r, i) => {
        html += `
          <div class="room-cell" title="${escapeHtml(r.name)} · ${r.roomId}">
            <span class="rn">🏢 <b>${escapeHtml(r.name)}</b></span>
            <span class="x" data-action="del-room" data-idx="${i}" title="删除">×</span>
          </div>`;
      });
      html += '</div>';
    }
    html += '<button class="add-btn" id="add-room-btn">+ 添加会议室</button>';

    // 计算还没导入的预设房间数
    const missingPresets = DEFAULTS.rooms.filter(p =>
      !CONFIG.rooms.some(r => r.roomId === p.roomId)
    );
    if (missingPresets.length > 0) {
      html += `<button class="add-btn" id="import-preset-btn" style="border-style:solid;color:#1976d2;border-color:#90caf9">📦 一键导入预设 (${missingPresets.length} 个常用 D 区房间)</button>`;
    }

    html += '<div id="room-form-host"></div>';
    html += `<div class="help">💡 默认已内置 10 个常用 D 区会议室。<br>
      要的房间不在列表里? 手动添加 (roomId 可问其他同事或抓包获取)。</div>`;
    pane.innerHTML = html;

    pane.querySelectorAll('[data-action=del-room]').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.dataset.idx);
        const room = CONFIG.rooms[idx];
        const usedBy = CONFIG.bookings.filter(b => b.roomId === room.roomId).length;
        let confirmMsg = `确认删除会议室 "${room.name}"?`;
        if (usedBy > 0) confirmMsg += `\n⚠️ 有 ${usedBy} 个任务在使用此房间,会一起删除。`;
        if (confirm(confirmMsg)) {
          CONFIG.bookings = CONFIG.bookings.filter(b => b.roomId !== room.roomId);
          CONFIG.rooms.splice(idx, 1);
          saveConfig();
          renderRoomsPane();
          renderTasksPane();
          updateUI();
        }
      };
    });
    document.getElementById('add-room-btn').onclick = showAddRoomForm;

    const importBtn = document.getElementById('import-preset-btn');
    if (importBtn) {
      importBtn.onclick = () => {
        let added = 0;
        DEFAULTS.rooms.forEach(p => {
          if (!CONFIG.rooms.some(r => r.roomId === p.roomId)) {
            CONFIG.rooms.push({ name: p.name, roomId: p.roomId });
            added++;
          }
        });
        saveConfig();
        renderRoomsPane();
        log(`✅ 已导入 ${added} 个预设房间`, 'success');
      };
    }
  }

  function showAddRoomForm() {
    const host = document.getElementById('room-form-host');
    if (!host) return;
    host.innerHTML = `
      <div class="form">
        <div class="form-row">
          <label>名称</label>
          <input type="text" id="room-name" placeholder="例: D45R 大会议室" maxlength="40">
        </div>
        <div class="form-row">
          <label>roomId</label>
          <input type="text" id="room-id" placeholder="一长串数字,从抓包获取" maxlength="40">
        </div>
        <div class="form-buttons">
          <button id="room-save" class="save">保存</button>
          <button id="room-cancel">取消</button>
        </div>
        <div class="warn-text" id="room-warn" style="display:none"></div>
      </div>`;
    document.getElementById('room-cancel').onclick = () => { host.innerHTML = ''; };
    document.getElementById('room-save').onclick = () => {
      const name = document.getElementById('room-name').value.trim();
      const roomId = document.getElementById('room-id').value.trim();
      const warn = document.getElementById('room-warn');
      if (!name) { warn.style.display = 'block'; warn.textContent = '⚠️ 请输入房间名'; return; }
      if (!roomId.match(/^\d+$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ roomId 应该是一长串数字'; return; }
      if (CONFIG.rooms.some(r => r.roomId === roomId)) { warn.style.display = 'block'; warn.textContent = '⚠️ 这个 roomId 已存在'; return; }
      CONFIG.rooms.push({ name, roomId });
      saveConfig();
      host.innerHTML = '';
      renderRoomsPane();
      log(`✅ 添加会议室: ${name}`, 'success');
    };
  }

  /* ═══════════════════════════════════════════════════════════
     ⚙️  设置 Tab
     ═══════════════════════════════════════════════════════════ */
  function renderSettingsPane() {
    const pane = document.getElementById('pane-set');
    if (!pane) return;
    pane.innerHTML = `
      <div class="form-row">
        <label>主题</label>
        <input type="text" id="set-subject" value="${escapeHtml(CONFIG.meeting.subject)}" maxlength="40">
      </div>
      <div class="form-row">
        <label>开抢时刻</label>
        <input type="text" id="set-open" value="${CONFIG.timing.bookingOpenTime}" placeholder="HH:MM:SS">
      </div>
      <div class="form-row">
        <label>提前天数</label>
        <input type="number" id="set-days" value="${(() => {
          // 智能反推: 若已存目标日期, 显示"目标日期 - 今天"的天数
          const td = parseTargetDate(CONFIG.timing.targetDate);
          if (td) {
            const today0 = new Date(); today0.setHours(0, 0, 0, 0);
            const diff = Math.round((td.getTime() - today0.getTime()) / 86400000);
            if (diff >= 0 && diff <= 14) return diff;
          }
          return CONFIG.timing.daysAhead;
        })()}" min="0" max="14">
        <span style="font-size:11px;color:#666">≤7 滚动 · &gt;7 自动转固定日期</span>
      </div>
      <div class="form-row" style="background:rgba(0,113,227,0.06);padding:6px 10px;border-radius:8px">
        <label style="color:#0071e3">实际预订</label>
        <span style="font-weight:600;color:#0071e3" id="set-effective-date">${formatBookingDate()}</span>
      </div>
      <div class="form-row">
        <label>提前ms</label>
        <input type="number" id="set-pretrig" value="${CONFIG.timing.preTriggerMs}" min="0" max="60000" step="100">
        <span style="font-size:11px;color:#666">8:30 前 N 毫秒</span>
      </div>
      <div class="form-row">
        <label>持续</label>
        <input type="number" id="set-maxdur" value="${CONFIG.timing.maxAttemptDurationSec}" min="10" max="300" step="10">
        <span style="font-size:11px;color:#666">秒,最长重试时长</span>
      </div>
      <div class="form-row">
        <label>并发</label>
        <input type="number" id="set-conc" value="${CONFIG.advanced.concurrency}" min="1" max="10" step="1">
        <span style="font-size:11px;color:#666">建议 3-4</span>
      </div>
      <div class="form-buttons" style="margin-top:8px">
        <button id="set-save" class="save">保存设置</button>
        <button id="set-export">导出配置</button>
        <button id="set-import">导入配置</button>
      </div>
      <div class="form-buttons">
        <button id="set-reset" style="color:#c62828">恢复默认</button>
      </div>
      <div class="warn-text" id="set-warn" style="display:none"></div>
      <div class="help">💡 服务器限流:令牌桶 ~4 令牌 / 4 令牌/秒。"提前ms"小则不浪费令牌,但要够大兜住时钟漂移。<br>
      <b>实战推荐:提前 ms = 50~150</b>(实战 8:30 数据:300ms 浪费 3 个令牌、丢失关键 400ms 抢订窗口)。<br>
      <b>📅 提前天数</b>:≤7 = 滚动模式(每天抢 N 天后);&gt;7 = 固定日期模式(锁定特定那天,自动选合适执行日)。
      </div>`;

    // 实时刷新"实际预订"显示
    const refreshEffective = () => {
      const days = parseInt(document.getElementById('set-days').value, 10) || 0;
      const oldDays = CONFIG.timing.daysAhead;
      const oldTarget = CONFIG.timing.targetDate;
      // 临时计算
      if (days > 7) {
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        const t = new Date(today0);
        t.setDate(t.getDate() + days);
        const yy = t.getFullYear();
        const mo = String(t.getMonth() + 1).padStart(2, '0');
        const dd = String(t.getDate()).padStart(2, '0');
        CONFIG.timing.targetDate = `${yy}-${mo}-${dd}`;
        CONFIG.timing.daysAhead = 7;
      } else {
        CONFIG.timing.targetDate = null;
        CONFIG.timing.daysAhead = days;
      }
      const el = document.getElementById('set-effective-date');
      if (el) el.textContent = formatBookingDate();
      // 还原, 真正的保存才落盘
      CONFIG.timing.daysAhead = oldDays;
      CONFIG.timing.targetDate = oldTarget;
    };
    document.getElementById('set-days').oninput = refreshEffective;

    document.getElementById('set-save').onclick = () => {
      const subject = document.getElementById('set-subject').value.trim();
      const open = document.getElementById('set-open').value.trim();
      const days = parseInt(document.getElementById('set-days').value, 10);
      const pretrig = parseInt(document.getElementById('set-pretrig').value, 10);
      const maxdur = parseInt(document.getElementById('set-maxdur').value, 10);
      const conc = parseInt(document.getElementById('set-conc').value, 10);
      const warn = document.getElementById('set-warn');
      if (!subject) { warn.style.display = 'block'; warn.textContent = '⚠️ 主题不能为空'; return; }
      if (!open.match(/^\d{2}:\d{2}:\d{2}$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ 开抢时刻格式应为 HH:MM:SS'; return; }
      if (isNaN(days) || days < 0 || days > 14) { warn.style.display = 'block'; warn.textContent = '⚠️ 提前天数必须在 0~14 之间'; return; }
      if (isNaN(pretrig) || pretrig < 0 || pretrig > 60000) { warn.style.display = 'block'; warn.textContent = '⚠️ 提前ms应在 0~60000 之间'; return; }
      if (isNaN(maxdur) || maxdur < 10) { warn.style.display = 'block'; warn.textContent = '⚠️ 持续时长太短'; return; }
      if (isNaN(conc) || conc < 1 || conc > 10) { warn.style.display = 'block'; warn.textContent = '⚠️ 并发数应在 1~10 之间'; return; }

      // 简化模型: daysAhead 单一驱动
      // ≤7 = 滚动模式 (清空 targetDate)
      // >7 = 固定日期模式 (自动算 targetDate, daysAhead 重置为 7)
      let finalTargetDate = null;
      let finalDaysAhead = days;
      let autoConvertNote = '';
      if (days > 7) {
        const today0 = new Date(); today0.setHours(0, 0, 0, 0);
        const tDay = new Date(today0);
        tDay.setDate(tDay.getDate() + days);
        const yy = tDay.getFullYear();
        const mo = String(tDay.getMonth() + 1).padStart(2, '0');
        const dd = String(tDay.getDate()).padStart(2, '0');
        finalTargetDate = `${yy}-${mo}-${dd}`;
        finalDaysAhead = 7;
        // 触发日 = targetDate - 7 天
        const fireDay = new Date(tDay);
        fireDay.setDate(fireDay.getDate() - 7);
        const fireDayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][fireDay.getDay()];
        const targetDayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][tDay.getDay()];
        autoConvertNote = ` (锁定 ${finalTargetDate} ${targetDayName}, 将于 ${fireDay.getMonth() + 1}月${fireDay.getDate()}日 ${fireDayName} 8:30 触发)`;
      }

      CONFIG.meeting.subject = subject;
      CONFIG.timing.bookingOpenTime = open;
      CONFIG.timing.daysAhead = finalDaysAhead;
      CONFIG.timing.targetDate = finalTargetDate;
      CONFIG.timing.preTriggerMs = pretrig;
      CONFIG.timing.maxAttemptDurationSec = maxdur;
      CONFIG.advanced.concurrency = conc;
      saveConfig();
      log(`✅ 设置已保存${autoConvertNote}`, 'success');
      updateUI();
    };

    document.getElementById('set-export').onclick = () => {
      const text = JSON.stringify(CONFIG, null, 2);
      navigator.clipboard.writeText(text).then(() => {
        log('📋 配置已复制到剪贴板', 'success');
        alert('✅ 配置已复制到剪贴板\n\n你可以把它粘贴给同事,他们用[导入配置]即可一键加载');
      }).catch(() => {
        prompt('请手动复制下面的配置:', text);
      });
    };

    document.getElementById('set-import').onclick = () => {
      const text = prompt('请粘贴配置 JSON:');
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (!parsed.timing || !parsed.meeting || !parsed.rooms || !parsed.bookings) {
          throw new Error('配置格式不正确');
        }
        if (confirm(`将导入 ${parsed.rooms.length} 个房间和 ${parsed.bookings.length} 个任务,会覆盖现有配置。继续?`)) {
          CONFIG = Object.assign({}, deepClone(DEFAULTS), parsed);
          saveConfig();
          renderTasksPane();
          renderRoomsPane();
          renderSettingsPane();
          log('✅ 配置已导入', 'success');
        }
      } catch (e) {
        alert('❌ 导入失败: ' + e.message);
      }
    };

    document.getElementById('set-reset').onclick = () => {
      if (confirm('确认恢复默认?当前所有配置 (房间、任务) 都会丢失。')) {
        CONFIG = deepClone(DEFAULTS);
        saveConfig();
        renderTasksPane();
        renderRoomsPane();
        renderSettingsPane();
        log('🔄 已恢复默认配置', 'info');
      }
    };
  }

  /* ═══════════════════════════════════════════════════════════
     🎨  状态/UI 更新
     ═══════════════════════════════════════════════════════════ */
  let statusLockUntil = 0;

  function setStatus(cls, text, autoRevertSec) {
    const st = document.getElementById('st');
    if (st) {
      st.className = 'st ' + cls;
      st.textContent = text;
    }
    if (autoRevertSec && autoRevertSec > 0) {
      statusLockUntil = Date.now() + autoRevertSec * 1000;
    } else {
      statusLockUntil = 0;
    }
  }

  function updateUI() {
    const cd = document.getElementById('cd');
    const sync = document.getElementById('sync');
    const info = document.getElementById('info');
    if (!cd) return;

    const user = getUserAccount();
    const userName = getUserDisplayName();

    // ── 状态栏(自动诊断,在临时锁定期内不覆盖)──
    if (Date.now() >= statusLockUntil) {
      const diagnosis = diagnoseHealth();
      if (diagnosis.level === 'error') {
        setStatus('error', diagnosis.text);
      } else if (scheduledLocalTime) {
        setStatus('armed', '🟢 已就绪 · 等待开抢');
      } else if (diagnosis.level === 'warn') {
        setStatus('warn', diagnosis.text);
      } else {
        setStatus('idle', diagnosis.text);
      }
    }

    info.innerHTML = `
      用户: <b>${user || '?'}${userName ? ' (' + escapeHtml(userName) + ')' : ''}</b>
      &nbsp;·&nbsp; 任务: <b>${CONFIG.bookings.length}</b>
      &nbsp;·&nbsp; 房间: <b>${CONFIG.rooms.length}</b><br>
      预订日期: <b>${formatBookingDate()}</b>`;

    if (scheduledLocalTime) {
      const remain = Math.max(0, scheduledLocalTime - Date.now());
      const totalSec = Math.floor(remain / 1000);
      const days = Math.floor(totalSec / 86400);
      const h = Math.floor((totalSec % 86400) / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      cd.textContent = days > 0 ? `${days} 天 ${hms}` : hms;
    } else {
      const sn = new Date(getServerNow());
      cd.textContent = sn.toLocaleTimeString('zh-CN', { hour12: false });
    }

    if (syncQuality === 'PRECISE') {
      sync.className = 'sync precise';
      const sign = serverOffsetMs >= 0 ? '慢' : '快';
      sync.textContent = `🕐 精确对时 · 本地${sign} ${Math.abs(serverOffsetMs)}ms`;
    } else if (syncQuality === 'COARSE') {
      sync.className = 'sync coarse';
      sync.textContent = `🕐 粗对时 (±500ms)`;
    } else {
      sync.className = 'sync none';
      sync.textContent = `🕐 对时中... 或点[手动对时]`;
    }
  }

  // 健康诊断:返回 { level: 'ok'|'warn'|'error', text: '...' }
  function diagnoseHealth() {
    if (!authToken || !getXSRFToken()) {
      return { level: 'error', text: '⚠️ Token 未捕获 · 请点击网页任意按钮' };
    }
    if (!CONFIG.bookings.length) {
      return { level: 'warn', text: '⏸ 暂无任务 · 请到[任务] Tab 添加' };
    }
    // 校验每个任务
    for (let i = 0; i < CONFIG.bookings.length; i++) {
      const b = CONFIG.bookings[i];
      if (!CONFIG.rooms.some(r => r.roomId === b.roomId)) {
        return { level: 'error', text: `⚠️ 任务 #${i + 1} 引用的房间已删除` };
      }
      if (b.durationMinutes > 240) {
        return { level: 'error', text: `⚠️ 任务 #${i + 1} 时长超过 4 小时上限` };
      }
      if (b.durationMinutes < 30 || b.durationMinutes % 30 !== 0) {
        return { level: 'error', text: `⚠️ 任务 #${i + 1} 时长 ${b.durationMinutes}min 不是 30 分钟整数倍` };
      }
    }
    if (CONFIG.timing.daysAhead > 7) {
      return { level: 'warn', text: `⚠️ 提前天数 ${CONFIG.timing.daysAhead} > 7,系统会拒绝。请改为 ≤7` };
    }
    // 固定日期模式: 信任智能调度 (会自动选 targetDate-7 天的 8:30 触发)
    // 仅校验日期是否过期或太远
    const target = parseTargetDate(CONFIG.timing.targetDate);
    if (target) {
      const today0 = new Date(); today0.setHours(0, 0, 0, 0);
      const diffDays = Math.round((target.getTime() - today0.getTime()) / 86400000);
      if (diffDays < 0) {
        return { level: 'error', text: `⚠️ 目标日期已过期, 请重新设置` };
      }
      if (diffDays > 14) {
        return { level: 'warn', text: `⚠️ 目标日期距今 ${diffDays} 天 > 14, 太远` };
      }
      // 正常: 智能调度会选合适的触发日, 无需警告
    }
    if (syncQuality === 'NONE') {
      return { level: 'warn', text: `⏳ 等待服务器对时...` };
    }
    return { level: 'ok', text: `✅ 就绪 · ${CONFIG.bookings.length} 任务 / ${CONFIG.rooms.length} 房间` };
  }

  setInterval(updateUI, 250);

  /* ═══════════════════════════════════════════════════════════
     📝  日志
     ═══════════════════════════════════════════════════════════ */
  function formatTimeWithMs(d) {
    d = d || new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function log(msg, type) {
    type = type || 'info';
    const time = formatTimeWithMs();
    console.log(`[抢订 ${time}] ${msg}`);
    const logEl = document.getElementById('log');
    if (logEl) {
      const entry = document.createElement('div');
      entry.className = `l-${type}`;
      entry.textContent = `${time} ${msg}`;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
      while (logEl.children.length > 500) logEl.removeChild(logEl.firstChild);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  /* ═══════════════════════════════════════════════════════════
     🚀  启动
     ═══════════════════════════════════════════════════════════ */
  function init() {
    if (!document.body) {
      setTimeout(init, 100);
      return;
    }
    buildUI();
    log('✅ 会议室自动抢订 v0.14.0 已加载');
    log(`📋 已配置 ${CONFIG.bookings.length} 个任务 / ${CONFIG.rooms.length} 个房间`);

    setTimeout(() => {
      const user = getUserAccount();
      if (user) {
        log(`👤 当前用户: ${user}${getUserDisplayName() ? ' (' + getUserDisplayName() + ')' : ''}`, 'success');
      } else {
        log('⚠️ 未捕获到 Token,请点击网页任意按钮 (如刷新房间列表)', 'warn');
      }
      syncServerTimePrecise();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
