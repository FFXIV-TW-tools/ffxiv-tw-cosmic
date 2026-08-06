using ICE.Utilities.TcSheets;
using Lumina.Excel;

namespace CosmicDump;

/// <summary>
/// 台服（7.2 client）宇宙探索相關 sheet 的欄位索引層——**只放 ICE fork 沒有的那幾張**。
/// 任務三表（<c>WKSMissionUnit</c> / <c>WKSMissionToDo</c> / <c>WKSMissionReward</c>）的定義
/// 由 csproj 直接編譯 ICE 那份唯一來源，本檔不重複（見 csproj 的 DRY 註解）。
///
/// <para>共通理由：台服 client 是 7.2、Lumina 附帶的 sheet 定義是 7.3 世代，
/// 直接用 typed sheet 會**靜默錯位**讀到別欄的位元組。故一律 <see cref="RawRow"/> ＋欄位索引直取。</para>
/// </summary>
internal static class TcCosmicSheets
{
    /// <summary>渴望灣（Sinus Ardorum）的 TerritoryType row id。ICE 亦硬編此值。</summary>
    public const uint SinusArdorumTerritory = 1237;

    /// <summary>天氣週期長度（秒）＝8 艾奧傑亞小時＝23 分 20 秒。</summary>
    public const int WeatherPeriodSeconds = 1400;

    /// <summary><c>TerritoryType</c> c12＝<c>WeatherRate</c> row id。
    /// 驗證：全 1234 列無一越界（WeatherRate 172 列），且中薩納蘭／摩杜納解出的天氣分布
    /// 與既有 <c>ffxiv-tw-sightseeing/modules/weather.js</c> 手打表逐項一致。</summary>
    public static uint WeatherRateId(RawRow territory) => territory.ReadUInt8Column(12);

    /// <summary><c>Weather</c> c1＝名稱（繁中）。</summary>
    public static string WeatherName(RawRow weather) => weather.ReadStringColumn(1).ExtractText();

    /// <summary><c>Item</c> c9＝名稱（繁中）。</summary>
    public static string ItemName(RawRow item) => item.ReadStringColumn(9).ExtractText();

    /// <summary>
    /// <c>WeatherRate</c> 的 16 欄是 <b>(天氣 id, 機率%) 交錯</b>共 8 組。
    /// 驗證：全 172 列中 171 列機率總和恰為 100（唯一例外 row 142＝90，該列本就是廢列）。
    /// </summary>
    public static IEnumerable<(int WeatherId, int Rate)> WeatherRates(RawRow rate)
    {
        for (var i = 0; i < 16; i += 2)
        {
            var pct = rate.ReadUInt8Column(i + 1);
            if (pct > 0) yield return (rate.ReadInt32Column(i), pct);
        }
    }

    /// <summary>
    /// <c>WKSMissionLotterySpecialCond</c>（23 列 × 3 欄）＝任務的額外開放條件。
    /// c0/c1＝起訖（成對階梯 0-2, 2-4 … 22-24，共 12 列）；c2＝天氣 id（僅 row 13＝49 靈風、row 14＝148 月塵）。
    /// <para>⚠ c2 解出的兩個值<b>恰好就是渴望灣天氣表裡的兩個非「晴朗」天氣</b>（WeatherRate#169
    /// ＝月塵 15%／晴朗 70%／靈風 15%）——2/2 命中是此欄為天氣 FK 的關鍵佐證。</para>
    /// <para>row 15/16 在台服 client <b>三欄全為 0</b>（上游國際服把它們當 Clouds/Rain，
    /// 但渴望灣天氣表根本沒有這兩種天氣）⇒ 語意未定，一律標 unknown，<b>不猜</b>。</para>
    /// </summary>
    public static (int Start, int End, int WeatherId) SpecialCond(RawRow cond)
        => (cond.ReadUInt8Column(0), cond.ReadUInt8Column(1), cond.ReadUInt16Column(2));

    /// <summary>
    /// 任務的開放條件——**直接用 ICE fork 的 <c>TcMissionUnit.LotterySpecialCond</c>**，
    /// 本檔不再自己定義。這正是 csproj 編譯 ICE 那份唯一來源的用意：欄位對照只能有一份，
    /// 抄第二份的代價就是這輪踩到的——ICE 把它對到 col[14]（錯），網站照抄，兩邊一起錯，
    /// 而且錯得一模一樣所以互相驗不出來。
    ///
    /// <para>正解是 <b>col[15]</b>，已於 2026-08-01 在 ICE fork 修正；證據＝ICE 內部
    /// 依遊戲內觀察手建的 <c>SinusMapV2</c> 與 col[15] <b>22/22 吻合、與 col[14] 零筆吻合</b>。</para>
    ///
    /// <para>每個任務**最多一個條件**，所以沒有 AND/OR 可言。先前為了兜住「兩個槽」的觀察，
    /// 在 AND 與 OR 之間來回翻案五次——全部是在錯誤的欄位對照上做推理。</para>
    /// </summary>
    public static uint Condition(RawRow unit) => new TcMissionUnit(unit).LotterySpecialCond;

    /// <summary>col[14]（語意未定）——只給 <c>tools/compare-board-log.mjs</c> 的相關性檢定用。</summary>
    public static uint SlotUnknown(RawRow unit) => new TcMissionUnit(unit).SlotUnknown;

    /// <summary><c>WKSItemInfo</c> c0＝<c>Item</c> row id（ICE 已驗：103→月水盾草、366→月面隕石、372→月鉻鐵礦）。</summary>
    public static uint ItemInfoItemId(RawRow info) => info.ReadUInt32Column(0);

    /*
     * 三段品質門檻**刻意不在這裡產**（2026-08-01 移除 EvalThresholds）。
     *
     * 原本 Exporters 以 `refinSheet.TryGetRow(unit.RowId)` 取 `WKSMissionToDoEvalutionRefin`
     * ——**那是錯的 join**。該表有 798 列、不是按任務 id 編的；真正的鍵是**配方**的
     * `Recipe.CollectableMetadata`（且需 `CollectableMetadataKey == 7` 才指向這張表）。
     * 兩邊值域剛好重疊（都落在 1–791），所以每筆都查得到、看起來完全正常；又因為 798 列裡
     * 只有 12 種相異組合、最常見的 50/60/85 佔三分之一，錯的 join 還有可觀比例會意外對上。
     * 零錯誤訊號 + 正確率高到不會被質疑 —— 與 col[14]/col[15] 同一種失敗形狀。
     *
     * 且這件事本來就不歸本站管：品質門檻是**配方**的屬性（一般收藏品也有同型欄位），
     * 權威＝monorepo `game_ref.sqlite` 的 `recipe_quality_stages`，消費端是 crafter。
     * 本站只負責回答「這個任務要哪些配方」（`recipes` 欄），換算與呈現交給 crafter。
     */

    /// <summary>
    /// 遊戲自己的三個分頁。原文出自 <c>Addon</c>#16748「基礎任務」／#16749「臨時任務」／#16750「緊急任務」。
    ///
    /// <para><b>判準＝rank，不是 c18</b>。原本拿 c18 當「基礎旗標」是錯的：交叉表顯示
    /// c18=1 ⇔ rank≤3 完全等價 ⇒ 該欄沒帶任何獨立資訊，只是把 rank 4（A）誤推到臨時側。</para>
    ///
    /// <para><b>正確分界的決定性證據＝任務名前綴，零例外</b>：無前綴 352 筆
    /// ＝rank D 99／C 77／B 88／<b>A 88</b>；【高難】96 筆全 rank 5；【高難+】96 筆全 rank 6。
    /// 也就是 <b>A 仍是無前綴的字母階、與 D/C/B 同群</b>，對上 Owner 2026-07-31 的遊戲內回報
    /// 「基礎任務才有分 D C B A」。</para>
    ///
    /// <para><b>⚠ 但 rank 不是唯一判準（2026-08-01 修）</b>：Owner 在遊戲內看到
    /// #400「採集精密空氣淨化裝置所需的材料」（rank A、無前綴、ET 02:00–04:00）
    /// 出現在<b>臨時任務</b>分頁。交叉表顯示 rank 4 裡「有條件或前置」的**剛好就是 11 筆**，
    /// 全是 ET 條件任務 ⇒ <b>有子標籤（條件／前置）就進臨時分頁，與階級無關</b>。
    /// 這也對得上 Owner 最初的描述「臨時任務底下再分 連續／時間限定／天氣限定」——
    /// 子標籤是臨時分頁的定義，不是附加屬性。</para>
    ///
    /// <para>故：緊急＝<see cref="IsCritical"/>（33，全 rank D）／
    /// 臨時＝rank≥5 <b>或</b>帶條件／前置（192＋11＝203）／基礎＝其餘（308）。</para>
    ///
    /// <para><b>殘留未定</b>：52 筆【高難】既無條件也無前置。名稱前綴說它們不是 D/C/B/A 那群，
    /// 故仍歸臨時；但「臨時分頁的每一筆都有子標籤」若成立，它們就該另有歸屬。
    /// 沒有遊戲內觀察前不動它們。</para>
    /// </summary>
    public static string MissionClass(RawRow row)
    {
        if (IsCritical(row)) return "critical";
        if (row.ReadUInt8Column(6) >= 5) return "temporary";
        // 帶條件或前置＝有子標籤 ⇒ 臨時分頁（實測：#400 rank A + ET 條件出現在臨時分頁）
        return Condition(row) != 0 || Prerequisite(row) != 0 ? "temporary" : "basic";
    }

    /// <summary><c>WKSMissionUnit</c> c5＝緊急任務旗標。33 筆，全為 rank D。</summary>
    public static bool IsCritical(RawRow row) => row.ReadPackedBoolColumn(5);

    /// <summary>
    /// <c>WKSMissionUnit</c> c16＝<b>前置任務</b>（0＝無）。這就是上游 ICE 一直填 0 的 <c>LockedBehind</c>，
    /// 也是遊戲「連續任務」（<c>Addon</c>#16871）的資料來源；遊戲的門檻提示＝#16777「完成以下任務」。
    ///
    /// <para><b>反解依據</b>（88 筆非零，三項同時成立才採信）：
    /// ① 指向的任務<b>與本任務同職業 88/88</b>——其餘候選欄差得遠（c1 47/544、c17 4/448）；
    /// ② 名稱語意直接對得上，且遊戲自己在名字裡寫了「續·」：
    /// 「【高難】續·製作傳動用的長桿」→ #33「製作傳動用的長桿」(A)、
    /// 「【高難+】製作月球車所需的貨物包裝材料」→ #41「【高難】續·製作貨物包裝材料」(高難)；
    /// ③ 全部落在 rank 5/6（高難 33 ＋ 高難+ 55）＝連續任務只出現在臨時分頁，與遊戲一致。</para>
    ///
    /// <para>鏈條可多層：A → 高難 → 高難+。</para>
    /// </summary>
    public static uint Prerequisite(RawRow row) => row.ReadUInt16Column(16);

    /// <summary>
    /// <c>WKSDevGrade</c>（134 列）＝月門基地的建設階段。c1＝短標題、c5＝基地等級、c7＝階段序。
    /// <para><b>這是每個伺服器各自累積的進度</b>，不是全服同步的東西——同一時刻伊弗利特與利維坦
    /// 可以在不同階段。client 只有「有哪些階段」，「你的伺服器在第幾階段」是伺服器狀態、離線不可知。</para>
    /// </summary>
    public static (string Title, int Grade, int Seq) DevStage(RawRow row)
        => (row.ReadStringColumn(1).ExtractText(), row.ReadUInt8Column(5), row.ReadUInt8Column(7));

    /// <summary>
    /// <c>WKSPioneeringTrail</c>（subrow）＝遊戲內「第 N 期」開拓紀錄。
    /// c0＝該期起始的 <c>WKSDevGrade</c> row id、c3＝期數（對應 <c>WKSPioneeringTrailString</c> 的 row id）。
    /// <para>驗證：c3 逐列 1..16 遞增，且 c0 指到的 DevGrade 列<b>全部都是「…竣工」節點</b>
    /// （4＝二級基地竣工、8＝宇宙快線內環線竣工、14＝居住艙&amp;宇宙港竣工…），
    /// 與 <c>WKSPioneeringTrailString</c> 的期標題語意逐項吻合（第2期「擴建月門基地」↔ 二級基地竣工）。</para>
    /// </summary>
    public static (int FromDevGrade, int Phase) TrailEntry(RawSubrow row)
        => (row.ReadUInt16Column(0), row.ReadUInt16Column(3));

    /// <summary>
    /// <c>WKSCosmoToolClass</c>（12 列 × 59 欄）＝宇宙工具（月球武器）升級鏈。
    /// c14..c22＝9 個 <c>Item</c> row id（原型 v0.1 → v0.8 → 成品）；c23..c27＝後續 5 階
    /// （台服 7.2 <b>名稱全空＝尚未實裝</b>）。
    /// <para>列序對應職業：row N → ClassJob id (7+N)，即 row1=木工師(8) … row11=漁師(18)。
    /// 佐證＝解出的道具名逐職吻合（row1 手鋸／row2 橫頭錘／row5 圓革刀＝皮革師），
    /// 且 <c>WKSCosmoToolName</c> 1001 起亦以同順序每職 4 筆排列。</para>
    /// </summary>
    public static IEnumerable<uint> ToolStages(RawRow cls, bool unreleased = false)
    {
        var (from, count) = unreleased ? (23, 5) : (14, 9);
        for (var i = from; i < from + count; i++)
        {
            var id = cls.ReadInt32Column(i);
            if (id > 0) yield return (uint)id;
        }
    }
}
