const $ = (id) => document.getElementById(id);

init();

async function init() {
  const s = await chrome.storage.local.get(["apiKey", "enabled", "blockedCount"]);
  $("inp-key").value = s.apiKey ?? "";
  $("chk-enabled").checked = s.enabled !== false;
  $("blocked-count").textContent = s.blockedCount ?? 0;

  $("btn-save").onclick = async () => {
    await chrome.storage.local.set({ apiKey: $("inp-key").value.trim() });
    $("btn-save").textContent = "已保存";
    setTimeout(() => ($("btn-save").textContent = "保存"), 1200);
  };
  $("chk-enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
}
