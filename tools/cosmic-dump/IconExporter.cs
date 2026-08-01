using System.IO.Compression;
using Lumina;
using Lumina.Data.Files;

namespace CosmicDump;

/// <summary>
/// 從台服 client 解出 11 個 DoH/DoL 職業圖示存成 PNG。
///
/// <para><b>為什麼要自己解</b>：生態內只有 mit-planner 的 21 個戰鬥職圖示，沒有 DoH/DoL；
/// 而 `_headers` 的 CSP 是 `img-src 'self' data: <portal>` ⇒ **不能**直接連 xivapi 之類的外站圖床
/// （會被擋掉，而且是靜默的破圖）。</para>
///
/// <para><b>為什麼自己寫 PNG 編碼</b>：只為了存 11 張 40×40 的圖去背 System.Drawing.Common
/// （Windows-only、還要多一個套件）不划算；PNG 的最小合法形式就是
/// 簽章 + IHDR + IDAT(zlib) + IEND，.NET 內建 <see cref="ZLibStream"/> 已經涵蓋壓縮那段。</para>
/// </summary>
internal static class IconExporter
{
    public static int Export(GameData gd, IReadOnlyDictionary<uint, (string Abbr, uint IconId)> jobs, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var written = 0;

        foreach (var (_, job) in jobs)
        {
            var tex = LoadIcon(gd, job.IconId);
            if (tex is null)
            {
                Console.Error.WriteLine($"  ✗ {job.Abbr}：找不到圖示 {job.IconId}");
                continue;
            }

            var path = Path.Combine(outDir, $"{job.Abbr}.png");
            File.WriteAllBytes(path, EncodePng(tex.Value.Rgba, tex.Value.Width, tex.Value.Height));
            written++;
        }

        Console.WriteLine($"  ✓ 職業圖示 {written}/{jobs.Count} → {outDir}");
        return written;
    }

    /// <summary>
    /// 匯出任務需求物的圖示，檔名＝icon id（<c>img/items/038246.png</c>）。
    ///
    /// <para>只匯出**這次真的用到**的那些（由 <c>Exporters.UsedItemIcons</c> 給），
    /// 不是整個 Item sheet——後者是四萬多張圖，對一個靜態站沒有意義。</para>
    ///
    /// <para>icon id 的來源是 monorepo 的 <c>item_lookup.sqlite</c>，**不是**猜 Lumina 的
    /// Item sheet 欄位索引（台服欄序與 global 定義對不上，猜錯只會靜默匯出不相干的圖）。</para>
    ///
    /// <para>用低解析版（40×40）：站上顯示只有 20px，`_hr1` 是四倍面積、對 399 張圖是白付的體積。</para>
    /// </summary>
    public static int ExportItems(GameData gd, IEnumerable<uint> iconIds, string outDir, string label = "需求物圖示")
    {
        Directory.CreateDirectory(outDir);
        var written = 0;
        var missing = new List<uint>();
        foreach (var id in iconIds)
        {
            var tex = LoadIcon(gd, id, preferHighRes: false);
            if (tex is null) { missing.Add(id); continue; }
            File.WriteAllBytes(Path.Combine(outDir, $"{id:D6}.png"),
                EncodePng(tex.Value.Rgba, tex.Value.Width, tex.Value.Height));
            written++;
        }
        var note = missing.Count > 0 ? $"（client 內找不到 {missing.Count} 張：{string.Join(",", missing.Take(5))}…）" : "";
        Console.WriteLine($"  ✓ {label} {written} 張 → {outDir}{note}");
        return written;
    }

    /// <summary>圖示路徑慣例：`ui/icon/{千位資料夾}/{id}.tex`；優先取 `_hr1` 高解析版。</summary>
    private static (byte[] Rgba, int Width, int Height)? LoadIcon(GameData gd, uint iconId, bool preferHighRes = true)
    {
        var folder = iconId / 1000 * 1000;
        foreach (var suffix in preferHighRes ? ["_hr1", ""] : new[] { "", "_hr1" })
        {
            var path = $"ui/icon/{folder:D6}/{iconId:D6}{suffix}.tex";
            var tex = gd.GetFile<TexFile>(path);
            if (tex is null) continue;

            // Lumina 解出來是 B8G8R8A8，PNG 要 R8G8B8A8 → 交換 B 與 R
            var src = tex.ImageData;
            var rgba = new byte[src.Length];
            for (var i = 0; i < src.Length; i += 4)
            {
                rgba[i] = src[i + 2];
                rgba[i + 1] = src[i + 1];
                rgba[i + 2] = src[i];
                rgba[i + 3] = src[i + 3];
            }
            return (rgba, tex.Header.Width, tex.Header.Height);
        }
        return null;
    }

    private static byte[] EncodePng(byte[] rgba, int width, int height)
    {
        using var ms = new MemoryStream();
        ms.Write([0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A]);

        // IHDR：8 bit 位元深度、色彩型別 6（truecolor + alpha）、無交錯
        var ihdr = new byte[13];
        WriteBe(ihdr, 0, width);
        WriteBe(ihdr, 4, height);
        ihdr[8] = 8;
        ihdr[9] = 6;
        WriteChunk(ms, "IHDR", ihdr);

        // 每列前面加一個 filter type byte（0＝None）
        var raw = new byte[height * (width * 4 + 1)];
        for (var y = 0; y < height; y++)
        {
            var dst = y * (width * 4 + 1);
            raw[dst] = 0;
            Array.Copy(rgba, y * width * 4, raw, dst + 1, width * 4);
        }

        using var compressed = new MemoryStream();
        using (var z = new ZLibStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
            z.Write(raw);
        WriteChunk(ms, "IDAT", compressed.ToArray());

        WriteChunk(ms, "IEND", []);
        return ms.ToArray();
    }

    private static void WriteChunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4];
        WriteBe(len, 0, data.Length);
        s.Write(len);

        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        s.Write(typeBytes);
        s.Write(data);

        var crc = Crc32(typeBytes, data);
        var crcBytes = new byte[4];
        WriteBe(crcBytes, 0, (int)crc);
        s.Write(crcBytes);
    }

    private static void WriteBe(byte[] buf, int offset, int value)
    {
        buf[offset] = (byte)(value >> 24);
        buf[offset + 1] = (byte)(value >> 16);
        buf[offset + 2] = (byte)(value >> 8);
        buf[offset + 3] = (byte)value;
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }

    private static uint Crc32(params byte[][] parts)
    {
        var c = 0xFFFFFFFFu;
        foreach (var part in parts)
            foreach (var b in part)
                c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
}
