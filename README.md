# Twitter 评论净化 · Jev

一个 Chrome 扩展（Manifest V3），实时检测推特（x.com / twitter.com）推文详情页的回复，
自动屏蔽**色情引流**与**恶意**内容。语义判断由 [TypeSafe Jev](https://docs.typesafe.ai)
提供——一个返回类型化概率（而非生成文本）的 System One 模型，适合在代码工作流中做
可编程的判断。

## 功能特性

- **实时检测**：打开推文详情页后自动监听回复流入，无需手动操作
- **双维度判断**：每条回复评估「色情引流」「恶意内容」两个独立概率
  （辱骂攻击 / 仇恨言论 / 诈骗钓鱼 / 垃圾广告引流等）
- **昵称 + 正文联合判断**：营销号的色情信号常藏在昵称里（如"同城上门""线下选妃"），
  昵称与正文一起送入模型
- **隐形字符清洗**：垃圾评论常用零宽字符绕过审核并把文本切碎
  （"我‌‍福‍‌不‌‍黑"），发送判断前先剥离 U+200B-200F / U+2060-2065 / U+FEFF
  等隐形字符，还原可读文本
- **可逆屏蔽**：命中的回复被替换为「🚫 已屏蔽（原因 + 概率）」，点击可查看原文，
  查看后不再重复屏蔽
- **结果缓存**：同一（作者+正文）只判断一次；Twitter 虚拟列表回收节点后重新出现的
  相同回复直接复用结果，不产生额外请求
- **批量请求**：滚动窗口内的回复合并为一次 API 请求（每批 ≤ 8 条，每条 2 个问题并行）
- **失败自愈**：请求超时 / service worker 休眠时自动重试；未配置 key 自动挂起，
  配置后恢复

## 安装

1. 下载或克隆本仓库
2. 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点击「加载已解密的扩展程序」，选择本项目根目录
4. 点击工具栏插件图标，填入 TypeSafe API key（在
   [docs.typesafe.ai](https://docs.typesafe.ai) 申请）并保存

## 使用

打开任意推文详情页（URL 含 `/status/`），向下滚动评论区即可：

- 命中的回复自动隐藏，显示占位文案：`🚫 已屏蔽 疑似色情（色情 93% / 恶意 10%）· 点击查看`
- 点击占位可展开原文（展开后该条不再屏蔽）
- 工具栏图标徽章显示累计屏蔽数；插件弹窗可开关功能、查看统计、更换 key

> 注意：首页时间线不属于"评论区"，插件不在时间线页生效，这是设计行为。
> 修改插件代码后需在 `chrome://extensions` 重新加载，并刷新已打开的推特页面。

## 工作原理

```
content script（常驻推特页面）                background service worker
  MutationObserver 监听回复流入                代发 API 请求（绕开页面 CORS）
  ├─ 首条 article = 主推文，跳过                  每条回复两个 Noul 问题：
  ├─ (作者+正文) 哈希查缓存，命中直接复用            p{i} 是否色情引流
  ├─ 未命中 → 400ms 窗口攒批（≤8 条） ──JUDGE──→    m{i} 是否恶意内容
  └─ 色情≥0.5 或 恶意≥0.6 → 屏蔽   ←──verdicts──  429/529 指数退避，20s 超时
```

- 为什么用 **Noul**：屏蔽规则是"任一维度超阈值即隐藏"，Noul 返回单一条件成立的
  概率，两个独立标签各问一次，策略阈值留在代码里可随时调整
- 为什么**问题按条重复**：TypeSafe API 中一个问题 = 对共享 state 的一次判断，
  判断 N 条回复需要 N 个问题实例（各自引用 `tweets[i]`），它们在服务端并行执行
- **判断维度定义**在 `background.js` 的 `PORN_QUESTION` / `MALICIOUS_QUESTION`
  （命中特征、排除项），**阈值**在 `content/content.js` 的 `POLICY`

## 配置项

| 位置 | 配置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `content/content.js` → `POLICY.pornThreshold` | 0.5 | 色情概率屏蔽线 |
| `content/content.js` → `POLICY.maliciousThreshold` | 0.6 | 恶意概率屏蔽线 |
| `content/content.js` → `POLICY.batchSize` | 8 | 每次请求最大条数 |
| `content/content.js` → `POLICY.cacheMax` | 2000 | 判决缓存上限 |

API key 仅保存在本机 `chrome.storage.local`，不会上传到任何第三方。

## 项目结构

```
├── manifest.json        # MV3 清单（twitter.com / x.com 双域名）
├── background.js        # service worker：API 客户端（Noul 问题构造、重试、超时）
├── content/
│   └── content.js       # 扫描、缓存、攒批、屏蔽与还原、启发式作者提取
└── popup/
    ├── popup.html       # 设置界面
    ├── popup.js         # key 保存、开关、统计
    └── popup.css
```

## 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 回复没有被屏蔽 | 确认 URL 含 `/status/`；打开 DevTools Console 查看 `[评论净化]` 前缀日志 |
| 重载插件后页面不再屏蔽 | 旧页面上的脚本已失效（Console 有提示），**刷新推特页面**即可 |
| 一直无反应 | 检查是否已保存 API key；刷新插件和页面 |
| 误杀正常回复 | 调高 `POLICY` 阈值，或修改问题定义中的排除项描述 |
| 漏放明显引流 | 把该条昵称+正文加入问题定义的命中特征示例 |

## 已知限制

- 仅判断文本内容，推文中的图片 / 视频不参与判断
- 新回复流入到屏蔽之间约有 0.5–1 秒延迟（攒批窗口 + API 往返）
- 未展开的嵌套回复（"显示更多回复"）在被展开前不会出现在 DOM 中，自然也不会被判断

## 相关项目

- [comment-jev-chrome](https://github.com/ai-suifeng/comment-jev-chrome) —— 姊妹项目：
  按需汇总式评论分析插件（B站 / 抖音 / 小红书 / YouTube），与本插件相互独立
