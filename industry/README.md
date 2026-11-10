# 行业包

这个行业的知识都在这里：分类、主题、信源、精选标准和门槛。换一个行业，主要就是改这个文件夹和 [`site/`](../site/)（站名、文案、品牌和页面），步骤见 [把它改成你的行业](../docs/customize.md)。

| 文件 | 内容 |
|---|---|
| `taxonomy.ts` | 分类、标签、公司与机构、防止模型写错公司的词表，这个行业最受关注的那类发布（`RELEASE`）；可选的公司 Wikidata 条目和类别 IPTC 媒体主题 |
| `topics.json` | 主题目录（`/topics`），站点启动时读取 |
| `sources.json` | 首次启动时导入的示范信源 |
| `prompts/` | 每一步的提示词：预筛、评分、写作、核对、结构化、归组、事件综述、周报月报、翻译 |
| `selection.ts` | 入选门槛，以及评分五个维度按内容类型的权重 |
| `decisions.ts` | 预筛和评分的标准改写成的判断题，只在试用 Jev 时用（[精选与校准](../docs/selection.md#试用-jev)） |
| `gold.example.jsonl` | 精选评测样本的格式示例 |
| `relation-gold.example.jsonl` | 事件关系评测样本的格式示例 |
| `story-digest-eval.example.jsonl` | 事件综述评测案例的格式示例 |
