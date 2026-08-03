using Lumina;
using Lumina.Data.Files;
using Lumina.Excel;

namespace CosmicDump;

/// <summary>
/// 從台服 client 解出渴望灣的地圖底圖與座標換算參數。
///
/// <para><b>為什麼要自己解</b>：生態內其他工具（sightseeing／treasure／macro-builder）一律 hotlink
/// xivapi 的底圖，但本站 `_headers` 的 CSP 是 `img-src 'self' data: &lt;portal&gt;`
/// ⇒ 外站圖床會被**靜默**擋掉。自己匯出是唯一能用的路。</para>
///
/// <para><b>欄位索引的依據</b>（2026-08-03 對台服 sqpack 離線驗證，`Map` 共 21 欄）：
/// <list type="bullet">
/// <item>c16 → <c>TerritoryType</c> row id。**全表只有這一欄出現過 1237**（渴望灣），
///   而渴望灣共 21 列＝各開發階段一張底圖。</item>
/// <item>c6（String）→ 地圖 Id（<c>c1w1/00</c>），底圖路徑 <c>ui/map/{Id}/{Id 去斜線}_m.tex</c>。</item>
/// <item>c7 → SizeFactor（渴望灣＝100）、c8/c9 → OffsetX/Y（渴望灣皆 0）。</item>
/// </list>
/// <b>被證偽的候選</b>：<c>TerritoryType.c26</c> 看起來就是 Map row id（1237 → 851，且 851 真的
/// 是一張地圖），但交叉驗證只有 1/522 指得回同一個 territory——它指到的是異聞六根山。
/// 這正是本 repo 鐵則 §2 說的那種錯：值合理、查得到、完全沒有訊號。</para>
/// </summary>
internal static class MapExporter
{
    /// <summary>渴望灣的 <c>TerritoryType</c> row id。</summary>
    private const uint SinusArdorum = 1237;

    /// <summary>
    /// 要用哪一張底圖。渴望灣 21 張＝**月球開發階段各一張**，差別只在建築物美術，
    /// 任務地點不隨階段移動。
    ///
    /// <para>「現在是第幾期」是**伺服器狀態，client 算不出來**（本站開發階段頁本來就要使用者
    /// 自己選期數），所以這裡不假裝推導得出來，直接取最後一張＝目前最完整的樣子。
    /// 覺得與遊戲內對不上就改這一個字串。</para>
    /// </summary>
    private const string PreferredMapId = "c1w1/21";

    /// <summary>
    /// 輸出邊長。站上是**小圖**（顯示寬 ~440px，Owner 2026-08-03），512 已經超過 1:1。
    ///
    /// <para>只能取 2048 的整除數（見 <see cref="Downscale"/>）：1024 實測 1.9 MB——
    /// 對一個靜態站來說那是整站最大的資產，而且它換不到任何看得出來的清晰度。</para>
    /// </summary>
    private const int OutputSize = 512;

    public sealed record MapInfo(uint MapRow, string MapId, int SizeFactor, int OffsetX, int OffsetY, int Size);

    /// <summary>
    /// 匯出底圖並回傳座標換算需要的參數；找不到就回 null（呼叫端負責讓流程失敗，不寫半殘品）。
    /// </summary>
    public static MapInfo? Export(GameData gd, string outPath)
    {
        var map = gd.Excel.GetSheet<RawRow>(name: "Map");

        RawRow? chosen = null;
        var candidates = 0;
        foreach (var row in map)
        {
            if (row.ReadUInt16Column(16) != SinusArdorum) continue;
            candidates++;
            if (row.ReadStringColumn(6).ExtractText() == PreferredMapId) chosen = row;
        }
        if (candidates == 0)
        {
            Console.Error.WriteLine($"  ✗ 地圖：Map 表找不到 territory {SinusArdorum} 的任何一列（欄位索引可能已隨改版失效）");
            return null;
        }
        if (chosen is null)
        {
            Console.Error.WriteLine($"  ✗ 地圖：territory {SinusArdorum} 有 {candidates} 列，但沒有 \"{PreferredMapId}\"（改版後 id 可能變了）");
            return null;
        }

        var m = chosen.Value;
        var mapId = m.ReadStringColumn(6).ExtractText();
        var texPath = $"ui/map/{mapId}/{mapId.Replace("/", "")}_m.tex";
        var tex = gd.GetFile<TexFile>(texPath);
        if (tex is null)
        {
            Console.Error.WriteLine($"  ✗ 地圖：{texPath} 讀不到");
            return null;
        }

        // Lumina 解出來是 B8G8R8A8，PNG 要 R8G8B8A8
        var src = tex.ImageData;
        var w = tex.Header.Width;
        var h = tex.Header.Height;
        var rgba = new byte[src.Length];
        for (var i = 0; i < src.Length; i += 4)
        {
            rgba[i] = src[i + 2];
            rgba[i + 1] = src[i + 1];
            rgba[i + 2] = src[i];
            rgba[i + 3] = src[i + 3];
        }

        var (outRgba, outW, outH) = w > OutputSize ? Downscale(rgba, w, h, OutputSize) : (rgba, w, h);

        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        var png = IconExporter.EncodePng(outRgba, outW, outH);
        File.WriteAllBytes(outPath, png);
        Console.WriteLine($"  ✓ 地圖底圖 {mapId}（{w}×{h} → {outW}×{outH}，{png.Length / 1024.0 / 1024:F1} MB）→ {outPath}");

        return new MapInfo(
            m.RowId, mapId,
            m.ReadUInt16Column(7), m.ReadInt16Column(8), m.ReadInt16Column(9), outW);
    }

    /// <summary>
    /// 整數倍降取樣（2048→1024＝每 2×2 取平均）。刻意只支援整除倍率：
    /// 為了一張底圖引進影像處理套件不划算，而任意倍率的縮放品質問題不是這裡該解的。
    /// </summary>
    private static (byte[] Rgba, int W, int H) Downscale(byte[] rgba, int w, int h, int target)
    {
        var factor = w / target;
        if (factor < 2 || w % target != 0 || h % target != 0) return (rgba, w, h);

        var outW = w / factor;
        var outH = h / factor;
        var dst = new byte[outW * outH * 4];
        var n = factor * factor;
        for (var y = 0; y < outH; y++)
        {
            for (var x = 0; x < outW; x++)
            {
                int r = 0, g = 0, b = 0, a = 0;
                for (var dy = 0; dy < factor; dy++)
                {
                    var srcRow = ((y * factor + dy) * w + x * factor) * 4;
                    for (var dx = 0; dx < factor; dx++)
                    {
                        var p = srcRow + dx * 4;
                        r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; a += rgba[p + 3];
                    }
                }
                var o = (y * outW + x) * 4;
                dst[o] = (byte)(r / n);
                dst[o + 1] = (byte)(g / n);
                dst[o + 2] = (byte)(b / n);
                dst[o + 3] = (byte)(a / n);
            }
        }
        return (dst, outW, outH);
    }
}
