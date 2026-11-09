# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；按需配置 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

`json_list` 的地址或配置可能携带凭据，只跟随同源重定向（协议、主机和端口都相同）。若接口搬到另一个来源，请直接更新信源地址；不要依赖跨源跳转传递认证信息。

抓取默认不连内网地址。订阅或列表地址指向自建在内网的服务时（比如同一 Docker 网络里的 RSSHub，地址写 `http://rsshub:1200/...`），在 `.env` 里设 `PRIVATE_FEED_HOSTS=rsshub`（逗号分隔的完整主机名，不区分大小写），重启 API 和 worker。放行只对 `rss` 的 `feedUrl`、`web_list` 与 `json_list` 的 `url` 本身生效，这些主机直连、不走 `EGRESS_PROXY_URL`；跳转到别的主机、文章正文、详情页、图片和图标仍按原规则拒绝内网地址，链路本地和云元数据地址（`169.254.0.0/16`、`100.100.100.200` 等）任何时候都拒绝。

每种信源认哪些配置项写在 [`config-keys.ts`](../packages/backend/src/sources/config-keys.ts)。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

## 先预览，再创建

进入 `/admin/sources/new`，填写 ID、名称，选择类型，再把[下一节](#每种信源怎么配置)对应的 JSON 填入“采集配置（JSON）”。这里填的是配置对象，不要包上 `kind` 或 `config`。切换类型会重置配置，先选类型再粘贴。

名称里全角括号中的备注（比如“某媒体（热点 RSS）”）只给后台看，读者在网页、RSS、Agent Markdown、MCP 和搜索里看到的是去掉备注的名字；X 账号写成 `X：显示名 (@handle)` 的，读者只看到显示名。公开 API 的 JSON 里仍是完整的名字。

`rss`、`web_list`、`json_list`、`x_search` 可以点“预览抓取”：显示条目总数和前 20 条的标题、原文链接、发布时间、摘要，不把条目存入文章库。检查抓到的是文章而不是导航，日期与原文一致，再点“创建”。预览和正式采集套用同一组过滤（地址前缀、分类、噪声词、地址改写、`publishedAfter`），看到的就是正式采集会收的条目；但它不等于完成生产采集，也不经过后续详情补齐、精选和公开发布流程。

预览仍会发出抓取请求；X 和 Jina 预览也可能产生费用，经过付费回执和预算。`COLLECT_ENABLED=false` 只关闭后台自动采集，不能用它来保证手动预览不访问外部服务。下面的本地 HTML/JSON 示例不需要任何 API key。

## 每种信源怎么配置

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（确认文字订阅里的摘要就是全文时，将 RSS 的 `description`、Atom 的 `summary` 当正文，不再去抓原文页）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

所有信源的 YouTube、Vimeo 视频播放页都不作为文章正文提取。Media RSS 的视频描述保留为摘要，即使设置了 `summaryIsBody` 也不会把描述当成视频字幕；订阅通过 `content` / `content:encoded` 提供的真实文字仍可使用。其他文章中嵌入视频，不影响文章本身的正文读取。

文章正文中的原生视频保留安全的媒体地址和候选格式，使用浏览器控件手动播放。视频文件由浏览器直连原站，封面沿用图片代理；不自动播放、不循环，预加载提示设为 `none`，但浏览器不保证交互前完全没有请求。没有媒体地址和可用封面的播放器只保留后备文字。Markdown 和允许再分发的全文 RSS 保留视频结构，能否播放取决于阅读器；动态平台播放器和 iframe 不在此范围。

文章插图里内嵌的 SVG 图不保留图形本身（颜色和字体依赖原站样式表），换成原站给这张图写的无障碍文字说明（`aria-label`、`aria-labelledby` 指向的文字，或图里的 `<title>`、`<desc>`），作为纯文字放在图原来的位置；同一张图的宽窄两版只留一份，插图里已经显示的文字（图注、小标题）不重复。没有文字说明的图和插图之外的 SVG 图标照旧去掉。

没有网页的播客单集（没有 `<link>`、`guid` 也不是网址），原文链接用它的音频或视频文件，浏览器可以直接播放；这类单集不抓网页，按订阅里的文字处理。

### web_list

支持普通 CSS 选择器，`div` 列表也能采集。关键是 `itemSelector` 要选中**每条新闻**，而不是包住所有新闻的容器。例如：

```html
<div class="news-list">
  <div class="news-item">
    <h2><a href="/posts/first">第一条示例新闻</a></h2>
    <time datetime="2026-10-01T09:00:00+08:00">10 月 1 日</time>
  </div>
  <div class="news-item">
    <h2><a href="/posts/second">第二条示例新闻</a></h2>
    <time datetime="2026-10-01T10:00:00+08:00">10 月 1 日</time>
  </div>
</div>
```

对应配置（`example.com` 是占位地址，换成目标网页；可运行版本见[本地示例](#本地跑通-htmljson-示例)）：

```json
{
  "url": "https://example.com/news",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["https://example.com/posts/"]
}
```

- `itemSelector` 在整个页面找条目；`linkSelector`、`titleSelector` 在每个条目内取第一个匹配节点，也可以匹配条目自身。选 `.news-list` 只会得到一个容器，通常只取到第一条新闻；只写 `div` 又会混入嵌套容器。要选重复出现的新闻节点。
- 链接取自 `href`；`/posts/first` 等相对链接按列表重定向后的最终地址解析，也可用 `baseUrl` 指定基准地址。标题取节点文字。重复链接会合并；Markdown 列表先出现“Read more”等按钮、后出现真实标题时，使用真实标题。指向列表自身的链接通常会跳过。
- 日期在条目内查找 `publishedAtSelector`，依次尝试 `datetime`、`content`、`title` 属性和文字，无法解析的提示文字不会遮住同一节点的有效日期。没有时区的日期时间可用 `publishedAtUtcOffset`（默认 `+08:00`）；自带时区的时间保留原时区语义，纯 `YYYY-MM-DD` 按 UTC 零点读。不完整的月份、产品版本号和不存在的日历日期不作为发布日期。
- `parseMode`：普通网页默认 `html`；`markdown` 按 Markdown 链接读；`docusaurus_changelog` 读更新日志标题；`intercom_changelog` 按 Intercom 帮助中心的日期章节读取标题和正文，每节保留自己的网址锚点，默认按 UTC 日历日读取，也可指定 `publishedAtUtcOffset`。需要 Jina 时，显式把 `url` 写成 `https://r.jina.ai/https://目标站/路径` 并配置 `JINA_API_KEY`，不是抓不到就自动切换。Jina 默认返回 Markdown；要继续使用 CSS 选择器，显式设 `parseMode: "html"`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。`maxFetches` 是每轮最多读几篇详情页，不设时为 0，即一篇都不读：每读一篇就多一次请求，所以要信源自己声明。读取失败或本轮 `maxFetches` 用完的条目，后续抓取继续补全；补元数据时保留已确认的正文。已有真实标题不会因为列表仍写“Read the Blog”而被换回按钮文字，也不会仅因标题较长再次读取详情。需要强制使用详情标题时设置 `titleAuthoritative: true`。详情页和正文提取读到不带时区的时间时，先用 `detail.publishedAtUtcOffset`，未设则继承信源的 `publishedAtUtcOffset`，两处都未设时默认 `+08:00`。RSS、JSON 列表也可以用 `detail`。
- Jina 列表的 `detail.titleRegex`、`publishedAtRegex` 匹配 Jina 文本，可共用同一次详情响应；CSS 选择器读取原站 HTML。应按实际可读取的页面选择规则。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### json_list

假设接口返回下面的结构，`itemsPath` 指向数组，其他字段路径相对**每个数组元素**填写。路径用点分隔，不是 JSONPath，不写 `$` 或 `[*]`。

```json
{
  "data": {
    "items": [
      {
        "id": "first",
        "title": "第一条示例新闻",
        "url": "https://example.com/posts/first",
        "summary": "第一条新闻的摘要。",
        "published_at": "2026-10-01T09:00:00+08:00"
      }
    ]
  }
}
```

对应配置：

```json
{
  "url": "https://example.com/api/news",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "{raw:url}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

- 接口本身返回数组时，省略 `itemsPath`。`titlePaths`、`summaryPaths`、`authorPaths` 是候选路径数组，按顺序取第一个非空值，例如 `["title", "name"]`。
- 已有完整网址时用 `{raw:url}`；只有 slug 时可用 `https://example.com/posts/{slug}`。`{字段路径}` 会编码字段值，`{raw:字段路径}` 原样插入。JSON 列表不会自动把相对网址补成绝对网址，模板应产出完整的 HTTP(S) 地址。
- `summaryIsBody`：确认接口里的摘要就是全文时设为 `true`，把 `summaryPaths` 取到的文字当正文，不再去抓原文页。
- 日期建议返回带时区的 ISO 字符串；`2026-09-30 17:43:58` 这类不带时区的时间，与网页列表一样按 `publishedAtUtcOffset` 读（默认 `+08:00`）；数字时间戳分别设 `publishedAtUnit: "epoch_s"`（秒）或 `"epoch_ms"`（毫秒），`20261001` 这类日期设 `"yyyymmdd"`。
- 模板里的字段有一个为空，这条就用 `urlTemplateFallback` 再生成一次（比如有的条目有外链、有的只有 ID）。
- 按字段筛条目：`minNumeric: { "path": "points", "min": 100 }` 只收这个数字不小于 `min` 的，`requireBoolean: { "path": "published", "equals": true }` 只收这个字段正好等于 `equals` 的。
- 缺少标题或无法生成链接的条目会跳过。非空数组全部映射失败时，会报 `no items mapped (check title/url paths)`；路径不是数组时，会报 `items path did not resolve to an array`。

### 本地跑通 HTML/JSON 示例

仓库提供两份虚构示例：[news.html](examples/sources/news.html) 和 [news.json](examples/sources/news.json)，各有两条新闻。它们用于核对选择器和字段映射，不是运营信源；示例文章链接不提供正文。

在仓库根目录、Node.js 24.11 以上运行以下命令。服务只监听本机，只提供这两份文件；用 `Ctrl+C` 停止。

```bash
node --input-type=module -e '
import http from "node:http";
import { readFileSync } from "node:fs";
const files = {
  "/news.html": ["text/html; charset=utf-8", readFileSync("docs/examples/sources/news.html")],
  "/news.json": ["application/json", readFileSync("docs/examples/sources/news.json")]
};
http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(file ? 200 : 404, { "content-type": file ? file[0] : "text/plain" });
  res.end(file ? file[1] : "Not found");
}).listen(8787, "127.0.0.1");'
```

在同一台机器上，按[非 Docker 部署方式](deploy.md#不用-docker)准备好数据库，用 `npm run dev:api`、`npm run dev:web` 运行开发 API 和网页，保持采集、模型、飞书和 IndexNow 开关关闭，不启动 worker。仅为此次本机示例，在开发 API 进程设置 `ALLOW_PRIVATE_NETWORK_FETCH=true` 后重启；默认禁止抓内网地址，生产环境拒绝启用此项，验证后移除。若 API 在容器或另一台服务器，`127.0.0.1` 指向它自己，此命令的地址不能直接用于该部署。

分别选择 `web_list`、`json_list`，粘贴配置并点“预览抓取”，无需创建信源：

```json
{
  "url": "http://127.0.0.1:8787/news.html",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["http://127.0.0.1:8787/posts/"]
}
```

```json
{
  "url": "http://127.0.0.1:8787/news.json",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "http://127.0.0.1:8787/posts/{id}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

两次都应显示 **2 条**，依次为下表内容。JSON 示例还显示对应摘要，HTML 示例没有配置摘要提取。预览 API 的日期是 UTC，后台界面按 `+08:00` 显示为 09:00 和 10:00。

| 标题 | 原文链接 | 预览 API 的 publishedAt |
|---|---|---|
| 第一条示例新闻 | `http://127.0.0.1:8787/posts/first` | `2026-10-01T01:00:00.000Z` |
| 第二条示例新闻 | `http://127.0.0.1:8787/posts/second` | `2026-10-01T02:00:00.000Z` |

可以把 HTML 的 `itemSelector` 暂改成 `.news-list` 对照：只会返回第一条。改回 `.news-list > .news-item` 后恢复两条，这就是“列表容器”和“每条新闻”的区别。

抓真实网页时先看原始 HTTP 响应中有没有新闻节点。普通 HTML 模式不执行 JavaScript；浏览器里看得到、响应里没有的内容，不能靠换一个 CSS 选择器生成。优先找 RSS 或 JSON 接口，或按需配置 Jina / 自己维护的外部采集。`no items matched (html)` 还可能是选择器不匹配、没有 `href` 或标题、链接被前缀规则过滤；先核对响应与配置，不必先更换采集器。

### x_search

这类信源使用 SocialData 搜索，不是把 X 个人主页 URL 填入网页列表。以 `https://x.com/SomeAccount` 为例，取用户名 `SomeAccount`，不要包含 `@` 或整段 URL：

```json
{ "query": "from:SomeAccount -filter:replies", "searchType": "Latest" }
```

`SomeAccount` 是占位用户名，换成你要关注的真实账号。`-filter:replies` 排除回复；`Latest` 按最新内容查找。

在后端运行环境的 `.env` 配置 `SOCIALDATA_API_KEY`，重启 API（预览）和 worker（定时采集）后生效；不要把 key 写进信源 JSON 或提交到仓库。先在后台“设置 → 付费请求上限”检查 SocialData 额度，再按需预览。未配置 key 会报 `SOCIALDATA_API_KEY is not configured`；服务拒绝请求或预算熔断时看后台错误原因。预览可能有付费请求，本文不要求用真实服务验证，结果取决于账号和服务当时的返回。

生产自动采集时，普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数；单个信源的手动预览不是合并采集。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

需要在后端 `.env` 配置 `DAJIALA_KEY`，`ghid` 换成公众号原始 ID。配置字段用上面的 `ghid` / `nickname`，不要写成 `biz` / `name`。当前 `mp_account` 不支持“预览抓取”；`external` 也不支持主动试抓，按下方推送接口接入。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **信源类别**（可选）：日常内容主要写给开发者或业内的官方信源，可以在后台“信源”页选一个类别（`industry/selection.ts` 的 `classes`），入选门槛抬到不低于类别的数，见 [精选与校准](selection.md#门槛industryselectionts)。`industry/sources.json` 不带这一项，导入后在后台设。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **热度里怎么算**：每个参与方（一个信源；同一家公司的几个信源、同一个信源组、社区站的一个发帖账号各算一个）在 48 小时内只算一次，24 小时减半。社区站的发帖人（`COMMUNITY_FEEDS`）、X 账号、公众号按平台归成一组，填了 `owner_entity_id` 或信源组的不归组，各算一组。`packages/backend/src/events/hot.ts` 的 `HEAT_BUCKET_ALPHA`（α）大于 0 时，一组里按时间从近到远排，第 k 个只算原来的 1/(1+α(k−1))：同一件事十个 X 账号在说，算出的热度就比十家互不相干的媒体在报要低。默认是 0，每个都算满，和原来一样。α 不要凭感觉定：用 `scripts/eval-heat.ts` 在自己的数据上回放几个候选值，看榜单前 10 进出了哪些事件、排名变了多少，再选一个（见 [部署](deploy.md#更新) 里“热度 v2”一条）。
- **一手**：只有 `T1` 算一手，不单独设置。同一条新闻有几篇报道时，代表报道优先选一手的，事件页也优先展示一手报道。
- **发布方**（可选，写在 `config` 里）：
  - `publisherUrlPrefixes`：`T1` 信源自己文章网址的前缀，比如 `["https://example.com/blog/"]`。别的信源（聚合站、转帖）带来的这些网址的文章，只要能认定是唯一一个官方信源的，就改记到它名下。网页列表信源不写时，认它自己列表所在的路径（这篇也要在它的列表里出现过）。
  - `publisherRole`：`T1_5` 账号的身份，`organization`（机构官方账号）或 `person`（官方人员）。再填上信源的 `owner_entity_id`（`industry/taxonomy.ts` 的 `ENTITIES` id），这个账号发的、主体正是这家公司的新闻，就能当代表报道（排在 `T1` 之后）。
- **首发**：事件页上，每个进展里 `T1` 信源和上面这种核实过的当事方账号的报道中，发布时间最早的一篇标“首发”。媒体抢先报道、盘点文章顺带提到的都不算，没有这类报道的进展就没有首发。事件综述的输入把首发排在最前，写到这个进展时先归于它；API v1 和 MCP 的事件报道带 `firstRelease`，Agent Markdown 在这篇后面标“首发”。
- **单一来源**：一个事件的报道只来自一个独立来源（同一媒体矩阵 `signal_group_id`、同一公司 `owner_entity_id` 的几个信源算一个，和热度的算法一样），而且没有一篇是 `T1` 或当事方账号发的，事件页标“单一来源”，API v1 和 MCP 的事件带 `singleSource`，Agent Markdown 会提醒转述时说明消息只来自这一家。顺带提及的报道不算。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟（经 Jina 读的网页列表最短 60 分钟）；最长的，一般信源 60 分钟，X 账号和经 Jina 读的网页列表 120 分钟，只作热度证据的 180 分钟。合并搜索的 X 账号跟着合并后的节奏：进精选的半小时一次，只作热度证据的一小时一次。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书告警时）。周报里也有这一周精选和日报的来源分布：来自多少个信源、最多的三个占几成，以及均匀度（香农均匀度，各信源条数一样多时是 1，越集中在少数几个越接近 0）。

「7 天没有新内容」按**信源自己的节奏**判断，而不是一个固定的窗口：日报和周报里分两类。**超出自身更新节奏**的排在前面，先对照原站（把最近 90 天的**产出日**去重到「天」，相邻两天的间隔取中位数当它的节奏；至少有 4 个这样的日子才算有节奏，静默时长要超过中位间隔的 4 倍才算超）。产出日取该条内容的发布时间，页面没给时间就用我们发现它的那天；**一次首次导入算一天**——它是一次交付，发布时间往回铺多远都不算多次产出（否则一个从没产出过的源会显得很准时，跨月的首次导入还会把中位间隔撑大，把一个已经安静的源藏起来）。窗口只算这 90 天里的产出日，更早的历史说明不了它现在多久发一次；发现时间与发布时间没有固定先后，任一个落在窗口内就读，产出日再按窗口夹一次。**判断不了节奏的仍然列出**，但不当作故障，分两种：窗口内没有可比较的产出（它产出过，只是都在窗口外），以及从未收到过内容（那是采集问题）；在自身节奏内的不再列出。抓取间隔 `interval_minutes` 不参与判断——它表示我们多久看一次，不是它多久发一次。

## 定分级的参考

后台“信源”页每个信源有近 30 天的几项：收录多少条，其中精选多少（撤下的不算）、占几成，以及**首报**。首报写成“几次/几件”：它报道过、别的信源也报道了的事实有几件，其中它的报道发布最早的有几次。只有它一家报道的不算，那说明不了快慢；顺带提及和撤下的报道不算；判断谁最早时，30 天以前的报道也算进去。信源周报列出首报次数最多的 5 个信源和它们的这几项。这些只是参考，分级由你决定，不会按它们自动调整。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。没有可信发布时间的资料先不公开（不进公开列表、精选、报告、热点和推送），从原信源或原文页读到日期后再判断新旧。这条规则所有入口共用，防止一次性导入历史内容刷屏。

新信源第一次导入时，只取列表里前 `_aihot.initialBackfillLimit` 条（默认 30）、`_aihot.initialBackfillMonths` 个月以内（默认 12）的条目。之后的抓取只收发布时间在信源第一次导入前 48 小时以内或之后的条目，列表里更早的存量不再进来，不会为整个订阅存档付费；第一次导入以后发布的条目，排在长列表第几条都会收。列表上没有发布时间的条目照收，按上面的规则等读到日期再判断。X 账号按抓取位置往后读，不受这条限制。

如果只想从一个固定时间之后开始监控，可在 RSS、网页列表、JSON 配置中设置 `publishedAfter`，例如 `"2026-10-01T00:00:00.000Z"`。必须是完整的 UTC 时间，可省略毫秒；预览、首次和后续采集都只接受**严格晚于**它且发布日期可信的条目，未知日期也会排除。起点当天的单页更新章节若仍使用同一发布日期，之后追加的内容也不会被纳入；选择起点时要把这个限制考虑进去。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条，超过返回 413。每个客户端每分钟能推几次由 `INGEST_RATE_LIMIT` 决定：`docker compose` 默认 10，超过返回 429（带 `Retry-After: 60`）；不用 Docker 时默认不限，前面没有反向代理限流的话在 `.env` 里设上，设成 0 表示不限。
- 返回 `{"ok": true, "created": <新建条数>}`。不是 JSON 对象的条目、缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 在后台暂停信源后，推送接口返回 409，不再接收新文章；恢复信源后可以继续推送。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。

## 常用信源配方

下面的配置在 2026-11-09 用“预览抓取”对真实接口试过（自建 RSSHub 一节除外），写出的条目数是当时的结果，用来对照。接口的字段和限制会变，创建前再预览一次。要不要接、接哪些，由你决定；参与方式和分级是建议。

所有配方都保持 `site_fulltext`、`syndicate_fulltext` 关闭：这些平台没有授权站内展示或转发全文，只显示摘要和原文链接。

参与方式决定费用：

- `editorial`：内容本身要进精选。每条先预筛一次，过了的再评分、结构化和写作，按条调用模型。
- `hot_signal`：只想知道大家在讨论什么（社区、聚合、搜索结果）。不预筛也不写作，每条只做一次向量化，召回到相近的事件时再做一次关系判断；不单独展示，只给事件加热度。除了下面 Hacker News 那样按账号计的社区信源，一个信源在热度里只算一个来源，订阅里有多少条都一样。

### Hacker News（`json_list`，热度证据）

用 HN 官方的 Algolia 搜索接口读首页，只收 100 分以上的帖子：

```json
{
  "url": "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50",
  "mode": "json_api",
  "itemsPath": "hits",
  "titlePaths": ["title"],
  "urlTemplate": "https://news.ycombinator.com/item?id={objectID}",
  "summaryPaths": ["story_text", "url"],
  "authorPaths": ["author"],
  "publishedAtPath": "created_at_i",
  "publishedAtUnit": "epoch_s",
  "externalIdPath": "objectID",
  "minNumeric": { "path": "points", "min": 100 }
}
```

- 参与方式选 `hot_signal`，分级 `T2`。再把信源 ID 加进 `site/site.ts` 的 `COMMUNITY_FEEDS.hn`，热度就按发帖账号计，一个账号算一个来源；不加的话整个 HN 只算一个来源。
- 原文链接用 HN 的讨论页，不用帖子指向的网址。指向的文章如果已经被别的信源收进来，同一个网址只会记成那篇文章又被发现了一次，不会作为一条讨论进热度。帖子指向的网址放进摘要，归组时用得上。
- 预览时首页 50 条里有 18 条过了 100 分。分数线按你想要的热闹程度改；`tags=front_page` 换成 `tags=story&query=关键词` 就是按关键词搜。

### Hugging Face 每日论文（`json_list`）

```json
{
  "url": "https://huggingface.co/api/daily_papers?limit=50",
  "mode": "json_api",
  "titlePaths": ["title", "paper.title"],
  "urlTemplate": "https://huggingface.co/papers/{paper.id}",
  "summaryPaths": ["paper.summary", "summary"],
  "publishedAtPath": "publishedAt",
  "externalIdPath": "paper.id",
  "minNumeric": { "path": "paper.upvotes", "min": 10 }
}
```

- 接口直接返回数组，所以不写 `itemsPath`。这是社区投票挑出来的论文，量比 arXiv 小得多，适合 `editorial`、`T2`。
- `minNumeric` 只收至少 10 票的，预览时 50 篇里有 23 篇。票数按抓取那一刻算，刚上榜的论文票还少，线定得太高会漏掉当天的新论文。

### arXiv（`rss`）

```json
{ "feedUrl": "https://rss.arxiv.org/rss/cs.CL" }
```

- 量很大：2026-11-09 这天 `cs.AI` 一个分类就有 397 条，`cs.AI+cs.CL`（多个分类用 `+` 连）有 469 条，其中有旧论文的新版本（摘要里写着 `Announce Type: replace`）。按 `editorial` 收，每条都要预筛一次，过了的还要评分和写作。先在后台“设置 → 付费请求上限”看预算，或者只用上面的 HF 每日论文。

### Google News 按公司或关键词（`rss`，热度证据）

```json
{ "feedUrl": "https://news.google.com/rss/search?q=%22Anthropic%22+when:1d&hl=en-US&gl=US&ceid=US:en" }
```

- 参与方式选 `hot_signal`。原文链接是 Google 的跳转地址（`news.google.com/rss/articles/…`），读不到原文，也和别的信源收到的同一篇对不上网址；标题后面带着“ - 媒体名”。只当热度证据，靠标题归组。
- 一个订阅在热度里只算一个来源，30 家媒体报道同一件事也只加一份。
- `q` 里英文双引号包住的词要完整出现，`when:1d` 只要一天以内的。预览返回 100 条，不全相关，有的只在正文里提到这家公司；召回不到事件的记成没匹配上，不影响别的事件。
- 中文结果把后面三个参数换成 `hl=zh-CN&gl=CN&ceid=CN:zh-Hans`。

### Reddit 版块（`rss`，热度证据）

```json
{ "feedUrl": "https://www.reddit.com/r/MachineLearning/top/.rss?t=day" }
```

- 一个版块一个信源，`top/.rss?t=day` 是一天内最热的帖子（预览时 8 条）。链接是 Reddit 的讨论页，用 `hot_signal`。
- Reddit 对不登录的请求限流，被拒时后台会显示失败原因。公开站接入前看一下 Reddit 的数据使用条款。

### Mastodon 话题或账号（`json_list`）

Mastodon 的 RSS 条目没有标题，`rss` 会把它们全部跳过，所以用它的公开 JSON 接口：

```json
{
  "url": "https://mastodon.social/api/v1/timelines/tag/LLM?limit=40",
  "mode": "json_api",
  "titlePaths": ["content"],
  "urlTemplate": "{raw:url}",
  "summaryPaths": ["content"],
  "authorPaths": ["account.acct"],
  "publishedAtPath": "created_at",
  "externalIdPath": "id"
}
```

- 帖子没有标题，用去掉 HTML 的正文当标题。话题流很杂，预览的 40 条里有日语帖、机器人转发和与话题无关的内容，用 `hot_signal`。
- 只看一个账号：先打开 `https://mastodon.social/api/v1/accounts/lookup?acct=用户名` 记下数字 `id`，地址换成 `https://mastodon.social/api/v1/accounts/<id>/statuses?exclude_replies=true&exclude_reblogs=true&limit=40`，其他字段不变。官方账号可以用 `editorial`。

### 自建 RSSHub（`rss`）

RSSHub 能给很多没有订阅的网站生成 RSS，包括 Bluesky（它自己的 RSS 也没有标题）。公共实例 `rsshub.app` 拒绝程序抓取（预览返回 403），要自己跑一个。在 `docker-compose.yml` 里加一个服务，和站点在同一个网络里，不要给它映射端口：

```yaml
  rsshub:
    image: diygod/rsshub:latest
    restart: unless-stopped
```

上线时把 `latest` 换成固定的版本标签。`.env` 里设 `PRIVATE_FEED_HOSTS=rsshub`，重启 API 和 worker，订阅地址写成 `http://rsshub:1200/<路由>`：

| 内容 | 路由 |
|---|---|
| GitHub 每日趋势 | `/github/trending/daily/any` |
| Product Hunt 当日 | `/producthunt/today` |
| 36氪快讯 | `/36kr/newsflashes` |
| Telegram 公开频道 | `/telegram/channel/<频道名>` |
| Bluesky 账号 | `/bsky/profile/<handle>` |

- 这几条路由没有在本机预览过，路由名以 [RSSHub 文档](https://docs.rsshub.app/) 为准，创建前先预览。
- `PRIVATE_FEED_HOSTS` 只放行订阅地址本身。RSSHub 生成的文章链接是原站地址，正文照常按原来的规则读。

### 需要登录的信源

这些也能接，但要用你自己的账号或 Cookie，这里不给配置：

- 微博、知乎、小红书：RSSHub 有对应的路由，要在 RSSHub 的环境变量里配 Cookie。Cookie 会过期，账号也可能被平台限制。
- 公众号：用现有的 `mp_account`（极致了，按次计费）；也可以自建 we-mp-rss 这类转 RSS 的服务，它要扫码登录一个微信号。
- 这些平台的内容同样只显示摘要和原文链接，不会因为抓得到就打开全文，见 [分级、参与方式与全文](#分级参与方式与全文)。
