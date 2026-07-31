// 從台服 client（USERJOY 代理版）sqpack 產生宇宙探索網站的靜態資料。
//
//   dotnet run -c Release --project tools/cosmic-dump [-- --sqpack <路徑>] [--out <目錄>]
//
// 產出 data/weather.json / missions.json / cosmic-tools.json（各自帶 client 版本 meta）。
// 台服每次改版後重跑；欄位索引若因改版失效，先跑 XIVpluginsDev/ICE-Dev/tools/tc-sheet-verify。
using System.Text.Json.Nodes;
using Lumina;
using Lumina.Data;
using Lumina.Excel;

namespace CosmicDump;

internal static class Program
{
    private const string DefaultSqPack = @"C:\Games\USERJOY GAMES\FINAL FANTASY XIV TC\game\sqpack";

    // 職業繁中名的唯一權威（DRY 鐵則：不在本 repo 另建對照表）。
    private const string DefaultJobsJson = @"C:\FFXIVProject\data\item_dict\jobs.json";

    private static int Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        var sqpack = Arg(args, "--sqpack") ?? Environment.GetEnvironmentVariable("FFXIV_TC_SQPACK") ?? DefaultSqPack;
        var jobsJson = Arg(args, "--jobs") ?? DefaultJobsJson;
        var outDir = Arg(args, "--out") ?? DefaultOutDir();

        if (!Directory.Exists(sqpack))
        {
            Console.Error.WriteLine($"找不到 sqpack：{sqpack}（用 --sqpack 或環境變數 FFXIV_TC_SQPACK 指定）");
            return 2;
        }
        if (!File.Exists(jobsJson))
        {
            Console.Error.WriteLine($"找不到職業對照表：{jobsJson}（用 --jobs 指定）");
            return 2;
        }
        Directory.CreateDirectory(outDir);

        var gd = new GameData(sqpack, new LuminaOptions
        {
            // 台服 client 的 sheet checksum 與 Lumina 內建定義本就對不上（7.2 vs 7.3），
            // panic 會直接讓程式炸掉；本工具全程走 RawRow ＋欄位索引，不依賴 typed 定義。
            PanicOnSheetChecksumMismatch = false,
            DefaultExcelLanguage = Language.TraditionalChinese,
        });

        var clientVersion = ReadClientVersion(sqpack);
        Console.WriteLine($"sqpack = {sqpack}");
        Console.WriteLine($"client = {clientVersion}");
        Console.WriteLine($"out    = {outDir}\n");

        var meta = new JsonObject
        {
            ["clientVersion"] = clientVersion,
            ["generatedAt"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
            ["generator"] = "tools/cosmic-dump",
        };

        var jobs = LoadJobs(jobsJson);
        Console.WriteLine($"職業對照：{jobs.Count} 職（DoH 8 ＋ DoL 3）");

        // 職業圖示：CSP 禁外連圖床（img-src 'self'），必須自己解出來放同源
        var iconDir = Path.Combine(Path.GetDirectoryName(outDir.TrimEnd('\\', '/'))!, "img", "jobs");
        var iconJobs = jobs.ToDictionary(
            kv => kv.Key,
            kv => ((string)kv.Value["abbr"]!, (uint)(int)kv.Value["iconId"]!));
        IconExporter.Export(gd, iconJobs, iconDir);

        var ex = new Exporters(gd, meta);

        // 先全部產在記憶體、sanity 過了才落地——分次寫檔中途失敗會留下混版的 data/。
        var weather = ex.Weather();
        var missions = ex.Missions(jobs);
        var tools = ex.CosmicTools(jobs);
        var devStages = ex.DevStages(LoadWorlds(jobsJson));

        if (!Sanity(weather, missions, tools, devStages)) return 1;

        Console.WriteLine("\n輸出：");
        Exporters.Write(Path.Combine(outDir, "weather.json"), weather);
        Exporters.Write(Path.Combine(outDir, "missions.json"), missions);
        Exporters.Write(Path.Combine(outDir, "cosmic-tools.json"), tools);
        Exporters.Write(Path.Combine(outDir, "dev-stages.json"), devStages);
        Console.WriteLine("\n完成。");
        return 0;
    }

    /// <summary>落地前的健全性閘：數量對不上就整批不寫，避免半殘資料被 commit 進網站。</summary>
    private static bool Sanity(JsonObject weather, JsonObject missions, JsonObject tools, JsonObject devStages)
    {
        var problems = new List<string>();

        var rateSum = weather["table"]!.AsArray().Sum(x => (int)x!["rate"]!);
        if (rateSum != 100) problems.Add($"渴望灣天氣機率總和 = {rateSum}，應為 100");
        if (weather["table"]!.AsArray().Count == 0) problems.Add("渴望灣天氣表為空");

        var missionCount = missions["missions"]!.AsArray().Count;
        if (missionCount != 544) problems.Add($"任務數 = {missionCount}，應為 544（台服 7.2 渴望灣）");

        var noReward = missions["missions"]!.AsArray()
            .Count(m => (int)m!["reward"]!["cosmo"]! == 0 && (int)m["reward"]!["lunar"]! == 0);
        if (noReward > 0) problems.Add($"{noReward} 筆任務信用點全為 0（該欄本應每筆都有值）");

        int ClassCount(string k) => missions["missions"]!.AsArray().Count(m => (string)m!["class"]! == k);
        var basic = ClassCount("basic");
        var temporary = ClassCount("temporary");
        var critical = ClassCount("critical");
        if (basic != 231) problems.Add($"基礎任務 = {basic}，應為 231（D/C/B 非緊急）");
        if (temporary != 280) problems.Add($"臨時任務 = {temporary}，應為 280（A1/A2/A3）");
        if (critical != 33) problems.Add($"緊急任務 = {critical}，應為 33");

        var chainCount = tools["chains"]!.AsArray().Count;
        if (chainCount != 11) problems.Add($"宇宙工具鏈 = {chainCount} 條，應為 11（DoH 8 ＋ DoL 3）");
        foreach (var c in tools["chains"]!.AsArray())
        {
            var n = c!["stages"]!.AsArray().Count;
            if (n != 9) problems.Add($"job {c["jobId"]} 的升級鏈 {n} 階，應為 9");
        }

        var phaseCount = devStages["phases"]!.AsArray().Count;
        var stageCount = devStages["stages"]!.AsArray().Count;
        if (phaseCount != 16) problems.Add($"開拓紀錄 = {phaseCount} 期，應為 16");
        if (stageCount < 60) problems.Add($"施工階段 = {stageCount}，明顯過少（應 60+）");
        if (devStages["worlds"]!.AsArray().Count != 7) problems.Add("繁中服伺服器數不是 7");

        Console.WriteLine($"\n健全性：任務 {missionCount} 筆／天氣 {weather["table"]!.AsArray().Count} 種（總和 {rateSum}%）／工具鏈 {chainCount} 條");
        Console.WriteLine($"　　　　基礎 {basic} ／臨時 {temporary} ／緊急 {critical}");
        Console.WriteLine($"　　　　開發階段 {phaseCount} 期／{stageCount} 個施工階段／{devStages["worlds"]!.AsArray().Count} 個伺服器");
        foreach (var p in problems) Console.Error.WriteLine($"  ✗ {p}");
        if (problems.Count > 0) Console.Error.WriteLine("\n未通過 — 不寫出任何檔案。");
        return problems.Count == 0;
    }

    /// <summary>繁中服 7 伺服器名的唯一權威＝monorepo 的 servers.json（DRY 鐵則，不在本 repo 自寫陣列）。</summary>
    private static List<string> LoadWorlds(string jobsJsonPath)
    {
        var path = Path.Combine(Path.GetDirectoryName(jobsJsonPath)!, "servers.json");
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        return root["dcs"]!["chocobo"]!["servers"]!.AsArray().Select(x => (string)x!).ToList();
    }

    private static Dictionary<uint, JsonObject> LoadJobs(string path)
    {
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var result = new Dictionary<uint, JsonObject>();
        foreach (var (abbr, node) in root["jobs"]!.AsObject())
        {
            var j = node!.AsObject();
            var role = (string?)j["role"];
            if (role is not ("crafter" or "gatherer")) continue;   // 宇宙探索只有 DoH/DoL
            result[(uint)(int)j["id"]!] = new JsonObject
            {
                ["abbr"] = abbr,
                ["label"] = (string?)j["label"],
                ["role"] = role,
                ["iconId"] = (int?)j["icon_id"],
            };
        }
        return result;
    }

    private static string ReadClientVersion(string sqpack)
    {
        var verFile = Path.Combine(Path.GetDirectoryName(sqpack.TrimEnd('\\', '/'))!, "ffxivgame.ver");
        return File.Exists(verFile) ? File.ReadAllText(verFile).Trim() : "unknown";
    }

    private static string DefaultOutDir()
    {
        // tools/cosmic-dump/bin/Release/net10.0 → repo 根的 data/
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 6 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir, "data");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir, "index.html"))) return candidate;
            dir = Path.GetDirectoryName(dir.TrimEnd('\\', '/'));
        }
        return Path.GetFullPath("data");
    }

    private static string? Arg(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
