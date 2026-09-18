// service worker：代 content script 调 TypeSafe API（content script 受页面 CORS 限制）
// 每条推文两个 Noul 问题：是否色情 / 是否恶意，任一超阈值由内容侧决定屏蔽

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

const PORN_QUESTION = {
  type: "noul",
  instructions:
    "综合判断 `tweets[{i}].author`（作者昵称）和 `tweets[{i}].text`（正文）共同构成的这条推特回复是否包含色情引流。命中特征包括：昵称或正文中的上门/线下服务暗示（“同城上门”“线下选妃”“约会”“特殊服务”）、色情资源售卖暗号（“福利”“资源”“不黑”“可信”）、招嫖联系方式（加V/飞机/TG）、直接描写性行为或露骨性暗示挑逗。文本语言不限。不含：正常话题中出现的性相关科普、新闻、医学讨论。",
  criteria: {
    true: "昵称或正文包含上述任一色情引流特征",
    false: "不包含，或仅是正常的性相关话题讨论",
  },
};

const MALICIOUS_QUESTION = {
  type: "noul",
  instructions:
    "综合判断 `tweets[{i}].author`（作者昵称）和 `tweets[{i}].text`（正文）共同构成的这条推特回复是否包含恶意内容：辱骂或人身攻击、仇恨言论、骚扰搭讪、人肉开盒、诈骗/钓鱼链接、垃圾广告刷屏引流（含蹭热度的推广回复）。文本语言不限。不含：针对观点的尖锐批评、玩笑玩梗。",
  criteria: {
    true: "包含上述任一恶意特征",
    false: "不包含，或仅是尖锐但针对观点的批评",
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "JUDGE") {
    judge(msg.items)
      .then((verdicts) => sendResponse({ ok: true, verdicts }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message ?? err) }));
    return true; // 异步响应
  }
});

// 图标徽章显示累计屏蔽数
chrome.storage.onChanged.addListener((changes) => {
  if (changes.blockedCount) {
    const n = changes.blockedCount.newValue ?? 0;
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  }
});

async function judge(items) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("未设置 API key，请点插件图标配置");

  const questions = {};
  items.forEach((item, idx) => {
    // replaceAll：模板里 {i} 出现两次（author/text 两处引用），replace 只换第一个会留死占位符
    questions[`p${idx}`] = { ...PORN_QUESTION, instructions: PORN_QUESTION.instructions.replaceAll("{i}", String(idx)) };
    questions[`m${idx}`] = { ...MALICIOUS_QUESTION, instructions: MALICIOUS_QUESTION.instructions.replaceAll("{i}", String(idx)) };
  });

  const res = await postWithRetry(
    {
      state: {
        platform: "twitter",
        tweets: items.map((it) => ({ author: it.author ?? "", text: it.text })),
      },
      model: MODEL,
      questions,
    },
    apiKey,
  );

  return items.map((_it, idx) => ({
    porn: res.answers[`p${idx}`].noul,
    malicious: res.answers[`m${idx}`].noul,
  }));
}

async function postWithRetry(body, apiKey, maxRetries = 2) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      // 挂起保护：20s 无响应按失败处理，否则 SW 可能被回收且毫无痕迹
      res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (attempt === maxRetries) throw new Error(`网络错误/超时：${e.message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status === 529) {
      if (attempt === maxRetries) throw new Error(`TypeSafe API 过载（${res.status}）`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
