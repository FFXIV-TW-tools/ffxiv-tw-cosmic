using System.Text.Json;
using System.Text.Json.Nodes;
using ICE.Utilities.TcSheets;
using Lumina;
using Lumina.Excel;

namespace CosmicDump;

/// <summary>把台服 client 的宇宙探索資料轉成網站吃的三份 JSON。每份自帶 meta（client 版本＋產生時間）。</summary>
internal sealed class Exporters(GameData gd, JsonObject meta)
{
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
            table.Add(new JsonObject { ["id"] = id, ["name"] = Name(id), ["rate"] = pct });

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
        var refinSheet = Sheet("WKSMissionToDoEvalutionRefin");
        var itemInfoSheet = Sheet("WKSItemInfo");
        var itemSheet = Sheet("Item");
        var weatherSheet = Sheet("Weather");
        var recipeSheet = Sheet("WKSMissionRecipe");

        var o = Wrap("544 筆渴望灣任務。conditions 為額外開放條件；type=unknown 者語意未定，刻意不猜。");
        o["conditions"] = Conditions(condSheet, weatherSheet);
        o["rankLabels"] = new JsonObject { ["1"] = "D", ["2"] = "C", ["3"] = "B", ["4"] = "A1", ["5"] = "A2", ["6"] = "A3" };

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
                // 遊戲內的三分類：基礎／臨時／緊急。緊急優先（它也在 c18=1 側）。
                ["class"] = unit.IsSpecialQuest ? "critical"
                          : TcCosmicSheets.IsBasic(row) ? "basic" : "temporary",
                ["timeLimit"] = (int)unit.MissionTime,
                ["silver"] = (int)unit.SilverStarRequirement,
                ["gold"] = (int)unit.GoldStarRequirement,
                ["cond"] = (int)unit.LotterySpecialCond,
                ["items"] = RequiredItems(todoSheet, itemInfoSheet, itemSheet, unit.MissionToDo),
                ["reward"] = Reward(rewardSheet, unit.RowId),
            };

            // 未定性欄位集中放在 _unverified，UI 不讀——留著是為了日後查核，不是給人看的。
            var unverified = new JsonObject();
            if (refinSheet.TryGetRow(unit.RowId, out var refin))
                unverified["evalThresholds"] = new JsonArray(TcCosmicSheets.EvalThresholds(refin).Select(v => (JsonNode)v).ToArray());
            if (unit.MissionRecipe != 0 && recipeSheet.TryGetRow(unit.MissionRecipe, out var rec))
                unverified["recipeIds"] = new JsonArray(Enumerable.Range(0, 5)
                    .Select(i => (int)rec.ReadUInt32Column(i)).Where(v => v > 0)
                    .Select(v => (JsonNode)v).ToArray());
            if (unverified.Count > 0) m["_unverified"] = unverified;

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

    private static JsonObject Conditions(ExcelSheet<RawRow> condSheet, ExcelSheet<RawRow> weatherSheet)
    {
        var conds = new JsonObject
        {
            ["0"] = new JsonObject { ["type"] = "none", ["label"] = "無條件" },
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

    private static JsonArray RequiredItems(ExcelSheet<RawRow> todoSheet, ExcelSheet<RawRow> itemInfoSheet,
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
            arr.Add(new JsonObject { ["itemId"] = (int)itemId, ["name"] = nm, ["qty"] = (int)qty });
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
