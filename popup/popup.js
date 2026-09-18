const $ = (id) => document.getElementById(id);

// 与 background.js 的 PROVIDERS 保持一致（改端点/模型名时两处同步）
const PROVIDERS = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", label: "TypeSafe 官方" },
  openrouter: { url: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-latest", label: "OpenRouter" },
};

init();

async function init() {
  const s = await chrome.storage.local.get(["apiKeys", "apiKey", "provider", "enabled", "blockedCount", "keyInvalid"]);
  // 每个服务商各自一把 key；旧版单 key 数据迁移到 typesafe 名下
  const apiKeys = s.apiKeys ?? (s.apiKey ? { typesafe: s.apiKey } : {});
  const providerId = s.provider ?? "typesafe";

  $("sel-provider").value = providerId;
  $("inp-key").value = apiKeys[providerId] ?? "";
  $("chk-enabled").checked = s.enabled !== false;
  $("blocked-count").textContent = s.blockedCount ?? 0;
  $("key-invalid").classList.toggle("hidden", !s.keyInvalid);

  $("btn-settings").onclick = () => {
    $("settings").classList.toggle("hidden");
    $("main").classList.toggle("hidden");
  };
  // 切换服务商：key 输入框跟着显示对应服务商已保存的 key
  $("sel-provider").onchange = () => {
    $("inp-key").value = apiKeys[$("sel-provider").value] ?? "";
    $("test-result").classList.add("hidden");
    $("test-result").textContent = "";
  };
  $("btn-save").onclick = saveSettings;
  $("btn-test").onclick = testConnection;
  $("chk-enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
}

async function saveSettings() {
  const providerId = $("sel-provider").value;
  const { apiKeys = {} } = await chrome.storage.local.get("apiKeys");
  apiKeys[providerId] = $("inp-key").value.trim();
  await chrome.storage.local.set({
    apiKeys,
    provider: providerId,
    keyInvalid: false, // 换 key 后清除 401 标记，判断自动恢复
  });
  $("btn-save").textContent = "已保存";
  $("key-invalid").classList.add("hidden");
  setTimeout(() => ($("btn-save").textContent = "保存"), 1200);
}

/** 用输入框里当前的 key + 服务商直发一个最小请求，内联显示真实结果 */
async function testConnection() {
  const btn = $("btn-test");
  const out = $("test-result");
  const apiKey = $("inp-key").value.trim();
  const providerId = $("sel-provider").value;
  const provider = PROVIDERS[providerId];

  btn.disabled = true;
  btn.textContent = "测试中…";
  out.classList.remove("hidden", "ok", "error");

  if (!apiKey) {
    showResult("error", "✗ 请先填入 API key");
    return;
  }
  if (providerId === "typesafe" && apiKey.startsWith("sk-or-")) {
    showResult("error", "✗ 这是 OpenRouter 的 key（sk-or- 开头），发到 TypeSafe 官方必然 401。请切换服务商为 OpenRouter，或换 TypeSafe 的 key（在 console.typesafe.ai/keys 创建，以 apikey_ 开头）");
    return;
  }
  if (providerId === "typesafe" && !apiKey.startsWith("apikey_")) {
    showResult("error", `✗ 格式可疑：TypeSafe 官方的 key 以 apikey_ 开头（在 console.typesafe.ai/keys 创建），当前输入以 ${apiKey.slice(0, 8)}… 开头，多半属于其他平台`);
    return;
  }

  const body = {
    state: "这是一条连接测试：本消息无恶意。",
    model: provider.model,
    questions: { is_harmless: { type: "noul", instructions: "这句话是否是无恶意的普通陈述？" } },
  };
  const started = Date.now();
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (res.ok) {
      let noul;
      try {
        noul = JSON.parse(text).answers?.is_harmless?.noul;
      } catch {
        /* 非 JSON */
      }
      if (noul !== undefined) {
        showResult("ok", `✓ 连接正常（${secs}s）：${provider.label} 返回 noul=${noul}，key 有效。记得点「保存」再刷新推特页`);
      } else {
        showResult("error", `✗ HTTP ${res.status}（${secs}s）：响应不是预期的 systemone 格式 → ${text.slice(0, 160)}`);
      }
    } else if (res.status === 401) {
      showResult("error", `✗ key 无效（401，${secs}s）：${provider.label} 拒绝了这把 key。确认 key 属于所选服务商且未过期`);
    } else if (res.status === 404) {
      showResult("error", `✗ 端点不存在（404）：${provider.label} 暂未上架 Jev 的 systemone 接口，请先用 TypeSafe 官方`);
    } else {
      showResult("error", `✗ HTTP ${res.status}（${secs}s）→ ${text.slice(0, 160)}`);
    }
  } catch (e) {
    showResult("error", `✗ 网络层失败：${e.message}（无法到达 ${new URL(provider.url).host}，检查网络/代理）`);
  }

  function showResult(kind, msg) {
    out.classList.add(kind);
    out.textContent = msg;
    btn.disabled = false;
    btn.textContent = "测试连接（用输入框里的 key）";
  }
}
