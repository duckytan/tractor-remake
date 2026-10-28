// smallnest 拖拉机 · 外部算法插件（把本项目的 AI 接进它的引擎）
//
// 用法：
//   1. 编译成 DLL 放到 Tractor.exe 同目录的 plugins\ 下（命令见 ../README.md）
//   2. 运行 Tractor.exe → 菜单里选「选择算法」→ 四个座位各选 `TractorRemake-AI`
//   3. 勾上菜单「机器人罗伯特」（= gameConfig.IsDebug，让人类的座位也自动出牌）
//
// 设计要点（来自 docs/42 的会审结论）：
//   · **所有异常都必须吞掉**：这个接口外面没有 try/catch，抛异常会把游戏主线程带崩
//   · 拿不到桥的回答时返回**空数组** —— 它的调用方会因此把本座位降级成内置算法
//     （这是它的行为，我们改不了）；所以桥侧必须记录 seq，用「seq 断流」判定被踢
//   · 每座位一个实例（Activator.CreateInstance 各建一次），seq 也就各自独立

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

using Kuaff.Tractor.Plugins;

namespace TractorRemake
{
    public class RemakeAiPlugin : IUserAlgorithm
    {
        public string Author { get { return "tractor-remake"; } }
        public string Email { get { return "noreply@example.com"; } }
        public string Name { get { return "TractorRemake-AI"; } }
        public string Description
        {
            get { return "把 tractor-remake 的 AI 接进 smallnest 的引擎（离线对照用）"; }
        }

        /** 本实例（本座位）的调用序号：桥侧用它判断「这个座位还在被调用吗」 */
        private int seq = 0;
        private Process bridge;
        private readonly object gate = new object();

        public ArrayList ShouldSendCards(int who, int suit, int rank, int master,
                                         string[] sendCards, string myCards)
        {
            return Ask(who, suit, rank, master, 0, sendCards, null, myCards, true);
        }

        public ArrayList MustSendCards(int who, int suit, int rank, int master, int whoIsFirst,
                                       string[] sendCards, ArrayList[] currentSendCards, string myCards)
        {
            // ArrayList[] → 每家一个「逗号分隔」的牌串
            string[] per = new string[4];
            if (currentSendCards != null)
            {
                for (int i = 0; i < 4 && i < currentSendCards.Length; i++)
                {
                    per[i] = Join(currentSendCards[i]);
                }
            }
            return Ask(who, suit, rank, master, whoIsFirst, sendCards, per, myCards, false);
        }

        private ArrayList Ask(int who, int suit, int rank, int master, int whoIsFirst,
                              string[] sendCards, string[] per, string myCards, bool isLead)
        {
            lock (gate)
            {
                try
                {
                    EnsureBridge();
                    if (bridge == null || bridge.HasExited) return new ArrayList();

                    seq += 1;
                    string req = BuildJson(seq, who, suit, rank, master, whoIsFirst, sendCards, per, myCards, isLead);
                    bridge.StandardInput.WriteLine(req);
                    bridge.StandardInput.Flush();

                    string line = bridge.StandardOutput.ReadLine();
                    if (line == null) return new ArrayList();
                    return ParseCards(line);
                }
                catch
                {
                    // 绝不让异常穿过插件边界（会把游戏主线程带崩）
                    return new ArrayList();
                }
            }
        }

        /** 懒启动：一个游戏进程只起一个 Node 桥，之后复用 */
        private void EnsureBridge()
        {
            if (bridge != null && !bridge.HasExited) return;

            string repo = Environment.GetEnvironmentVariable("TRACTOR_REPO");
            if (string.IsNullOrEmpty(repo)) repo = @"D:\WorkBuddy\逆向REA\tractor-remake";

            string bridgeTs = Environment.GetEnvironmentVariable("TRACTOR_BRIDGE");
            if (string.IsNullOrEmpty(bridgeTs))
                bridgeTs = Path.Combine(repo, @"tools\smallnest-bridge\bridge\bridge.ts");

            string node = Environment.GetEnvironmentVariable("TRACTOR_NODE");
            if (string.IsNullOrEmpty(node)) node = "node";

            string viteNode = Path.Combine(repo, @"node_modules\vite-node\vite-node.mjs");
            if (!File.Exists(viteNode) || !File.Exists(bridgeTs)) return;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = Quote(viteNode) + " " + Quote(bridgeTs);
            psi.WorkingDirectory = repo;
            psi.UseShellExecute = false;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardInputEncoding = Encoding.UTF8;

            Process p = new Process();
            p.StartInfo = psi;
            p.Start();
            // stderr 必须读走，否则缓冲区满了桥会阻塞
            p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { };
            p.BeginErrorReadLine();
            bridge = p;
        }

        private static string BuildJson(int seq, int who, int suit, int rank, int master, int whoIsFirst,
                                        string[] sendCards, string[] per, string myCards, bool isLead)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"seq\":").Append(seq).Append(",");
            sb.Append("\"kind\":\"").Append(isLead ? "lead" : "follow").Append("\",");
            sb.Append("\"who\":").Append(who).Append(",");
            sb.Append("\"suit\":").Append(suit).Append(",");
            sb.Append("\"rank\":").Append(rank).Append(",");
            sb.Append("\"master\":").Append(master).Append(",");
            sb.Append("\"whoIsFirst\":").Append(whoIsFirst).Append(",");
            sb.Append("\"sendCards\":").Append(Arr(sendCards)).Append(",");
            sb.Append("\"currentSendCards\":").Append(Arr(per)).Append(",");
            sb.Append("\"myCards\":\"").Append(myCards == null ? "" : myCards).Append("\"");
            sb.Append("}");
            return sb.ToString();
        }

        private static string Arr(string[] xs)
        {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < 4; i++)
            {
                if (i > 0) sb.Append(",");
                string v = (xs != null && i < xs.Length && xs[i] != null) ? xs[i] : "";
                sb.Append("\"").Append(v).Append("\"");
            }
            sb.Append("]");
            return sb.ToString();
        }

        private static string Join(ArrayList list)
        {
            if (list == null) return "";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.Count; i++)
            {
                sb.Append(Convert.ToInt32(list[i])).Append(",");
            }
            return sb.ToString();
        }

        /** 只认 `{"seq":n,"cards":[...]}` 里的 cards；其余一律当空 */
        private static ArrayList ParseCards(string line)
        {
            ArrayList outList = new ArrayList();
            int i = line.IndexOf("\"cards\"");
            if (i < 0) return outList;
            int lb = line.IndexOf('[', i);
            int rb = line.IndexOf(']', lb + 1);
            if (lb < 0 || rb < 0) return outList;
            string body = line.Substring(lb + 1, rb - lb - 1);
            foreach (string part in body.Split(','))
            {
                string t = part.Trim();
                if (t.Length == 0) continue;
                int v;
                if (int.TryParse(t, out v)) outList.Add(v);
            }
            return outList;
        }

        private static string Quote(string s) { return "\"" + s + "\""; }
    }
}
