# dsh-auto-tool-prune

在每次 DSH 模型請求前，自動剪枝過大的工具回傳文字。支援並測試於 DeepSeek Harness `0.1.7-rc.2`，可以和 [dsh-turn-continuation](https://github.com/win10ogod/dsh-turn-continuation) 一起使用。

插件沿用 DSH 原生 `ToolResultPruner` 的替換與 token 記帳機制，把觸發時機提前到每個 `agent/pre-step`，不必等到上下文已接近上限。原始工具結果留在 append-only 會話紀錄；後續模型請求只看到適合裁切的純文字結果之剪枝版本。工具呼叫參數、schema、結果配對、錯誤狀態及非文字區塊保持原樣。

## 預設行為

- 合併工具結果中的文字超過 8,192 個 Unicode code points 時才剪枝。
- 保留前 4,096 與後 1,024 個字元，中間加入明確的剪枝標記。
- 不呼叫額外模型，不排入使用者訊息；已剪枝的結果不會在每步重複改寫。
- 完整保留 JSON、可辨識的 JSON 片段／JSON Lines、不完整 JSON、程式碼區塊與標記文件；不解析後重新序列化資料，因此不改變數值或字串表示。
- 預設完整保留 `skill`、`read`、`read_file`、`readFile` 的結果，避免裁掉指令或檔案中段。
- 剪枝發生故障時記錄警告，保留當下可用的歷史繼續執行，不以剪枝故障結束對話。

保留頭尾不等於語意摘要，中間內容會離開後續模型上下文。完整原文仍可由原始會話事件追溯。既有歷史壓縮與本插件可共存；插件建立獨立的 pruner 作用域，使用者原有的 compaction 設定不會被覆寫。

## 安裝與設定

使用 DSH 插件管理器安裝套件，或把它加入 profile 的 dependencies 與 `dsh.profile.bundles`。安裝後重新載入 profile。

```yaml
- id: auto-tool-prune
  name: dsh-auto-tool-prune
  config:
    enabled: true
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
    protectedTools: [skill, read, read_file, readFile]
```

頭部、剪枝標記與尾部長度的合計必須不超過 `thresholdChars`。不合法的配置會拒絕啟用。`protectedTools` 可加入其他須完整保留輸出的工具名稱；未知工具身分的歷史結果也保持完整。`enabled: false` 可單獨停用剪枝，不影響續跑插件。這些保護約束本插件的主動剪枝，其他已安裝的壓縮器仍遵守它們自己的設定。

## 驗證

```text
pnpm install --frozen-lockfile
pnpm check
```

測試掛載真實 DSH Agent loop、會話、token meter 與工具服務，以可控的模型回應驗證下一次請求實際看到剪枝內容，同時檢查原文仍在紀錄、工具配對、短結果、字元配置、取消、失敗回退及原有 pruner 作用域。

組合測試安裝已發布的 `dsh-turn-continuation`，驗證「工具結果剪枝 → 輸出截斷或待辦未完卻正常停止 → 同回合接續 → 後續工具操作 → 任務完成」。兩個插件均不變更模型路由或每次請求的輸出 token 上限。
