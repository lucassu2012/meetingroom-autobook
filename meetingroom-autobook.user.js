// ==UserScript==
// @name         会议室自动抢订
// @namespace    meetingroom-autobook
// @version      0.3.0
// @description  在系统开放预订时刻自动并发抢订会议室。GUI 配置 / 精确服务器对时 / 自动诊断 / 内置常用会议室。
// @author       Lucas
// @match        https://inner.welink.huawei.com/meetingroom/*
// @grant        none
// @run-at       document-start
// 把下面两行的 URL 替换成实际托管地址(以 .user.js 结尾),粘贴时去掉前面的 //
// @updateURL    https://github.com/lucassu2012/meetingroom-autobook/blob/main/meetingroom-autobook.user.js
// @downloadURL  https://github.com/lucassu2012/meetingroom-autobook/blob/main/meetingroom-autobook.user.js
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
      daysAhead: 7,
      triggerOffsetMs: -100,
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
      retryAttempts: 3,
      retryIntervalMs: 100,
    },
  };

  let CONFIG = loadConfig();

  function loadConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const cfg = Object.assign({}, deepClone(DEFAULTS), parsed);
        // v0.2 → v0.3 迁移: 重命名旧的 "D45R 示例" 为 "D45R"
        if (cfg.rooms) {
          cfg.rooms.forEach(r => {
            if (r.name === 'D45R 示例') r.name = 'D45R';
          });
        }
        return cfg;
      }
    } catch (e) { /* fall through */ }
    return deepClone(DEFAULTS);
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
  function computeBookingStartTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const t = new Date();
    t.setDate(t.getDate() + CONFIG.timing.daysAhead);
    t.setHours(h, m, 0, 0);
    return Math.floor(t.getTime() / 1000);
  }

  function formatBookingDate() {
    const t = new Date();
    t.setDate(t.getDate() + CONFIG.timing.daysAhead);
    const w = ['日', '一', '二', '三', '四', '五', '六'][t.getDay()];
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} 周${w}`;
  }

  function computeNextTriggerLocalTime() {
    const [h, m, s] = CONFIG.timing.bookingOpenTime.split(':').map(Number);
    const serverNow = new Date(getServerNow());
    const target = new Date(serverNow);
    target.setHours(h, m, s, 0);
    if (target.getTime() <= serverNow.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - serverOffsetMs + CONFIG.timing.triggerOffsetMs;
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
    if (httpStatus === 401) return { type: 'AUTH', tip: '🔒 Token 已过期 - 请刷新页面重新登录', retry: false };
    if (httpStatus === 403) return { type: 'PERMISSION', tip: '🚫 权限不足', retry: false };
    if (httpStatus === 409) return { type: 'CONFLICT', tip: '🔴 时间段冲突 - 已被他人占用', retry: false };
    if (httpStatus === 429) return { type: 'RATE_LIMIT', tip: '⏱ 请求过于频繁', retry: true };
    if (httpStatus >= 500) return { type: 'SERVER_ERROR', tip: '🔥 服务器异常', retry: true };

    const msgStr = ((data && (data.message || data.msg || data.error)) || '').toString();
    const m = msgStr.toLowerCase();
    if (m.includes('已') && (m.includes('占') || m.includes('被预') || m.includes('冲突'))) {
      return { type: 'CONFLICT', tip: `🔴 时间段已被占用 - "${msgStr}"`, retry: false };
    }
    if (m.includes('开放') || m.includes('未到')) {
      return { type: 'NOT_OPEN', tip: `⏳ 未到预订开放时刻 - "${msgStr}"`, retry: true };
    }
    if (m.includes('范围') || m.includes('提前') || m.includes('超出')) {
      return { type: 'OUT_OF_RANGE', tip: `📅 超出可预订日期范围 - "${msgStr}"`, retry: false };
    }
    if (m.includes('重复')) {
      return { type: 'DUPLICATE', tip: `🔁 重复预订 - "${msgStr}"`, retry: false };
    }
    if (m.includes('不存在') || m.includes('找不到')) {
      return { type: 'NOT_FOUND', tip: `❓ 房间不存在 - "${msgStr}"`, retry: false };
    }
    return { type: 'OTHER', tip: `⚠️ ${msgStr || '未知错误'}`, retry: true };
  }

  async function submitBooking(booking, label, attempt) {
    attempt = attempt || 1;
    if (!authToken) {
      log(`❌ ${label} 无 Token`, 'error');
      return { success: false, reason: 'no-token' };
    }
    const xsrfToken = getXSRFToken();
    if (!xsrfToken) {
      log(`❌ ${label} 无 XSRF`, 'error');
      return { success: false, reason: 'no-xsrf' };
    }

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
      const elapsed = (performance.now() - t0).toFixed(0);

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
        log(`✅ ${label} 抢订成功 (${elapsed}ms)`, 'success');
        if (data.id) log(`   订单号: ${data.id}`, 'debug');
        return { success: true, orderId: data.id };
      } else {
        const cat = categorizeError(resp.status, data);
        log(`⚠️ ${label} 失败#${attempt}: ${cat.tip}`, 'warn');
        if (data && Object.keys(data).length) {
          log(`   原始响应: ${JSON.stringify(data).slice(0, 200)}`, 'debug');
        }
        if (cat.retry && attempt < CONFIG.advanced.retryAttempts) {
          await sleep(CONFIG.advanced.retryIntervalMs);
          return submitBooking(booking, label, attempt + 1);
        }
        return { success: false, reason: cat.tip, type: cat.type };
      }
    } catch (err) {
      log(`💥 ${label} 网络异常#${attempt}: ${err.message}`, 'error');
      if (attempt < CONFIG.advanced.retryAttempts) {
        await sleep(CONFIG.advanced.retryIntervalMs);
        return submitBooking(booking, label, attempt + 1);
      }
      return { success: false, reason: err.message };
    }
  }

  async function executeAllBookings() {
    if (!CONFIG.bookings.length) {
      log('⚠️ 没有任何任务,请在 [任务] 标签页里添加', 'warn');
      return;
    }
    setStatus('firing', `🔴 抢订中... (${CONFIG.bookings.length} 个任务)`, 60);
    log(`🚀 开始并发抢订 ${CONFIG.bookings.length} 个任务...`);
    const t0 = performance.now();

    const promises = CONFIG.bookings.map((b, i) => {
      const room = CONFIG.rooms.find(r => r.roomId === b.roomId);
      const roomLabel = room ? room.name : b.roomId.slice(-6);
      const label = `[#${i + 1} ${roomLabel} ${b.startTime}+${b.durationMinutes}m]`;
      return submitBooking(b, label);
    });

    const results = await Promise.all(promises);
    const ok = results.filter(r => r.success).length;
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    if (ok === results.length) {
      log(`🎉 全部抢订成功 (${ok}/${results.length},耗时 ${elapsed}s)`, 'success');
      setStatus('done', `✅ 全部成功 ${ok}/${results.length}`, 60);
    } else if (ok > 0) {
      log(`⚠️ 部分成功 (${ok}/${results.length},耗时 ${elapsed}s)`, 'warn');
      setStatus('partial', `⚠️ 部分成功 ${ok}/${results.length}`, 60);
    } else {
      log(`❌ 全部失败 (耗时 ${elapsed}s)`, 'error');
      setStatus('error', `❌ 全部失败 0/${results.length}`, 30);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     ⏰  定时触发
     ═══════════════════════════════════════════════════════════ */
  let scheduledTimerId = null;
  let scheduledLocalTime = null;
  let preTriggerSyncTimerId = null;

  function scheduleAutoBook() {
    if (!CONFIG.bookings.length) {
      log('⚠️ 没有任务,先在[任务]标签页添加', 'warn');
      return;
    }
    cancelSchedule();

    syncServerTimePrecise().finally(() => {
      scheduledLocalTime = computeNextTriggerLocalTime();
      const waitMs = scheduledLocalTime - Date.now();
      log(`⏰ 已设定:服务器时间 ${CONFIG.timing.bookingOpenTime} 自动开抢`, 'info');
      log(`   ⏳ 还剩 ${(waitMs / 1000).toFixed(0)} 秒`, 'info');
      setStatus('armed', '🟢 已就绪 · 等待开抢');

      if (waitMs > 35000) {
        preTriggerSyncTimerId = setTimeout(() => {
          if (scheduledLocalTime) {
            log('🕐 抢订前 30 秒重新对时...', 'info');
            syncServerTimePrecise().finally(() => {
              scheduledLocalTime = computeNextTriggerLocalTime();
            });
          }
        }, waitMs - 30000);
      }

      scheduledTimerId = setTimeout(() => {
        busyWaitThenFire();
      }, Math.max(0, waitMs - 500));
    });
  }

  function busyWaitThenFire() {
    const tick = () => {
      if (!scheduledLocalTime) return;
      if (Date.now() >= scheduledLocalTime) {
        scheduledTimerId = null;
        scheduledLocalTime = null;
        executeAllBookings();
      } else {
        scheduledTimerId = setTimeout(tick, 1);
      }
    };
    tick();
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
      #mr-panel{position:fixed;bottom:20px;right:20px;width:400px;background:#fff;
        border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;
        z-index:99999;color:#333;line-height:1.5}
      #mr-panel *{box-sizing:border-box}
      #mr-panel .h{display:flex;justify-content:space-between;align-items:center;
        padding:10px 14px;border-bottom:1px solid #f0f0f0;cursor:move;user-select:none;background:#fafafa;border-radius:8px 8px 0 0}
      #mr-panel .tt{font-weight:500;font-size:13px}
      #mr-panel .tg{cursor:pointer;color:#999;font-size:18px;line-height:1;padding:0 4px}
      #mr-panel .tg:hover{color:#333}
      #mr-panel .body{padding:10px 14px}
      #mr-panel .body.col{display:none}
      #mr-panel .st{padding:6px 10px;background:#f5f5f5;border-radius:4px;font-size:11px;margin-bottom:8px;text-align:center}
      #mr-panel .st.armed{background:#e8f5e9;color:#2e7d32}
      #mr-panel .st.firing{background:#fff3e0;color:#e65100}
      #mr-panel .st.warn{background:#fff8e1;color:#f57f17}
      #mr-panel .st.idle{background:#e8f5e9;color:#2e7d32}
      #mr-panel .st.error{background:#ffebee;color:#c62828}
      #mr-panel .st.done{background:#e8f5e9;color:#2e7d32}
      #mr-panel .st.partial{background:#fff3e0;color:#e65100}
      #mr-panel .cd{font-family:Consolas,monospace;font-size:26px;text-align:center;
        margin:8px 0 2px;font-weight:500;letter-spacing:1px}
      #mr-panel .sync{font-size:10px;color:#999;text-align:center;margin-bottom:8px}
      #mr-panel .sync.precise{color:#2e7d32}
      #mr-panel .sync.coarse{color:#e65100}
      #mr-panel .sync.none{color:#c62828}
      #mr-panel .info{font-size:11px;color:#666;text-align:center;margin-bottom:8px;line-height:1.7}
      #mr-panel .btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:6px}
      #mr-panel .btns2{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}
      #mr-panel button,#mr-panel input[type=text],#mr-panel input[type=number],
      #mr-panel input[type=time],#mr-panel select{padding:5px 8px;font-size:11px;border:1px solid #d0d0d0;
        background:#fff;border-radius:4px;font-family:inherit;color:#333}
      #mr-panel button{cursor:pointer;transition:all .15s}
      #mr-panel button:hover{background:#f5f5f5;border-color:#999}
      #mr-panel button.pri{background:#1976d2;color:#fff;border-color:#1976d2}
      #mr-panel button.pri:hover{background:#1565c0}
      #mr-panel button.sec{color:#888}
      #mr-panel .tabs{display:flex;border-bottom:1px solid #e0e0e0;margin:0 -14px 8px}
      #mr-panel .tab{flex:1;padding:6px 4px;text-align:center;cursor:pointer;font-size:11px;
        border-bottom:2px solid transparent;color:#666;transition:all .15s}
      #mr-panel .tab.active{color:#1976d2;border-bottom-color:#1976d2;background:#f5f9ff}
      #mr-panel .tab:hover:not(.active){background:#fafafa}
      #mr-panel .pane{display:none;min-height:140px;max-height:240px;overflow-y:auto}
      #mr-panel .pane.active{display:block}
      #mr-panel .empty{text-align:center;color:#999;padding:20px 8px;font-size:11px}
      #mr-panel .item{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;
        border:1px solid #eee;border-radius:4px;margin-bottom:4px;background:#fafafa;font-size:11px}
      #mr-panel .item .left{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #mr-panel .item .x{color:#c62828;cursor:pointer;padding:0 6px;font-size:14px;line-height:1}
      #mr-panel .item .x:hover{background:#ffebee;border-radius:3px}
      #mr-panel .add-btn{width:100%;padding:6px;border:1px dashed #ccc;background:#fff;border-radius:4px;
        cursor:pointer;color:#666;font-size:11px;margin-bottom:6px}
      #mr-panel .add-btn:hover{background:#f5f5f5;border-color:#999}
      #mr-panel .form{background:#f9f9f9;border:1px solid #e0e0e0;padding:8px;border-radius:4px;margin-bottom:6px}
      #mr-panel .form-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
      #mr-panel .form-row label{font-size:11px;color:#666;min-width:50px;flex-shrink:0}
      #mr-panel .form-row input,#mr-panel .form-row select{flex:1}
      #mr-panel .preset-row{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}
      #mr-panel .preset-btn{padding:4px 8px;font-size:11px;background:#fff;border:1px solid #d0d0d0;
        border-radius:4px;cursor:pointer}
      #mr-panel .preset-btn:hover{background:#f5f5f5}
      #mr-panel .preset-btn.on{background:#1976d2;color:#fff;border-color:#1976d2}
      #mr-panel .form-buttons{display:flex;gap:6px;margin-top:6px}
      #mr-panel .form-buttons button{flex:1;padding:5px;font-size:11px}
      #mr-panel .form-buttons button.save{background:#1976d2;color:#fff;border-color:#1976d2}
      #mr-panel .checkbox-list{max-height:120px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:4px;background:#fff;padding:4px}
      #mr-panel .checkbox-list label{display:flex;align-items:center;padding:3px 6px;cursor:pointer;font-size:11px}
      #mr-panel .checkbox-list label:hover{background:#f5f5f5}
      #mr-panel .checkbox-list input{margin-right:6px}
      #mr-panel .ll{font-size:11px;color:#999;margin-bottom:4px;display:flex;justify-content:space-between}
      #mr-panel .clr{cursor:pointer}
      #mr-panel .clr:hover{color:#333}
      #mr-panel .log{background:#fafafa;border:1px solid #eee;border-radius:4px;padding:6px 8px;
        height:170px;overflow-y:auto;font-family:Consolas,monospace;font-size:11px;line-height:1.5}
      #mr-panel .log .l-info{color:#555}
      #mr-panel .log .l-debug{color:#888}
      #mr-panel .log .l-success{color:#2e7d32;font-weight:500}
      #mr-panel .log .l-warn{color:#e65100}
      #mr-panel .log .l-error{color:#c62828;font-weight:500}
      #mr-panel .help{font-size:10px;color:#999;line-height:1.6;padding:6px 0}
      #mr-panel .warn-text{color:#e65100;font-size:10px;margin-top:4px}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'mr-panel';
    panel.innerHTML = `
      <div class="h">
        <span class="tt">📅 会议室自动抢订 v0.3</span>
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
      CONFIG.bookings.forEach((b, i) => {
        const room = CONFIG.rooms.find(r => r.roomId === b.roomId);
        const roomLabel = room ? room.name : `<未知房间 ${b.roomId.slice(-6)}>`;
        const endTime = computeEndTime(b.startTime, b.durationMinutes);
        html += `
          <div class="item">
            <div class="left">📌 <b>${escapeHtml(roomLabel)}</b> · ${b.startTime}~${endTime} (${b.durationMinutes}min)</div>
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
        <div style="font-size:11px;color:#666;margin-bottom:4px">选择房间 (可多选,会自动展开为多个任务)</div>
        <div class="checkbox-list">${roomCheckboxes}</div>
        <div style="font-size:11px;color:#666;margin:8px 0 4px">时段</div>
        <div class="preset-row">
          <button class="preset-btn" data-preset="morning">上午 08:30~12:00</button>
          <button class="preset-btn" data-preset="afternoon">下午 14:00~18:00</button>
          <button class="preset-btn on" data-preset="custom">自定义</button>
        </div>
        <div class="form-row">
          <label>开始</label>
          <input type="time" id="task-start" value="08:30" step="600">
        </div>
        <div class="form-row">
          <label>时长</label>
          <input type="number" id="task-duration" value="210" min="15" max="240" step="15">
          <span style="font-size:11px;color:#666">分钟 (最大 240)</span>
        </div>
        <div class="form-buttons">
          <button id="task-save" class="save">保存</button>
          <button id="task-cancel">取消</button>
        </div>
        <div class="warn-text" id="task-warn" style="display:none"></div>
      </div>`;

    const presetBtns = host.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.onclick = () => {
        presetBtns.forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        if (btn.dataset.preset === 'morning') {
          document.getElementById('task-start').value = '08:30';
          document.getElementById('task-duration').value = '210';
        } else if (btn.dataset.preset === 'afternoon') {
          document.getElementById('task-start').value = '14:00';
          document.getElementById('task-duration').value = '240';
        }
      };
    });

    document.getElementById('task-cancel').onclick = () => { host.innerHTML = ''; };
    document.getElementById('task-save').onclick = () => {
      const checked = Array.from(host.querySelectorAll('input[name=task-room]:checked')).map(c => c.value);
      const startTime = document.getElementById('task-start').value;
      const duration = parseInt(document.getElementById('task-duration').value, 10);
      const warn = document.getElementById('task-warn');

      if (!checked.length) { warn.style.display = 'block'; warn.textContent = '⚠️ 至少选择一个房间'; return; }
      if (!startTime || !startTime.match(/^\d{2}:\d{2}$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ 开始时间格式错误'; return; }
      if (!duration || duration < 15 || duration > 240) { warn.style.display = 'block'; warn.textContent = '⚠️ 时长必须在 15~240 分钟之间'; return; }

      checked.forEach(roomId => {
        CONFIG.bookings.push({ roomId, startTime, durationMinutes: duration });
      });
      saveConfig();
      host.innerHTML = '';
      renderTasksPane();
      updateUI();
      log(`✅ 添加 ${checked.length} 个任务 (${startTime}, ${duration}min)`, 'success');
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
      CONFIG.rooms.forEach((r, i) => {
        html += `
          <div class="item">
            <div class="left">🏢 <b>${escapeHtml(r.name)}</b> <span style="color:#999">${r.roomId.slice(-6)}</span></div>
            <span class="x" data-action="del-room" data-idx="${i}" title="删除">×</span>
          </div>`;
      });
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
        <input type="number" id="set-days" value="${CONFIG.timing.daysAhead}" min="0" max="30">
      </div>
      <div class="form-row">
        <label>提前ms</label>
        <input type="number" id="set-offset" value="${CONFIG.timing.triggerOffsetMs}" step="10" max="0" min="-1000">
        <span style="font-size:11px;color:#666">负数=提前</span>
      </div>
      <div class="form-row">
        <label>重试</label>
        <input type="number" id="set-retry" value="${CONFIG.advanced.retryAttempts}" min="0" max="10">
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
      <div class="help">💡 配置自动保存到浏览器 localStorage。<br>导出配置可以分享给同事一键导入。</div>`;

    document.getElementById('set-save').onclick = () => {
      const subject = document.getElementById('set-subject').value.trim();
      const open = document.getElementById('set-open').value.trim();
      const days = parseInt(document.getElementById('set-days').value, 10);
      const off = parseInt(document.getElementById('set-offset').value, 10);
      const retry = parseInt(document.getElementById('set-retry').value, 10);
      const warn = document.getElementById('set-warn');
      if (!subject) { warn.style.display = 'block'; warn.textContent = '⚠️ 主题不能为空'; return; }
      if (!open.match(/^\d{2}:\d{2}:\d{2}$/)) { warn.style.display = 'block'; warn.textContent = '⚠️ 开抢时刻格式应为 HH:MM:SS'; return; }
      CONFIG.meeting.subject = subject;
      CONFIG.timing.bookingOpenTime = open;
      CONFIG.timing.daysAhead = days;
      CONFIG.timing.triggerOffsetMs = off;
      CONFIG.advanced.retryAttempts = retry;
      saveConfig();
      log('✅ 设置已保存', 'success');
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
      const h = Math.floor(remain / 3600000);
      const m = Math.floor((remain % 3600000) / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      cd.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
  function log(msg, type) {
    type = type || 'info';
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
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
    log('✅ 会议室自动抢订 v0.3.0 已加载');
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
