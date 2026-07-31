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

    /// <summary>天氣週期長度（秒）＝8 艾歐澤亞小時＝23 分 20 秒。</summary>
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

    /// <summary><c>WKSItemInfo</c> c0＝<c>Item</c> row id（ICE 已驗：103→月水盾草、366→月面隕石、372→月鉻鐵礦）。</summary>
    public static uint ItemInfoItemId(RawRow info) => info.ReadUInt32Column(0);

    /// <summary>
    /// <c>WKSMissionToDoEvalutionRefin</c>（544 列 × 3 欄）＝三段評價門檻，值如 20/40/70、50/60/85。
    /// <para>⚠ <b>語意未定性</b>：與 <c>WKSMissionUnit</c> 的銀星／金星（絕對分數，值域百～萬）不同量綱，
    /// 推測是百分比制的銅／銀／金三階，但<b>未經遊戲內核對</b>。故只落進 JSON 供日後查核、
    /// <b>不進網站 UI</b>（避免把未驗證的數字當事實展示）。</para>
    /// </summary>
    public static int[] EvalThresholds(RawRow refin)
        => [refin.ReadUInt16Column(0), refin.ReadUInt16Column(1), refin.ReadUInt16Column(2)];

    /// <summary>
    /// <c>WKSMissionUnit</c> c18＝<b>基礎任務旗標</b>（1＝基礎、0＝非基礎）。
    /// <para><b>反解依據</b>：與任務類型交叉後是完美二分——c18=1 共 264 筆，rank 全為 D/C/B，
    /// 且<b>全部 33 個緊急任務都在這側、零個高難</b>；c18=0 共 280 筆，rank 全為 A1/A2/A3，
    /// 含全部 96 個「高難」與 96 個「高難+」。264+280=544，分界恰好落在 B 與 A1 之間。</para>
    /// <para>為什麼不直接用 rank &gt;= 4 判斷（目前兩者等價）：這是<b>遊戲自己的分類欄</b>，
    /// 日後改版若把分界移動，跟著這欄走才會對；用 rank 推是我們的假設。
    /// 由來＝2026-07-31 Owner 指出「（A1 無條件的無人機任務）不是基礎任務，就要顯示」。</para>
    /// <para><b>遊戲的三分類</b>（Owner 2026-07-31 給的正名）＝基礎／臨時／緊急，
    /// 對到資料上是：緊急＝<c>IsSpecialQuest</c>（33，落在 c18=1 側）／
    /// 基礎＝c18=1 且非緊急（231）／臨時＝c18=0（280）。三者互斥且合計 544。</para>
    /// </summary>
    public static bool IsBasic(RawRow row) => row.ReadUInt8Column(18) == 1;

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
