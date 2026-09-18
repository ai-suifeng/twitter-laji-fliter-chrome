// 常驻 content script：监听推特回复流，实时判断并屏蔽色情/恶意评论。
// 只处理推文详情页（/status/，即评论区）；第一条 article 是主推文，跳过。

const POLICY = {
  pornThreshold: 0.5,
  maliciousThreshold: 0.6,
  batchWindowMs: 400,
  batchSize: 8,
  cacheMax: 2000,
};

let enabled = true;
let keyMissing = false; // SW 报告缺 key 后暂停判断，配置后自动恢复
const cache = new Map(); // textHash -> { porn, malicious }
const pending = new Map(); // domId -> { el, text }
let flushTimer = null;
let uid = 0;

init();

async function init() {
  const s = await chrome.storage.local.get(["enabled"]);
  enabled = s.enabled !== false; // 默认开启（有 key 才会真正判断）

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      keyMissing = false;
      if (enabled) scan();
    }
    if (changes.apiKey) {
      keyMissing = false;
      if (enabled) scan();
    }
  });

  // SPA：DOM 变化防抖扫描 + 定时兜底（React 虚拟列表回收节点后会重新出现）
  let scanTimer = null;
  observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  intervalId = setInterval(scan, 2500);
  scan();
}

let intervalId = null;
let observer = null;

function scan() {
  if (!enabled || keyMissing || !location.pathname.includes("/status/")) return;

  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  articles.forEach((article, idx) => {
    if (idx === 0) return; // 主推文
    if (article.dataset.jevRevealed === "1") return; // 用户手动查看过，不再屏蔽

    const state = article.dataset.jevState;
    if (state === "blocked") {
      ensureHidden(article); // React 重渲染后补挂占位
      return;
    }
    if (state) return; // judging / clean 已处理

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = stripInvisible(normWs(textEl?.innerText ?? ""));
    if (!text) return;
    // 色情/引流信号常藏在昵称里（"同城上门""线下选妃"），必须一起送判断
    const author = stripInvisible(extractAuthor(article));

    const hit = cache.get(hash(author, text));
    if (hit) {
      applyVerdict(article, hit);
      return;
    }
    article.dataset.jevState = "judging";
    const id = ++uid;
    article.dataset.jevId = String(id);
    pending.set(id, { article, text, author });
    scheduleFlush();
  });
}

/** User-Name 容器含 昵称/Handle/时间/认证标记，取首行为昵称 */
function extractAuthor(article) {
  const nameEl = article.querySelector('[data-testid="User-Name"]');
  return normWs(nameEl?.innerText?.split("\n")[0] ?? "");
}

/**
 * 剥离隐形 Unicode 字符（零宽连接符/软换行/双向标记等）。
 * 垃圾评论用它绕过审核，同时把中文切碎导致模型读不出黑话（"我‌‍福‍‌不‌‍黑"）。
 * 确定性清洗属于代码职责，不该交给模型硬猜。
 */
function stripInvisible(s) {
  return s.replace(/[\u200B-\u200F\u2060-\u2065\uFEFF\u00AD\u180E]/g, "");
}

/** 内容侧攒批：一个滚动窗口内的回复合并成一次 API 请求 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, POLICY.batchWindowMs);
}

async function flush() {
  flushTimer = null;
  if (!enabled || pending.size === 0) return;
  const batch = [...pending.entries()].slice(0, POLICY.batchSize);
  batch.forEach(([id]) => pending.delete(id));
  if (pending.size > 0) scheduleFlush(); // 还有剩余，继续下一批

  const items = batch.map(([, v]) => ({ author: v.author, text: v.text }));
  let verdicts = null;
  try {
    // SW 可能休眠/被回收导致消息无响应：30s 兜底，超时按失败处理并重试
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: "JUDGE", items }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("background 无响应（可能已休眠），稍后重试")), 30000),
      ),
    ]);
    if (!res?.ok) throw new Error(res?.error ?? "判断失败");
    verdicts = res.verdicts;
  } catch (err) {
    const m = String(err.message ?? err);
    // 插件在 chrome://extensions 重载后，本页旧脚本成为孤儿，所有消息必然失败：
    // 停止扫描并提示刷新，避免无声空转（这就是"必须刷新才生效"的来源）
    if (/Extension context invalidated|Receiving end does not exist/.test(m)) {
      if (intervalId) clearInterval(intervalId);
      observer?.disconnect();
      console.warn("[评论净化] 插件已重新加载，请刷新本页以恢复屏蔽功能");
      return;
    }
    // 失败按未命中处理，下轮滚动缓存未写入会重试；缺 key 则挂起等配置
    batch.forEach(([, v]) => (v.article.dataset.jevState = ""));
    if (/API key/.test(m)) keyMissing = true;
    console.warn("[评论净化] 判断失败：", m);
    return;
  }

  batch.forEach(([id, v], i) => {
    const verdict = verdicts[i] ?? { porn: 0, malicious: 0 };
    if (cache.size >= POLICY.cacheMax) cache.delete(cache.keys().next().value);
    cache.set(hash(v.author, v.text), verdict);
    applyVerdict(v.article, verdict);
  });
}

function applyVerdict(article, v) {
  const reason =
    v.porn >= POLICY.pornThreshold
      ? "疑似色情"
      : v.malicious >= POLICY.maliciousThreshold
        ? "疑似恶意"
        : null;
  if (!reason) {
    article.dataset.jevState = "clean";
    return;
  }
  article.dataset.jevState = "blocked";
  hide(article, reason, v);
  bumpBlockedCount();
}

function hide(article, reason, v) {
  if (article.previousSibling?.classList?.contains("jev-shield-placeholder")) return;
  const ph = document.createElement("div");
  ph.className = "jev-shield-placeholder";
  ph.textContent = `🚫 已屏蔽 ${reason}（色情 ${Math.round(v.porn * 100)}% / 恶意 ${Math.round(v.malicious * 100)}%）· 点击查看`;
  Object.assign(ph.style, {
    padding: "12px 16px",
    margin: "8px 0",
    borderRadius: "12px",
    border: "1px dashed rgba(128,128,128,.6)",
    color: "rgba(128,128,128,.9)",
    fontSize: "14px",
    cursor: "pointer",
    background: "rgba(128,128,128,.06)",
  });
  ph.onclick = () => {
    article.dataset.jevRevealed = "1";
    article.style.display = "";
    ph.remove();
  };
  article.style.display = "none";
  article.parentNode?.insertBefore(ph, article);
}

/** React 重渲染会丢掉占位节点，扫描时补挂 */
function ensureHidden(article) {
  if (!article.previousSibling?.classList?.contains("jev-shield-placeholder")) {
    const text = stripInvisible(normWs(article.querySelector('[data-testid="tweetText"]')?.innerText ?? ""));
    const v = cache.get(hash(stripInvisible(extractAuthor(article)), text));
    if (v) hide(article, v.porn >= POLICY.pornThreshold ? "疑似色情" : "疑似恶意", v);
  }
}

async function bumpBlockedCount() {
  const { blockedCount = 0 } = await chrome.storage.local.get("blockedCount");
  chrome.storage.local.set({ blockedCount: blockedCount + 1 });
}

function hash(author, text) {
  const s = author + "\u0001" + text; // 作者不同则判决不同
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${h}_${s.length}`;
}

const normWs = (s) => s.replace(/\s+/g, " ").trim();
