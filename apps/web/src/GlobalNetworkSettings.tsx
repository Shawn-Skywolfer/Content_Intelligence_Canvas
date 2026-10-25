import { useEffect, useState } from "react";
import { api, GlobalNetworkConfig } from "./api";

export default function GlobalNetworkSettings() {
  const [form, setForm] = useState<GlobalNetworkConfig>({ network_mode: "auto", proxy_url: "", proxy_username: "", proxy_password: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; api.getGlobalNetwork().then((value) => { if (active) setForm({ ...value, proxy_password: "" }); }).catch((error) => { if (active) setMessage(String(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  async function save(test = false) {
    setBusy(true); setMessage("正在保存全局网络设置…");
    try {
      const saved = await api.saveGlobalNetwork(form);
      setForm({ ...saved, proxy_password: "", clear_proxy_password: false });
      setMessage("全局网络设置已保存。选择继承的模型、MCP 和网页工具将在下次请求时使用此配置。");
      if (test) {
        setMessage("正在检测网络可达性，单次请求超时 8 秒…");
        const result = await api.testGlobalNetwork();
        setMessage(`${result.reachable ? "收到响应" : "连接失败"} · ${result.http_status == null ? "未收到 HTTP 响应" : `HTTP ${result.http_status}`} · ${result.route || "所选网络"} · ${result.latency_ms} ms。${result.message}`);
      }
    } catch (error) { setMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card" aria-label="全局网络与代理设置"><h2>全局网络与代理</h2><p>模型、搜索 MCP、DeepSeek 网页工具默认继承此处配置，也可以在各自页面单独选择连接方式。单独设置优先于全局设置。</p>
    <fieldset className="network-fieldset" disabled={loading || busy}>
      <label>全局网络连接方式<select value={form.network_mode} onChange={(e) => setForm({ ...form, network_mode: e.target.value as GlobalNetworkConfig["network_mode"] })}><option value="auto">自动检测（系统代理优先）</option><option value="direct">直接连接</option><option value="system_proxy">系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>
      {form.network_mode === "custom_proxy" && <div className="proxy-fields"><label>全局代理地址<input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="http://proxy.company.com:8080" /></label><label>全局代理用户名<input value={form.proxy_username} onChange={(e) => setForm({ ...form, proxy_username: e.target.value })} /></label><label>全局代理密码<input type="password" value={form.proxy_password || ""} onChange={(e) => setForm({ ...form, proxy_password: e.target.value })} placeholder={form.has_proxy_password ? "已保存；留空沿用" : "可选"} /></label><label className="check"><input type="checkbox" checked={!!form.clear_proxy_password} onChange={(e) => setForm({ ...form, clear_proxy_password: e.target.checked })} />清除已保存的全局代理密码</label></div>}
      <div className="form-actions"><button type="button" className="primary" onClick={() => void save()}>保存全局网络设置</button><button type="button" className="secondary" onClick={() => void save(true)}>保存并测试网络</button></div>
    </fieldset>{message && <div role="status" className="settings-progress"><p>{message}</p></div>}
  </section>;
}
