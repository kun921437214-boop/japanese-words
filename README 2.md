# japanese-words 数据维护说明

当前数据定位：

- `data/words-data.json` 是历史种子数据源，不是正式词库。
- `candidatePool` 是当前统一候选池。
- `candidatePool[kanji].aiCard` 是唯一正式单词卡内容来源。

词源只使用以下业务类型：

- `deepseek_generated`：DeepSeek 新生成词。
- `deepseek_reviewed`：历史种子数据经 DeepSeek 审核后保留的词。
- `manual_keep`：用户收藏、待发布、已发布或手动保留的受保护词。
- `audit_missing`：历史种子数据中尚未经过 DeepSeek 审核的词，只能进入补审队列。

未经过 DeepSeek 审核的历史种子词，不能进入今日候选、补位池、正式导出，也不能展示本地模板词卡。没有 `aiCard.cardStatus = "ready"` 的词只能显示基础信息。

## 构建

修改 `data/words-data.json` 后运行：

```bash
npm run build:words
```

这会更新：

- `words-data.js`
- `shared/words-data.mjs`

## 历史种子数据补审与删除

预览：

```bash
npm run audit:library-delete -- --dry-run
```

真实执行：

```bash
npm run audit:library-delete
```

真实执行时需要输入 `DELETE` 二次确认。脚本会：

- 调用 DeepSeek 补审历史种子数据；
- 写入 `data/library-review.json`；
- 将审核删除词追加备份到 `data/deleted-words-backup.json`；
- 从 `data/words-data.json` 中真实删除审核不通过且不受保护的词；
- 自动运行 `npm run build:words`。
