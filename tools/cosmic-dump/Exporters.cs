using System.Text.Json;
using System.Text.Json.Nodes;
using ICE.Utilities.TcSheets;
using Lumina;
using Lumina.Excel;

namespace CosmicDump;

/// <summary>把台服 client 的宇宙探索資料轉成網站吃的三份 JSON。每份自帶 meta（client 版本＋產生時間）。</summary>
internal sealed class Exporters(GameData gd, JsonObject meta,
                                IReadOnlyDictionary<uint, uint> itemIcons,
                                IReadOnlyDictionary<uint, uint> weatherIcons)
{
    /// <summary>本次任務需求物實際用到的 icon id（Program 據此只匯出用得到的那些圖）。</summary>
    public HashSet<uint> UsedItemIcons { get; } = [];

    /// <summary>渴望灣三種天氣實際用到的 icon id。</summary>
    public HashSet<uint> UsedWeatherIcons { get; } = [];

    private ExcelSheet<RawRow> Sheet(string name) => gd.Excel.GetSheet<RawRow>(name: name);

    private JsonObject Wrap(string note) => new() { ["meta"] = meta.DeepClone(), ["_note"] = note };

    // ── 天氣 ────────────────────────────────────────────────────────────
    public JsonObject Weather()
    {
        var weather = Sheet("Weather");
        var rates = Sheet("WeatherRate");
        var territory = Sheet("TerritoryType").GetRow(TcCosmicSheets.SinusArdorumTerritory);
        var rateId = TcCosmicSheets.WeatherRateId(territory);

        string Name(int id) => weather.TryGetRow((uint)id, out var r) ? TcCosmicSheets.WeatherName(r) : $"#{id}";

        var table = new JsonArray();
        foreach (var (id, pct) in TcCosmicSheets.WeatherRates(rates.GetRow(rateId)))
        {
            var w = new JsonObject { ["id"] = id, ["name"] = Name(id), ["rate"] = pct };
            // 天氣圖示：遊戲本來就有，**不要拿 emoji 代替**（原本 UI 用 🌤💨🌘，是自己發明的，
            // Owner 2026-08-01 指正）。icon id 來自 global datamine 的 Weather sheet，
            // 與 Item.Icon 同樣**不猜台服 RawRow 欄位索引**——台服欄序與 global 定義對不上。
            if (weatherIcons.TryGetValue((uint)id, out var iconId))
            {
                w["icon"] = (int)iconId;
                UsedWeatherIcons.Add(iconId);
            }
            table.Add(w);
        }

        // 緊急事件天氣：掃全表確認它們不在任何 WeatherRate 內 ⇒ 時間演算法永遠擲不出來。
        var inAnyRate = new HashSet<int>();
        foreach (var r in rates)
            foreach (var (id, _) in TcCosmicSheets.WeatherRates(r))
                inAnyRate.Add(id);

        var emergency = new JsonArray();
        foreach (var r in weather)
        {
            var nm = TcCosmicSheets.WeatherName(r);
            if (nm is not ("磁暴" or "流星雨" or "孢子霧")) continue;
            if (inAnyRate.Contains((int)r.RowId)) continue;   // 137 流星雨在 rate#125，屬別區的一般天氣
            emergency.Add(new JsonObject { ["id"] = (int)r.RowId, ["name"] = nm });
        }

        var o = Wrap("渴望灣天氣＝純時間函數，全伺服器同步；緊急事件天氣不在任何 WeatherRate 內＝伺服器推播，無法離線推算。");
        o["zone"] = new JsonObject
        {
            ["territoryId"] = (int)TcCosmicSheets.SinusArdorumTerritory,
            ["name"] = "渴望灣",
            ["weatherRateId"] = (int)rateId,
        };
        o["periodSeconds"] = TcCosmicSheets.WeatherPeriodSeconds;
        o["table"] = table;
        o["emergencyWeathers"] = emergency;
        return o;
    }

    // ── 任務 ────────────────────────────────────────────────────────────
    public JsonObject Missions(IReadOnlyDictionary<uint, JsonObject> jobs)
    {
        var unitSheet = Sheet("WKSMissionUnit");
        var todoSheet = Sheet("WKSMissionToDo");
        var rewardSheet = Sheet("WKSMissionReward");
        var condSheet = Sheet("WKSMissionLotterySpecialCond");
        var itemInfoSheet = Sheet("WKSItemInfo");
        var itemSheet = Sheet("Item");
        var weatherSheet = Sheet("Weather");
        var recipeSheet = Sheet("WKSMissionRecipe");
        var markerSheet = Sheet("WKSMissionMapMarker");

        var o = Wrap("544 筆渴望灣任務。conditions 為額外開放條件；type=unknown 者語意未定，刻意不猜。");
        o["conditions"] = Conditions(condSheet, weatherSheet);
        // 兩個條件槽的組合邏輯＝**同類型 OR、跨類型 AND**（requirement-group）。
        // 依據：① 11 筆兩槽都是互斥 ET 時段，純 AND 不可滿足 ⇒ 同類型必為 OR
        //       ② Owner 2026-07-31 靈風時段實測，ET＋天候的 3 筆在天候開著、ET 未到時
        //          **不在板上** ⇒ 跨類型必為 AND。兩項證據只有分維度處理才同時成立。
        o["condLogic"] = "and";
        o["condLogicVerified"] = true;
        // 階級標籤用遊戲自己的說法：rank 1–4＝無前綴的 D/C/B/A（基礎分頁），5/6＝【高難】/【高難+】（臨時分頁）。
        o["rankLabels"] = new JsonObject { ["1"] = "D", ["2"] = "C", ["3"] = "B", ["4"] = "A", ["5"] = "高難", ["6"] = "高難+" };
        // 分頁名與子標籤全部用 client 原文，並記下 Addon row id 供改版後回頭核對。
        o["classLabels"] = new JsonObject { ["basic"] = "基礎任務", ["temporary"] = "臨時任務", ["critical"] = "緊急任務" };
        o["tagLabels"] = new JsonObject { ["sequential"] = "連續任務", ["time"] = "時間限定任務", ["weather"] = "天氣限定任務" };
        o["_addonRows"] = new JsonObject
        {
            ["基礎任務"] = 16748, ["臨時任務"] = 16749, ["緊急任務"] = 16750,
            ["連續任務"] = 16871, ["時間限定任務"] = 16872, ["天氣限定任務"] = 16873,
        };

        var list = new JsonArray();
        foreach (var row in unitSheet)
        {
            var unit = new TcMissionUnit(row);
            var name = CleanName(unit.Name.ExtractText());
            if (name.Length == 0) continue;

            var jobIds = new JsonArray { (int)unit.JobCategoryPrimary - 1 };
            if (unit.JobCategorySecondary != 0) jobIds.Add((int)unit.JobCategorySecondary - 1);

            var m = new JsonObject
            {
                ["id"] = (int)unit.RowId,
                ["name"] = name,
                ["jobs"] = jobIds,
                ["rank"] = (int)unit.LevelGroup,
                ["critical"] = unit.IsSpecialQuest,
                // 遊戲的三個分頁：基礎（D/C/B/A）／臨時（高難、高難+）／緊急。
                ["class"] = TcCosmicSheets.MissionClass(row),
                // 遊戲在臨時任務上加的子標籤（可同時成立，例如「連續任務」＋「時間限定任務」）。
                ["tags"] = Tags(row, condSheet),
                // 前置任務（c16，0＝無）。有值＝遊戲的「連續任務」，要先完成它才會出現。
                ["prereq"] = (int)TcCosmicSheets.Prerequisite(row),
                ["timeLimit"] = (int)unit.MissionTime,
                ["silver"] = (int)unit.SilverStarRequirement,
                ["gold"] = (int)unit.GoldStarRequirement,
                // 條件＝ICE 的 LotterySpecialCond（col[15]）。每個任務最多一個。
                // 仍用陣列是因為 UI 已按陣列寫，且日後若解出 col[14] 語意可直接擴充。
                ["conds"] = TcCosmicSheets.Condition(row) is var cond && cond != 0
                    ? new JsonArray((JsonNode)(int)cond)
                    : new JsonArray(),
                /*
                 * col[14] 非零（119 筆）。**不再拿它當條件**（欄位對照已修正為 col[15]），
                 * 但實測顯示它與「任務會不會出現」仍高度相關，語意未知 ⇒ 只輸出、不判定。
                 */
                ["c14"] = (int)TcCosmicSheets.SlotUnknown(row),
                ["items"] = RequiredItems(todoSheet, itemInfoSheet, itemSheet, unit.MissionToDo),
                // 任務地點（世界座標 X/Z ＋ 半徑）。**不是顯示用的裝飾**——ICE 就是拿它當
                // 採集路線的查詢 key（`TcMissionToDo.MapMarker` 的反解依據：108 筆採集任務
                // 全部命中、產生的相異座標數恰好等於路線檔數）。沒有 marker 的任務輸出 null，
                // 不補 0：這批 sheet 裡 0 是有意義的哨兵值（AGENTS 鐵則 §2 的由來）。
                ["marker"] = Marker(todoSheet, markerSheet, unit.MissionToDo),
                ["reward"] = Reward(rewardSheet, unit.RowId),
                // 製作類任務要做的配方（`Recipe` row id，最多 5 個；採集/釣魚任務為空陣列）。
                // 用途＝深連結到 crafter 求解手法。三段品質門檻**不在這裡**：那是配方的屬性
                // （一般收藏品也有），權威在 monorepo game_ref 的 recipe_quality_stages。
                ["recipes"] = MissionRecipes(recipeSheet, unit.MissionRecipe),
            };

            list.Add(m);
        }

        o["missions"] = list;
        o["jobs"] = new JsonObject(jobs.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key.ToString(), kv.Value.DeepClone())));
        return o;
    }

    /// <summary>
    /// 任務名前面帶一個**私用區（U+E000–U+F8FF）字元**＝遊戲內的職業圖示 glyph（如 U+E0BE），
    /// 在瀏覽器沒有對應字型、只會渲染成豆腐。職業本來就另有欄位承載 ⇒ 一律剝掉。
    /// </summary>
    private static string CleanName(string raw)
    {
        var s = raw.Replace("<nbsp>", " ").Replace("<->", "");
        var buf = new System.Text.StringBuilder(s.Length);
        foreach (var c in s)
            if (c is < '\uE000' or > '\uF8FF') buf.Append(c);
        return buf.ToString().Trim();
    }

    /// <summary>
    /// 遊戲替任務掛的子標籤。三個都是**可同時成立**的旗標，不是互斥分類——
    /// 例如「【高難+】製作月球車所需的貨物包裝材料」同時是連續任務與時間限定任務（44 筆屬此類）。
    ///
    /// <para><b>只掛在臨時任務上</b>（Owner 2026-07-31：「臨時任務才有那三個子標籤」）。
    /// 基礎任務與緊急任務即使有時段／天候條件也不掛——條件本身照樣出現在
    /// <c>conds</c> 欄與清單的「開放條件」欄，只是遊戲不用這三個標籤稱呼它們。</para>
    /// </summary>
    private static JsonArray Tags(RawRow row, ExcelSheet<RawRow> condSheet)
    {
        var tags = new JsonArray();
        if (TcCosmicSheets.MissionClass(row) != "temporary") return tags;
        if (TcCosmicSheets.Prerequisite(row) != 0) tags.Add("sequential");
        var hasTime = false;
        var hasWeather = false;
        foreach (var id in new[] { TcCosmicSheets.Condition(row) }.Where(x => x != 0))
        {
            if (!condSheet.TryGetRow(id, out var c)) continue;
            var (_, end, weatherId) = TcCosmicSheets.SpecialCond(c);
            if (weatherId != 0) hasWeather = true;
            else if (end != 0) hasTime = true;
        }
        if (hasTime) tags.Add("time");
        if (hasWeather) tags.Add("weather");
        return tags;
    }

    private static JsonObject Conditions(ExcelSheet<RawRow> condSheet, ExcelSheet<RawRow> weatherSheet)
    {
        var conds = new JsonObject
        {
            // ⚠ 標籤刻意不叫「無條件」——它只代表 client 的兩個條件槽是空的（沒有時段/天候閘），
            // 不代表「你現在看得到」。階級門、前置任務鏈（LockedBehind 未定性）、抽選門都還在。
            ["0"] = new JsonObject { ["type"] = "none", ["label"] = "不限時" },
        };
        foreach (var row in condSheet)
        {
            if (row.RowId == 0) continue;
            var (start, end, weatherId) = TcCosmicSheets.SpecialCond(row);
            JsonObject entry;
            if (weatherId != 0)
            {
                var nm = weatherSheet.TryGetRow((uint)weatherId, out var w) ? TcCosmicSheets.WeatherName(w) : $"#{weatherId}";
                entry = new JsonObject { ["type"] = "weather", ["weatherId"] = weatherId, ["label"] = $"天候：{nm}" };
            }
            else if (end != 0)
            {
                entry = new JsonObject
                {
                    ["type"] = "time",
                    ["start"] = start,
                    ["end"] = end,
                    ["label"] = $"艾歐澤亞時間 {start:00}:00–{end:00}:00",
                };
            }
            else
            {
                // 三欄全零。台服 client 就是空的——不是讀錯，是這版沒填。
                entry = new JsonObject { ["type"] = "unknown", ["label"] = "條件未定" };
            }
            conds[row.RowId.ToString()] = entry;
        }
        return conds;
    }

    /// <summary>
    /// <c>WKSMissionRecipe</c> c0–c4＝該任務要做的 <c>Recipe</c> row id（0＝空槽）。
    /// 採集／釣魚任務的 <c>MissionRecipe</c> 為 0 ⇒ 回空陣列。
    /// </summary>
    private static JsonArray MissionRecipes(ExcelSheet<RawRow> recipeSheet, uint missionRecipeId)
    {
        var arr = new JsonArray();
        if (missionRecipeId == 0 || !recipeSheet.TryGetRow(missionRecipeId, out var rec)) return arr;
        for (var i = 0; i < 5; i++)
        {
            var id = rec.ReadUInt32Column(i);
            if (id > 0) arr.Add((JsonNode)(int)id);
        }
        return arr;
    }

    /// <summary>
    /// 任務地點 → <c>{x, y, r}</c>（世界座標與半徑，直接取自 <c>WKSMissionMapMarker</c>）。
    ///
    /// <para>刻意**不在這裡換算成地圖座標**：換算要 <c>Map.SizeFactor/Offset</c>，那是消費端
    /// 畫圖時的事，而且台服 <c>Map</c> 的欄序尚未驗過（鐵則：不猜 RawRow 欄位索引）。
    /// 這一層只負責把 client 裡的原值搬出來。</para>
    /// </summary>
    private static JsonNode? Marker(ExcelSheet<RawRow> todoSheet, ExcelSheet<RawRow> markerSheet, uint todoId)
    {
        if (todoId == 0 || !todoSheet.TryGetRow(todoId, out var todoRow)) return null;
        var markerId = new TcMissionToDo(todoRow).MapMarker;
        if (markerId == 0 || !markerSheet.TryGetRow(markerId, out var markerRow)) return null;
        var mk = new TcMissionMapMarker(markerRow);
        return new JsonObject { ["x"] = mk.X, ["y"] = mk.Y, ["r"] = mk.Radius };
    }

    private JsonArray RequiredItems(ExcelSheet<RawRow> todoSheet, ExcelSheet<RawRow> itemInfoSheet,
                                           ExcelSheet<RawRow> itemSheet, uint todoId)
    {
        var arr = new JsonArray();
        if (todoId == 0 || !todoSheet.TryGetRow(todoId, out var todoRow)) return arr;
        var todo = new TcMissionToDo(todoRow);
        for (var i = 0; i < 3; i++)
        {
            var infoId = todo.RequiredItem(i);
            var qty = todo.RequiredItemQuantity(i);
            if (infoId == 0 || qty == 0) continue;
            if (!itemInfoSheet.TryGetRow(infoId, out var info)) continue;
            var itemId = TcCosmicSheets.ItemInfoItemId(info);
            var nm = itemSheet.TryGetRow(itemId, out var it) ? TcCosmicSheets.ItemName(it) : "";
            if (nm.Length == 0) continue;
            var o = new JsonObject { ["itemId"] = (int)itemId, ["name"] = nm, ["qty"] = (int)qty };
            // icon 缺就不寫欄位（UI 端自己退成無圖），不要塞 0 冒充——那會變成「找不到 000000.png」的破圖
            if (itemIcons.TryGetValue(itemId, out var iconId))
            {
                o["icon"] = (int)iconId;
                UsedItemIcons.Add(iconId);
            }
            arr.Add(o);
        }
        return arr;
    }

    private static JsonObject Reward(ExcelSheet<RawRow> rewardSheet, uint missionId)
    {
        var o = new JsonObject { ["cosmo"] = 0, ["lunar"] = 0, ["relic"] = new JsonArray() };
        if (!rewardSheet.TryGetRow(missionId, out var row)) return o;
        var r = new TcMissionReward(row);
        o["cosmo"] = (int)r.CosmoCredit;
        o["lunar"] = (int)r.LunarCredit;
        var relic = new JsonArray();
        for (var i = 0; i < 3; i++)
        {
            var lv = r.RelicLevel(i);
            var exp = r.RelicExp(i);
            if (lv == 0 || exp == 0) continue;
            relic.Add(new JsonObject { ["level"] = lv, ["exp"] = exp });
        }
        o["relic"] = relic;
        return o;
    }

    // ── 宇宙工具（月球武器）────────────────────────────────────────────
    public JsonObject CosmicTools(IReadOnlyDictionary<uint, JsonObject> jobs)
    {
        var clsSheet = Sheet("WKSCosmoToolClass");
        var itemSheet = Sheet("Item");

        string Name(uint id) => itemSheet.TryGetRow(id, out var it) ? TcCosmicSheets.ItemName(it) : "";

        var chains = new JsonArray();
        foreach (var row in clsSheet)
        {
            if (row.RowId == 0) continue;
            var jobId = 7 + row.RowId;               // row1=木工師(8) … row11=漁師(18)
            var stages = new JsonArray();
            foreach (var itemId in TcCosmicSheets.ToolStages(row))
            {
                var nm = Name(itemId);
                if (nm.Length == 0) continue;
                stages.Add(new JsonObject { ["itemId"] = (int)itemId, ["name"] = nm });
            }
            if (stages.Count == 0) continue;

            // 後續 5 階在台服 7.2 名稱全空＝尚未實裝。只記數量，不編造名字。
            var unreleased = TcCosmicSheets.ToolStages(row, unreleased: true).Count(id => Name(id).Length == 0);

            chains.Add(new JsonObject
            {
                ["jobId"] = (int)jobId,
                ["job"] = jobs.TryGetValue(jobId, out var j) ? j["label"]?.DeepClone() : null,
                ["stages"] = stages,
                ["unreleasedStages"] = unreleased,
            });
        }

        var o = Wrap("宇宙工具升級鏈：原型 v0.1→v0.8→成品共 9 階。unreleasedStages ＝台服尚未實裝的後續階數（名稱在 client 內為空）。");
        o["chains"] = chains;
        return o;
    }

    // ── 月門基地開發階段（每個伺服器各自累積的進度）──────────────────
    public JsonObject DevStages(IEnumerable<string> worlds)
    {
        var dev = Sheet("WKSDevGrade");
        var trailStr = Sheet("WKSPioneeringTrailString");
        var trail = gd.Excel.GetSubrowSheet<RawSubrow>(name: "WKSPioneeringTrail");

        // 施工階段：只取有標題的（其餘是空列）
        var stages = new JsonArray();
        foreach (var r in dev)
        {
            var (title, grade, seq) = TcCosmicSheets.DevStage(r);
            if (title.Length == 0) continue;
            stages.Add(new JsonObject
            {
                ["id"] = (int)r.RowId,
                ["grade"] = grade,
                ["seq"] = seq,
                ["title"] = title,
                ["milestone"] = title.Contains("竣工") || title.Contains("圓滿完成"),
            });
        }

        // 「第 N 期」→ 起始施工階段
        var phases = new JsonArray();
        foreach (var group in trail)
            foreach (var sub in group)
            {
                var (fromGrade, phase) = TcCosmicSheets.TrailEntry(sub);
                if (phase == 0) continue;
                var title = trailStr.TryGetRow((uint)phase, out var ts) ? ts.ReadStringColumn(1).ExtractText() : "";
                if (title.Length == 0) continue;
                phases.Add(new JsonObject { ["phase"] = phase, ["title"] = title, ["fromStage"] = fromGrade });
            }

        var o = Wrap("月門基地開發階段。client 只有「有哪些階段」；「你的伺服器在第幾期」是伺服器狀態、離線不可知，需使用者自行輸入。");
        o["worlds"] = new JsonArray(worlds.Select(w => (JsonNode)w).ToArray());
        o["phases"] = phases;
        o["stages"] = stages;
        return o;
    }

    public static void Write(string path, JsonObject payload)
    {
        var json = payload.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        File.WriteAllText(path, json + "\n");
        Console.WriteLine($"  ✓ {Path.GetFileName(path),-22} {new FileInfo(path).Length / 1024.0,7:F1} KB");
    }
}
