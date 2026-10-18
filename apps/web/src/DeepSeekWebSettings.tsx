import { useEffect, useState } from "react";
import { api, DeepSeekWebConfig, WebTestJob } from "./api";

type Form = Omit<DeepSeekWebConfig, "count" | "fetch_top_k" | "max_content_chars" | "timeout_seconds"> & { count: string; fetch_top_k: string; max_content_chars: string; timeout_seconds: string };
const asForm = (config: DeepSeekWebConfig): Form => ({ ...config, count: String(config.count), fetch_top_k: String(config.fetch_top_k), max_content_chars: String(config.max_content_chars), timeout_seconds: String(config.timeout_seconds), api_key: "", proxy_password: "" });
const defaults: DeepSeekWebConfig = { base_url: "https://api.deepseek.com", enabled: false, count: 5, need_content: true, fetch_top_k: 2, max_content_chars: 8000, timeout_seconds: 25, network_mode: "auto", proxy_url: "", proxy_username: "" };

export default function DeepSeekWebSettings({ revision = 0 }: { revision?: number }) {
  const [form, setForm] = useState<Form>(asForm(defaults));
  const [selection, setSelection] = useState("正在检测已保存的搜索服务…");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("DeepSeek API 网页搜索 官方文档");
  const [url, setUrl] = useState("https://api-docs.deepseek.com/zh-cn/guides/search/");
  const [job, setJob] = useState<WebTestJob | null>(null);
  const [jobId, setJobId] = useState("");
  const busy = saving || !!jobId;
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  useEffect(() => { let active = true; api.getDeepSeekWeb().then((value) => { if (active) setForm(asForm(value)); }).catch((error) => { if (active) setMessage(`加载失败：${errorText(error)}`); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  useEffect(() => { let active = true; api.getWebSearch().then((value) => { if (active) setSelection(value.message); }).catch((error) => { if (active) setSelection(`检测失败：${errorText(error)}`); }); return () => { active = false; }; }, [revision]);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const latest = await api.deepSeekWebTestJob(jobId);
        if (!active) return;
        setJob(latest);
        if (latest.status === "running") timer = setTimeout(poll, 700); else setJobId("");
      } catch (error) { if (active) { setMessage(`读取测试进度失败：${errorText(error)}`); setJobId(""); } }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId]);
  async function save(operation?: "search" | "fetch" | "both") {
    setSaving(true); setMessage("正在保存网页工具设置…"); setJob(null);
    try {
      if ([form.count, form.fetch_top_k, form.max_content_chars, form.timeout_seconds].some((value) => !value.trim())) throw new Error("请完整填写搜索条数、抓取条数、正文长度与超时秒数");
      const saved = await api.saveDeepSeekWeb({ ...form, count: Number(form.count), fetch_top_k: Number(form.fetch_top_k), max_content_chars: Number(form.max_content_chars), timeout_seconds: Number(form.timeout_seconds) });
      setForm(asForm(saved));
      setSelection((await api.getWebSearch()).message);
      setMessage("配置已保存。勾选节点的网络检索后将自动检测，优先使用 DeepSeek。");
      if (operation) {
        setMessage("正在启动真实网页工具测试…");
        const started = await api.startDeepSeekWebTest(operation, query, url);
        setJob(started); setJobId(started.status === "running" ? started.job_id : ""); setMessage("");
      }
    } catch (error) { setMessage(`操作失败：${errorText(error)}`); }
    finally { setSaving(false); }
  }
  return <section className="card settings-card deepseek-web-settings" aria-label="DeepSeek 网页工具设置">
    <div className="section-title"><div><h2>DeepSeek 网页搜索与抓取</h2><p>使用官方 Search / Fetch API，无需配置 MCP 地址。搜索返回来源与正文；抓取将单个网页转为 Markdown。</p></div><a href="https://api-docs.deepseek.com/zh-cn/guides/search/" target="_blank" rel="noreferrer">官方文档 ↗</a></div>
    <div className="web-auto-selection" role="status"><strong>联网加工自动选择</strong><p>{selection}</p><small>已启用且已保存 Key 的 DeepSeek 优先；否则使用已启用的搜索 MCP。DeepSeek 整体搜索失败时，有可用 MCP 则回退，原因会记录在任务进度中。</small></div>
    <fieldset disabled={busy || loading}>
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用 DeepSeek 网页搜索与抓取</label>
      <div className="advanced-grid"><label>DeepSeek 网页工具接口地址<input value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} /></label><label>DeepSeek 网页工具 API Key<input type="password" autoComplete="off" value={form.api_key || ""} onChange={(event) => setForm({ ...form, api_key: event.target.value })} placeholder={form.has_api_key ? "已保存 Key；留空沿用" : "填写 DeepSeek API Key"} /></label></div>
      <div className="advanced-grid"><label>搜索结果条数（1–50）<input type="number" min="1" max="50" value={form.count} onChange={(event) => setForm({ ...form, count: event.target.value })} /></label><label>自动抓取前几条（0–5）<input type="number" min="0" max="5" value={form.fetch_top_k} onChange={(event) => setForm({ ...form, fetch_top_k: event.target.value })} /></label><label>每页进入模型的最大字符数<input type="number" min="1000" max="30000" value={form.max_content_chars} onChange={(event) => setForm({ ...form, max_content_chars: event.target.value })} /></label><label>请求超时（5–90 秒）<input type="number" min="5" max="90" value={form.timeout_seconds} onChange={(event) => setForm({ ...form, timeout_seconds: event.target.value })} /></label></div>
      <label className="check"><input type="checkbox" checked={form.need_content} onChange={(event) => setForm({ ...form, need_content: event.target.checked })} />搜索结果同时返回网页正文</label>
      <p className="context-note">自动抓取设为 0 时，仍使用搜索返回的正文或摘要。单页抓取失败时沿用其搜索材料，并记录失败原因。</p>
      <label>DeepSeek 网页工具网络连接方式<select value={form.network_mode} onChange={(event) => setForm({ ...form, network_mode: event.target.value as DeepSeekWebConfig["network_mode"] })}><option value="auto">自动（系统代理优先）</option><option value="direct">直接连接</option><option value="system_proxy">Windows 系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>
      {form.network_mode === "custom_proxy" && <div className="proxy-fields"><label>DeepSeek 网页工具企业代理地址<input value={form.proxy_url} onChange={(event) => setForm({ ...form, proxy_url: event.target.value })} placeholder="http://proxy.company.com:8080" /></label><label>DeepSeek 网页工具代理用户名<input value={form.proxy_username} onChange={(event) => setForm({ ...form, proxy_username: event.target.value })} /></label><label>DeepSeek 网页工具代理密码<input type="password" value={form.proxy_password || ""} onChange={(event) => setForm({ ...form, proxy_password: event.target.value })} placeholder={form.has_proxy_password ? "已保存；留空沿用" : "可选"} /></label></div>}
      <button type="button" className="primary" onClick={() => void save()}>保存 DeepSeek 网页工具</button>
      <div className="deepseek-test-form"><h3>真实搜索与抓取测试</h3><label>测试搜索词<input value={query} maxLength={128} onChange={(event) => setQuery(event.target.value)} /></label><label>测试抓取网页<input value={url} maxLength={8192} onChange={(event) => setUrl(event.target.value)} /></label><div className="form-actions"><button type="button" className="secondary" disabled={!form.enabled || !query.trim()} onClick={() => void save("search")}>保存并测试搜索</button><button type="button" className="secondary" disabled={!form.enabled || !url.trim()} onClick={() => void save("fetch")}>保存并测试抓取</button><button type="button" className="primary" disabled={!form.enabled || !query.trim() || !url.trim()} onClick={() => void save("both")}>保存并测试搜索和抓取</button></div></div>
    </fieldset>
    {message && <p className="settings-feedback" role="status">{message}</p>}
    {job && <div className={`settings-progress ${job.status === "failed" ? "failed" : ""}`} role="status"><div className="settings-progress-head"><strong>{job.phase}</strong><span>已用 {job.elapsed_seconds.toFixed(1)} 秒</span></div>{job.error && <p className="settings-error">{job.error}</p>}
      {job.result.search && <div className="deepseek-test-result"><strong>Search：HTTP {job.result.search.http_status} · {job.result.search.result_count} 条结果 · {job.result.search.latency_ms} ms · {job.result.search.route}</strong>{job.result.search.items.map((item) => <details key={item.url}><summary>{item.title || item.url}</summary><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a><p>{item.excerpt}</p></details>)}</div>}
      {job.result.fetch && <div className="deepseek-test-result"><strong>Fetch：HTTP {job.result.fetch.http_status} · 正文 {job.result.fetch.content_chars} 字符 · {job.result.fetch.latency_ms} ms · {job.result.fetch.route}</strong><p>{job.result.fetch.title}</p><a href={job.result.fetch.url} target="_blank" rel="noreferrer">{job.result.fetch.url}</a><details><summary>查看 Markdown 正文预览</summary><pre className="deepseek-preview">{job.result.fetch.preview}</pre></details></div>}
      <details open={job.status === "running"}><summary>测试执行日志</summary><ol className="task-event-list">{job.events.map((event, index) => <li key={index}>{new Date(event.at * 1000).toLocaleTimeString()} · {event.detail}</li>)}</ol></details>
    </div>}
  </section>;
}
