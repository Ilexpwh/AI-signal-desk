# 精选与校准

## 一条资料怎么变成精选

1. **收进来**：同一网址、同一内容只留一份。普通文章只有标题或摘要时，按信源规则补取正文；视频播放页使用已提供的文字材料，不把播放器页面当正文。没有可信发布时间的资料先不公开，读到原文日期后再判断新旧（见 [信源](sources.md#规则旧文不刷屏) 的“旧文不刷屏”）。别的信源近两周已经判过的同一篇文章被转载过来（文字指纹相同或只差几位），不再调用模型：沿用原文的判断，挂到原文所在的事件下多算一家报道，但不单独进“全部动态”和精选（见 [事件归组](grouping.md#转载)）。
2. **预筛**（`prefilter.md`）：这是不是本行业的事。宽进，只拦明显无关的：`BLOCK` 的资料不出现在任何公开页面；`PASS` 和拿不准的 `UNKNOWN` 继续往下走。只有标题、没有正文、订阅摘要或帖子文字的普通文章先等待材料，不评分、不凭标题写文案，也不进入公开池；材料补齐产生新修订后再判断。可展示的空文字或纯链接原帖沿用原有评分与原样展示规则。
3. **评分**（`selection-score.md`）：同一份评分标准独立打两次分。每次模型只判内容类型、给五个维度各打 0–10 分，并标出材料是否残缺到无法判断（`thin`）；系统按 `industry/selection.ts` 里这个类型的权重把五个维度合成 0–100 分，`thin` 的不高于 `thinCap`。**两次的平均 ≥ 门槛**就够分，门槛按信源分级不同，信源类别还能把某些官方信源的门槛抬高；够分的还要过第 6 步的去重才进精选。页面上显示的分数是两次的平均（向下取整）。第一次的分数离门槛、`understandFloor`、`browseFloor` 都足够远（`secondScoreWithin`）时，第二次不评，直接按第一次判断；默认 `101` 总是评两次，要改先按下文“少评一次分”校准。
4. **结构化**（`structure.md`）：和评分同时进行。给出分类和标签（页面上显示的就是这一份）、主体公司，判断这篇是一条具体新闻、讲多件事的综合稿，还是材料不够、说不清；是具体新闻的，抽出它的事实（谁、做了什么、对什么、什么时候）和原文里的出处、前提条件。主题页、事件归组和日报都靠它。
5. **写标题摘要**：等结构化完成再写。入选的和差一点入选的（平均分高于 `understandFloor`），按 `content-understanding.md` 写中文标题、答案先行的摘要和推荐理由；其余的按 `summarize-*.md` 写简短的标题摘要，进“全部动态”。浏览“全部动态”（网页列表，接口、给 Agent 的最新列表和 MCP 的全部模式，“全部动态”RSS）只出平均分不低于 `browseFloor` 的资料，没评上分的照常出；带搜索词时仍搜全部。X 帖子没有正文或只含链接时，保留原帖的链接、图片和引用，不调用写作或翻译模型，也不生成“请补充正文”的文案；已经取得实际正文的 X 长文照常处理。写好的文字用了 `industry/wording.ts` 里列出的词时，再让模型只改这些词一次（`mend-wording.md`）。最后核对写好的文字，只记录、不改（见下文“核对文字”）：标题里的公司和事实主体对不对得上，以及内容理解写的标题和摘要逐条有没有原文依据（`verify-copy.md`）。
6. **归组与去重**（`group-*.md`）：不同来源报道的同一件事归成一个事件，事件页有综述（`story-digest.md`），“热门”按事件排。修改综述提示词前，可用 [综述评测](story-digest-evaluation.md) 在同一批事件上把现有提示词和候选提示词并排比较。分数够了的资料要等归组完成才进精选：模型同时判断它和精选里已有的报道是不是同一条新闻，以及它有没有精选还没给过的具体信息。
   - 同一条新闻的几篇报道都可以入选：网页上折成一个阅读组；API、RSS 和同步接口每条新闻只出一条，由代表报道出面：官方一手优先；其次是核实过的官方账号（填了 `publisherRole` 和 `owner_entity_id` 的 `T1_5` 账号，新闻的主体正是这家公司，机构先于个人）；再往后是有全文的、分数高的、发得早的。
   - 不是同一条新闻、但没有新信息的（换个说法再介绍一遍已经披露的能力、只是上架到别的平台、只重复已选要点的汇总），不进精选，留在“全部动态”。讲多件事的综合稿不单独成事件，只挂到它提到的事件上，有精选没覆盖的重要内容才入选；材料不够、确认不了是哪条新闻的，不进精选。
   - 显式撤回的报道保留历史归属，但不再参与之后的归组召回、候选代表、事件起点或自动事件比较；同网址及 X 回复／引用也不能借它提供身份依据。同一事实仍有有效报道时使用有效稿，全撤回则暂不召回；恢复公开后可重新参与。只展示摘要或尚未发布的记录不等于撤回，保留原有资格。已有关系和判断不删除，不批量重新归组。
   - 确认之前资料只在“全部动态”里，等得再久也不会自动放行。模型调用失败或回答不合格式，这条资料就停在那里：等待超过 10 分钟会告警，后台“运行”页列出这些资料，可以在后台“内容诊断”里打开这条资料，点“重新归组”。所以归组用的模型要能稳定按格式回答。
7. **日报、周报、月报**：
   - **日报**每天 08:00 出（日报、周报、月报的出刊时间在 `site/site.ts` 的 `EDITION_TIMES`，下面按默认值写），覆盖前一天 08:00 到当天 08:00，按规则编排，不调用模型。一件事一条，取报道最多的那条新闻里最权威的一篇，同一事件当天的其他进展列在下面，讲多件事的综合稿挂到它提到的最重要那件事下面。最近 7 期报过的不再出现；报过的事件再有进展，只有当事方自己有新动作（教程、观点这类 `commentary` 类别不算）、或这条进展有 4 家以上信源报道时才进正文，其余进快讯。没有报道入选、但有官方原帖并且已有 3 个以上独立参与方的事件也会补进来（只进日报，不进精选、不推送）。按重要性排序（入选报道的最高分、当天讨论它的独立参与方、有没有官方原帖，跟进的减分），前 12 条进正文，同一信源最多 2 条，再往后最多 10 条一行快讯。第一条是头条，导语就是它自己的标题和摘要；第 2–4 条是今日看点。
   - **周报**（每周一 10:00）和**月报**（每月 1 日 10:30）由这一周、这个月的日报汇编：同一事件跨天只算一件，按日报给它的位置（头条、看点、上了几天）、报道面和评分排序，周报取前 20 件、月报取前 30 件，按日报的分节分栏目。模型（`report-period.md`、`report-period-sections.md`）只写总述和三件以上栏目的一句导读，不增删条目；它写出了条目里没有的名字或数字（拉丁字母的名称、三位以上或带小数点、百分号的数字、词表里的公司），这段话就不用：总述换成按模板生成的一句，栏目不放导读。行业通用词（`taxonomy.ts` 的 `PLAIN_TERMS`）和站名不受这个限制。周报最后一版是“上升中的主题”：这一周里哪天占比冲到平时几倍的主题，按 `topic_trends` 的数和 `TOPIC_RISING` 的门槛列出（见 [把它改成你的行业](customize.md#2-分类标签和主题industrytaxonomytsindustrytopicsjson)），不调用模型，也不交给写总述的模型。
   - 每条精选只进一期：按它的时间算，确认入选比它晚的按确认时间；截止以后才确认的进下一期。
   - 每半小时检查一次：到点的刊期出一次，已经出过的不重写；停机错过的、失败的，在之后的检查里补上。日报时段里有资料经过判断、但没有新事件时照常出空刊；没有任何资料经过判断仍算失败，缺期按[部署说明](deploy.md#更新)告警。周报、月报的周期内，应有日报齐全且原始正文条目全部为空时，自动跳过该期，不写空周报或月报、不调用模型，也不记为生成或失败；首个周期从全站最早日报开始检查。没有可汇总条目时，若缺失日报或原有条目后来无法公开，仍保留原有错误。跳过不写永久标记，在现有补刊范围内更正日报后可重新生成。

每一步的提示词都在 `industry/prompts/`，改提示词不用改代码。提示词的版本就是它内容的哈希：改了提示词，之后的新资料按新版判断，已经判过的不会重算。

## 门槛：`industry/selection.ts`

```ts
export const SELECTION = {
  weights: {                                  // 内容类型 → 五个维度的权重，每行之和为 10
    model_release: { sig: 3, nov: 2, cred: 2, reson: 2, act: 1 },
    // …其余六类
  },
  thinCap: 30,                                // 材料残缺到无法判断（thin）的，分数不高于它
  secondScoreWithin: 101,                     // 第一次评分离各条线都不近于它时不评第二次；101 总是评两次
  thresholds: { T1: 60, T1_5: 65, T2: 76 },   // 两次评分的平均至少要到这个数
  classes: {                                  // 信源类别：这类信源的门槛不低于这里的数
    ecosystem: { label: "生态与基础设施", threshold: 70 },
    leaderboard: { label: "评测榜单", threshold: 76 },
  },
  understandFloor: 50,                        // 平均分高于它的未入选资料，也按入选的写法写
  browseFloor: 40,                            // 浏览“全部动态”只出平均分不低于它的资料，搜索不受限
};
```

五个维度由模型判，权重和合成在代码里：模型看不到权重，没法为了凑某个总分去调某一维；评测时每条样本的类型和五个维度会写进 SelectBench 的理由里，能看出分数是怎么来的。改了权重，和改门槛一样，要在自己标注的样本上重新校准（见下文）。

官方一手信源（T1）门槛低一些，媒体和个人（T2）门槛高一些：同样一件事，官方原文更值得先看。没有门槛的分级（`EXCLUDE_MP`）不参与精选。

分级只说明来源是不是官方、一手。有些官方信源的日常内容主要写给开发者或业内（芯片与云服务、开发框架与工具链、评测榜单……），读者要看的只是其中的大事：在后台“信源”页给它选一个类别，门槛抬到不低于类别的数。只抬不降，分级门槛本来就更高的不受影响；不选类别就只按分级。类别的键存在信源上，上线后不要改名，改了的类别会悄悄失效；评测样本不带类别，按分级门槛算。

`browseFloor` 设成 `0` 就和以前一样，“全部动态”列出全部公开资料。

这组数是 AIHOT 在 AI 领域一直在用的门槛，偏严：宁可少选几条，也不让噪声进精选。换了行业、改了评分标准，一定要按下面的办法重新校准。

## 校准

### 1. 准备样本集

从你自己的信源里挑 100–200 条资料，一条一条标“该选 / 不该选”，存成 `.data/gold.jsonl`（`.data/` 不进 Git）。每行一条：

```json
{"caseId":"law-001","material":{"title":"原文标题","originalTitle":null,"publishedAt":"2026-10-01T09:00:00+08:00","sourceName":"信源名称","bodyZh":null,"bodyOriginal":"正文……"},"sourceFacts":{"sourceKind":"rss","sourceTier":"T1","firstParty":true,"language":"zh"},"samplingContext":{"benchmarkSplit":"development","samplingStratum":"regulation"},"gold":{"decision":"select"}}
```

| 字段 | 说明 |
|---|---|
| `caseId` | 唯一编号 |
| `material` | 标题、原标题、发布时间、信源名、正文（中文正文放 `bodyZh`，原文放 `bodyOriginal`，有一个就行） |
| `sourceFacts` | 信源类型、分级、是否一手（线上只有 `T1` 算一手，标注时保持一致）、语言。分级决定用哪个门槛 |
| `samplingContext` | 可选。`benchmarkSplit` 分开发集和留出集，`samplingStratum` 是你自己的分组（比如“新规”“判决”“营销”），看错在哪一类 |
| `gold.decision` | `select` 该选，`reject` 不该选，`either` 两可（不计入准确率） |

`industry/gold.example.jsonl` 有两条示例。

几条建议：

- 多放**难例**：差一点就该选、差一点就不该选的。一眼就能判断的放太多，准确率会虚高。
- 分出一部分做**留出集**（`benchmarkSplit: "holdout"`），调提示词只看开发集，最后再用留出集检查一遍，免得把提示词调成只会做这几道题。
- 标注的人最好就是以后读这个站的人，或者和他们口味一致的人。
- 评测只跑预筛和两次评分，不含第 6 步的去重：按这条资料本身该不该选来标，不要因为同一件事已经选过另一篇就标“不该选”。

### 2. 跑评测

```bash
node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl --split development --label "第一版评分标准"
```

对每条样本跑一遍预筛和两次评分（评测总是评两次，再按线上的 `secondScoreWithin` 重放：第一次离各条线都远的，只按第一次判断），输出：

- **有效输出准确率、查准率、查全率和 F1**：只看成功得到入选决定的非 `either` 样本，用来判断模型答出来以后有多准；
- **覆盖率**：成功得到入选决定的样本占全部非 `either` 金标样本的比例；**完整准确率**则用全部非 `either` 金标样本作分母，把模型失败或回答不合格式也算作没有正确完成；
- `either` 始终不进入上述质量指标的分母；报告另外记录决定样本失败数与 `either` 失败数。`goldSelectRate` 按全部非 `either` 金标计算，因此同一批样本在不同模型间应保持一致；
- 门槛从 40 到 90 每隔 2 分（范围可以在下面说的 `DEPLOYMENT.selectionGold` 里改），各自会得到什么结果；门槛扫描同样同时报告有效输出准确率、覆盖率和完整准确率；
- 判错的条目，完整报告写到 `.data/eval/`，同时导入后台 SelectBench（加 `--no-import` 不导入）。

不传 `--models` 时，评测用“精选评分”这一步线上正在用的模型：后台“模型与评测”页切换过的优先，其次是环境变量 `SCORE_MODEL`，再其次是 `site/models.ts` 的 `DEFAULTS.score`，都没有就用默认模型（`.env` 里的 `LLM_*`）。`--models default,deepseek-flash` 可以在同一批样本上比较几个模型。其他常用参数：`--n 200` 最多抽多少条，`--split holdout` 只跑留出集，`--no-import` 不导入 SelectBench。在 `site/site.ts` 的 `DEPLOYMENT.selectionGold` 里写好样本文件、抽样条数、只抽哪一份和门槛扫描范围，以后不带参数运行就用这一套。

同一次评测里，不同样本渲染出完全相同的评分输入时，只共享模型的评分结果，各样本仍按自己的预筛结果、信源分级门槛和标注独立计分；失败的结果也在这次运行里共享，这样第一次跑和用已有结果重跑覆盖的样本一样。重复运行会复用已有回执。报告里的 token 用量和平均耗时，按相关回执的全部请求尝试汇总，解析失败后的重试也算在内；用已有结果重跑时，显示的是这些回执累计的用量，不代表这次新增的费用。

### 3. 看错例，改标准，再跑

在后台 SelectBench 里逐条看判错的资料和模型给的理由：

上传多模型报告时，同一 `caseId` 在各模型下须使用相同的 `gold` 标注，模型的 `decision` 可以不同。标注冲突的报告会在写入前被拒绝，避免同一条资料在并排比较时出现不同的人工答案；不提供逐例 `cases` 的报告仍可导入。

- 该选没选上，多半是评分标准里没说清它为什么重要：在 `selection-score.md` 里把这类价值写进“必须正常评价”的部分，给出例子。
- 不该选却选上了，多半是噪声没压住：写进“必须压住”的部分。
- 整体偏松或偏紧，而判错的条目分数都贴着门槛，再调 `industry/selection.ts` 的门槛。

先改标准，再动门槛：门槛只能整体移动，解决不了“哪一类判错了”。每改一次跑一遍，SelectBench 里能看到每一版的对比。比较模型时不要只看有效输出 F1：如果覆盖率明显不同，还要一起看完整准确率；高分但经常无法完成结构化判断的模型，不应被失败样本从分母里“隐藏”掉。

### 4. 少评一次分：校准 `secondScoreWithin`

第一次评分离门槛很远时，第二次几乎不会改变结论。线上已经评过两次的判断记录就是现成的数据，不用新调用：把两次中的每一次都当成“第一次”，看只按它判断会和两次的平均差多少。

```bash
psql "$DATABASE_URL" -v floor=50 -v browse=40 -v days=90 -f score-margin.sql   # floor、browse 填你的 understandFloor、browseFloor
```

```sql
-- score-margin.sql：每个候选距离下，会少评多少次，以及按第一次判断会改变多少结论
WITH pairs AS (
  SELECT DISTINCT ON (an.article_id, an.input_revision)
         (an.output->'scores'->>0)::int AS s1, (an.output->'scores'->>1)::int AS s2, (an.output->>'threshold')::int AS t, an.relevance
  FROM analyses an
  WHERE an.origin = 'model' AND an.created_at > now() - make_interval(days => :days)
    AND CASE WHEN jsonb_typeof(an.output->'scores') = 'array' THEN jsonb_array_length(an.output->'scores') END = 2
    AND jsonb_typeof(an.output->'threshold') = 'number'
    AND an.output ? 'scoreAxes'                                -- 只用五维评分以后的记录
  ORDER BY an.article_id, an.input_revision, an.id DESC
), draws AS (SELECT s1 AS a, s2 AS b, t, relevance FROM pairs UNION ALL SELECT s2, s1, t, relevance FROM pairs),
judged AS (
  SELECT m, relevance, least(abs(a - t), abs(a - :floor), abs(a - :browse)) >= m AS alone,
         a >= t AS sel1, (a + b) >= 2 * t AS sel2,
         (a >= t OR a > :floor) AS near1, ((a + b) >= 2 * t OR (a + b) > 2 * :floor) AS near2,
         a >= :browse AS list1, floor((a + b) / 2.0) >= :browse AS list2
  FROM draws CROSS JOIN generate_series(0, 30) AS m
)
SELECT m AS margin, count(*) AS draws,
       round(100.0 * count(*) FILTER (WHERE NOT alone) / count(*), 1) AS second_call_pct,
       count(*) FILTER (WHERE alone AND relevance = 'pass' AND sel1 AND NOT sel2) AS selected_extra,
       count(*) FILTER (WHERE alone AND relevance = 'pass' AND sel2 AND NOT sel1) AS selected_lost,
       count(*) FILTER (WHERE alone AND near1 <> near2) AS writer_flips,
       count(*) FILTER (WHERE alone AND list1 <> list2) AS browse_flips
FROM judged GROUP BY m ORDER BY m;
```

`margin = 0` 一行是“总是只评一次”：单次评分本身和两次平均的分歧。选 `selected_extra + selected_lost` 每千次仍在你能接受的范围内的最小距离，填进 `secondScoreWithin`，再用评测确认：报告里的 `secondScoreRate` 是会评第二次的比例，`flipsVsBoth` 是只按第一次判断时和按两次判断结论不同的样本数。五维评分刚上线时先等一两周，攒够新格式的记录再算。

### 5. 认转载：校准指纹距离和最短字数

转载靠文字指纹认：标题和全文（帖子是帖子和它引用的帖子）去掉链接、标点和空白后算一个 64 位的 SimHash，和别的信源近两周判过的资料比，相差不超过 `COPY_MAX_DISTANCE` 位（默认 `3`）就算同一篇；去掉这些后不到 `COPY_MIN_CHARS` 个字（默认 `200`）的不算指纹，照常判断。两个数在 `packages/backend/src/editorial/copies.ts`，都是起始值，要用自己站的资料定。还有两条不用校准的规则：门槛比原文信源低的信源不当转载（媒体转官方原文算转载，官方原帖不会被当成媒体稿的转载），模块声明为独立精选（`independentSelectedSources`）的信源也不当转载。

`scripts/eval-copies.ts` 只读数据库，不调用模型。它按上面的规则重算近期资料的指纹，把不同信源之间指纹相差不超过 `--max` 位的每一对列出来，按距离统计完整判断当时怎么处理了它们：归进同一个事实（`same-fact`）、归进不同事实（`other-fact`）、没归组（`ungrouped`）、已经是转载（`already-copy`），以及两篇的判断是否一致、后来的一篇有没有入选：

```bash
node --env-file=.env scripts/eval-copies.ts --days 14 --max 8   # 还可以加 --min-chars 300 试别的字数
```

统计写到 `.data/eval/copies-*.json`，每一对写进同一目录下的标注表 `copies-labels-*.csv`。在表的 `label` 列逐对填：`copy`（后一篇照搬前一篇）、`rewrite`（同一条新闻，但是自己写的）、`different`（不是同一条新闻）。距离小的对最要紧，每个距离至少看二三十对，不够就都看。填好后算每个距离以内的查准率：

```bash
node --env-file=.env scripts/eval-copies.ts --labels .data/eval/copies-labels-<时间>.csv
```

取查准率不低于 98%、而且没有说不清原因的 `different` 的最大距离，填进 `COPY_MAX_DISTANCE`。查准率只把 `copy` 算对：`rewrite` 当成转载，代价是它没有自己的判断（跟着原文的判断和事件，不会自己入选）；`different` 当成转载，它会挂到别的新闻下，是最要避免的错。短稿最容易撞指纹，`different` 多出在字数少的对里时，先调高 `COPY_MIN_CHARS` 再重跑。改完以后的新资料按新数判断，已经认成转载的不变；要某一条按它自己的全文重判，在后台“内容诊断”里点“重新评估”。

### 6. 核对文字：先只记录

写好的文字（改用词之后）还要核对两项。结果只记在判断记录里，读者看到的文字不变：

- **标题主体**（代码比，不调用模型）：结构化抽出的事实主体（`fact.subject`）按 `taxonomy.ts` 的公司名录认出是哪家，认不出时取身份词典在里面找到的唯一一家；再和身份词典在标题里认出的公司比。记成 `output.subjectGuard`：`match`（标题提到了这家）、`mismatch`（标题只提到别家）、`unknown`（事实没有唯一认得出的公司、标题里没有认得出的公司，或者身份词典里没有这家）。每次判断都记。
- **逐条对照原文**（`verify-copy.md`，模型步骤“核对文字”，环境变量 `VERIFY_MODEL` 可以单独选模型）：只核对内容理解写的标题和摘要，每条多一次调用。模型把它们拆成一条条说法，判断 `supported`、`unsupported` 或 `unclear`，并摘原文的一句作依据。这句要像结构化的出处一样能在原文正文里原样找到，找不到的、或者说有依据却没给原文的，都记成 `unclear`。记成 `output.grounding`（`{model, claims}`）；调用失败或回答不合格式时记 `{failed: "<原因>"}`，判断和文字照常保存，下次重新评估时再核对。

后台“内容诊断”在每次判断下面列出这两项，信源周报多一行：本周入选和接近入选的稿子里，标题主体对不上、有原文不支持的说法、核对失败的各多少条。先看至少两周的记录，确认 `mismatch` 和 `unsupported` 大多真是写错了，再决定要不要据此改动文字。逐条看：

```sql
SELECT a.id, an.title_zh, an.output->'subjectGuard' AS subject, c->>'part' AS part, c->>'text' AS claim, c->>'quote' AS quote
FROM articles a
CROSS JOIN LATERAL (SELECT title_zh, output FROM analyses WHERE article_id = a.id ORDER BY id DESC LIMIT 1) an
LEFT JOIN LATERAL jsonb_array_elements(an.output->'grounding'->'claims') c ON c->>'verdict' = 'unsupported'
WHERE a.discovered_at > now() - interval '14 days' AND an.output ? 'grounding'
  AND (an.output->'subjectGuard'->>'outcome' = 'mismatch' OR c IS NOT NULL)
ORDER BY a.discovered_at DESC;
```

## 换模型

后台“模型与评测”页能看到每一步当前用哪个模型、近期的成功率、耗时和 token 用量，也能直接切换（只影响之后的新任务）。换评分模型之前，先用 `--models` 在同一批样本上比一比。

## 试用 Jev

[Jev](https://typesafe.ai)（TypeSafe 的 System One）不写文字，只回答判断题：选择题给出每个选项的概率，分级题给出每一级的概率，是非题给出“是”的概率。预筛和评分本来就是判断，`industry/decisions.ts` 把 `prompts/prefilter.md` 和 `prompts/selection-score.md` 的标准改写成了这样的题目：预筛是 PASS / BLOCK / UNKNOWN 三选一；评分是内容类型、五个维度各五级（0、2.5、5、7.5、10 分）和“材料是否残缺”，再按 `industry/selection.ts` 的权重合成 0–100 的分数分布，和模型评分是同一个口径。

现在它**不决定任何结果**，只用来比较。要不要换，按下面三步来：

1. **配好 key**：`.env` 里填 `TYPESAFE_API_KEY`（地址默认 `https://api.typesafe.ai/v1`，要改填 `TYPESAFE_BASE_URL`）。每条资料的标题、发布时间和正文开头（`stateChars`，默认 2000 字）会发给 TypeSafe，它是美国的服务，先确认你的信源条款和隐私说明允许。调用按输入 token 计费，回执里记的是估算的美元费用，预算熔断是后台“设置”里的 `typesafe`（worker 启动时补上默认值，改过的不动）。
2. **在样本集上比**：`node --env-file=.env scripts/eval-selection.ts --split development --models default,jev --prefilter jev`。`jev` 一栏的分数是它的中位分；报告多了 `cascadeRate`（在 `--floor` 的把握下它不敢自己下结论、要交给模型的比例）和 `aloneAccuracy`（它自己下结论的那些的准确率），用了 `--prefilter jev` 还有 `prefilterCascadeRate`。在样本集上明显比现在的模型差，就到此为止。
3. **在真实流量上影子运行**：后台“模型与评测”页，预筛或评分那一步点“影子运行”，选 `jev`。之后每 5 分钟，它对这一步新做的判断（两天内、当前版本的资料）各答一遍，最多 100 条，只记回执，不改分数、不改精选，读者看不到任何变化；同一条资料、同一套题目只问一次。跑满两周后：

   ```bash
   node --env-file=.env scripts/eval-jev-shadow.ts --days 14
   ```

   报告给出预筛的混淆矩阵（行是模型的判断，列是 Jev 的），评分的平均差和一条保序映射 `scale`（把 Jev 的分数换算到模型评分的口径），以及每个把握下限它自己下结论的比例和这时与模型的分歧（三条线：门槛、写作下限、浏览下限，任何一条站错边都算分歧）。`oneCallDisagreement` 是同样口径下“一次模型评分”和“两次平均”的分歧：选一个分歧不高于它、自己下结论的比例又值得的下限。

题目的措辞是站点的判断标准，按 `prompts/` 的同一套原则改：改了题目，题目版本跟着变，旧回执不再复用，影子运行会对新判断重新问。`confidence` 和 `scale` 在影子报告和样本评测都看过之前保持 `null` 和空数组。真要让它替某一步做判断，是另一次改动：在留出集上重新评测，确认准确率和 F1 在误差范围内，再把影子运行的代码换成正式的分流。
