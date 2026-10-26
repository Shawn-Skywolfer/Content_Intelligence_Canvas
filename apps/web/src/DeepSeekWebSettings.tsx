import { useEffect, useState } from "react";
import { api, DeepSeekWebConfig, WebTestJob } from "./api";

type Operation = "search" | "fetch" | "context";
type Form = Omit<DeepSeekWebConfig, "count" | "timeout_seconds"> & { count: string; timeout_seconds: string };
const asForm = (c: DeepSeekWebConfig): Form => ({ ...c, search_enabled: c.search_enabled ?? c.enabled, fetch_enabled: c.fetch_enabled ?? c.enabled, count: String(c.count), timeout_seconds: String(c.timeout_seconds), api_key: "", proxy_password: "" });
const defaults: DeepSeekWebConfig = { base_url: "https://api.deepseek.com", enabled: false, search_enabled: false, fetch_enabled: false, search_syntax: "", localization: "", count: 3, need_content: true, fetch_top_k: 2, max_content_chars: 8000, timeout_seconds: 25, network_mode: "inherit", proxy_url: "", proxy_username: "" };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

function TestResult({ job }: { job?: WebTestJob }) {
  if (!job) return null;
  return <div className={`settings-progress ${job.status === "failed" ? "failed" : ""}`} role="status"><div className="settings-progress-head"><strong>{job.phase}</strong><span>已用 {job.elapsed_seconds.toFixed(1)} 秒</span></div>
    {job.failure ? <div className="settings-error"><strong>{job.failure.http_status == null ? "未收到 HTTP 响应" : `HTTP ${job.failure.http_status}`} · {job.failure.operation}</strong><p>{job.failure.reason}</p><p>处理建议：{job.failure.suggestion}</p>{job.failure.endpoint && <p>请求地址：{job.failure.endpoint}</p>}</div> : job.error && <p className="settings-error">{job.error}</p>}
    {job.result.search && <div className="deepseek-test-result"><strong>Search：HTTP {job.result.search.http_status} · {job.result.search.result_count} 条结果 · {job.result.search.latency_ms} ms · {job.result.search.route}</strong><p>实际检索语句：{job.result.search.query}</p>{job.result.search.items.map((item) => <details key={item.url}><summary>{item.title || item.url}</summary><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a><p>{item.excerpt}</p></details>)}</div>}
    {job.result.fetch && <div className="deepseek-test-result"><strong>Fetch：HTTP {job.result.fetch.http_status} · 正文 {job.result.fetch.content_chars} 字符 · {job.result.fetch.latency_ms} ms · {job.result.fetch.route}</strong><p>{job.result.fetch.title}</p><a href={job.result.fetch.url} target="_blank" rel="noreferrer">{job.result.fetch.url}</a><details><summary>查看 Markdown 正文预览</summary><pre className="deepseek-preview">{job.result.fetch.preview}</pre></details></div>}
    {job.result.context && <div className="deepseek-test-result"><strong>已准备 {job.result.context.page_count} 篇网页正文 · 共 {job.result.context.content_chars} 字符作为模型上下文</strong><p>以下为正文预览，实际生成时使用完整正文。</p>{job.result.context.items.map((item) => <details key={item.url}><summary>{item.title} · {item.content_chars} 字符</summary><a href={item.url} target="_blank" rel="noreferrer">{item.url}</a><pre className="deepseek-preview">{item.preview}</pre></details>)}{job.result.context.failed_pages.map((item) => <p key={item.url}>跳过：{item.url} · {item.error}</p>)}</div>}
    <details open={job.status === "running"}><summary>测试执行日志</summary><ol className="task-event-list">{job.events.map((event, index) => <li key={index}>{new Date(event.at * 1000).toLocaleTimeString()} · {event.detail}</li>)}</ol></details>
  </div>;
}

export default function DeepSeekWebSettings({ revision = 0 }: { revision?: number }) {
  const [form, setForm] = useState<Form>(asForm(defaults));
  const [selection, setSelection] = useState("正在检测已保存的搜索服务…");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("DeepSeek API 网页搜索 官方文档");
  const [url, setUrl] = useState("https://api-docs.deepseek.com/zh-cn/guides/search/");
  const [jobs, setJobs] = useState<Partial<Record<Operation, WebTestJob>>>({});
  const running = Object.values(jobs).some((job) => job.status === "running");
  const pollKey = Object.entries(jobs).filter(([, job]) => job.status === "running").map(([op, job]) => `${op}:${job.job_id}`).join("|");
  useEffect(() => { let active = true; api.getDeepSeekWeb().then((value) => { if (active) setForm(asForm(value)); }).catch((e) => { if (active) setMessage(`加载失败：${errorText(e)}`); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  useEffect(() => { let active = true; api.getWebSearch().then((value) => { if (active) setSelection(value.message); }).catch((e) => { if (active) setSelection(`检测失败：${errorText(e)}`); }); return () => { active = false; }; }, [revision]);
  useEffect(() => {
    if (!pollKey) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await Promise.all(pollKey.split("|").map(async (entry) => {
        const [op, id] = entry.split(":") as [Operation, string];
        try { const latest = await api.deepSeekWebTestJob(id); if (active) setJobs((previous) => ({ ...previous, [op]: latest })); }
        catch (e) { if (active) setJobs((previous) => ({ ...previous, [op]: { ...previous[op]!, status: "failed", phase: "读取测试进度失败", error: errorText(e) } })); }
      }));
      if (active) timer = setTimeout(() => void poll(), 700);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [pollKey]);
  async function save(operation?: Operation) {
    setSaving(true); setMessage("正在保存网页工具设置…");
    try {
      if (!form.count.trim() || !form.timeout_seconds.trim()) throw new Error("请填写搜索条数与超时秒数");
      const saved = await api.saveDeepSeekWeb({ ...form, enabled: !!(form.search_enabled || form.fetch_enabled), count: Number(form.count), timeout_seconds: Number(form.timeout_seconds) });
      setForm(asForm(saved)); setSelection((await api.getWebSearch()).message); setMessage("网页工具配置已保存。");
      if (operation) {
        const started = await api.startDeepSeekWebTest(operation, query, url);
        setJobs((previous) => ({ ...previous, [operation]: started })); setMessage("");
      }
    } catch (e) { setMessage(`操作失败：${errorText(e)}`); }
    finally { setSaving(false); }
  }
  return <section className="card settings-card deepseek-web-settings" aria-label="DeepSeek 网页工具设置">
    <div className="section-title"><div><h2>DeepSeek 网页搜索与抓取</h2><p>Search 查找网页，Fetch 获取单页 Markdown 正文。两项能力可分别启用和测试。</p></div><a href="https://api-docs.deepseek.com/zh-cn/guides/search/" target="_blank" rel="noreferrer">官方文档 ↗</a></div>
    <div className="web-auto-selection" role="status"><strong>联网加工自动选择</strong><p>{selection}</p><small>优先使用已启用的 DeepSeek 搜索；否则使用搜索 MCP。抓取开启时补全文，关闭时只使用搜索已返回的正文，缺少正文的页面会跳过。</small></div>
    <fieldset className="network-fieldset" disabled={saving || loading || running}>
      <div className="deepseek-capability-grid"><label className="check"><input type="checkbox" checked={!!form.search_enabled} onChange={(e) => setForm({ ...form, search_enabled: e.target.checked })} />启用 DeepSeek 网页搜索</label><label className="check"><input type="checkbox" checked={!!form.fetch_enabled} onChange={(e) => setForm({ ...form, fetch_enabled: e.target.checked })} />启用 DeepSeek 网页抓取</label></div>
      <div className="advanced-grid"><label>DeepSeek 网页工具接口地址<input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label><label>DeepSeek 网页工具 API Key<input type="password" autoComplete="off" value={form.api_key || ""} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder={form.has_api_key ? "已保存 Key；留空沿用" : "填写 DeepSeek API Key"} /></label></div>
      <div className="advanced-grid"><label>搜索结果条数（1–50）<input type="number" min="1" max="50" value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} /></label><label>请求超时（5–90 秒）<input type="number" min="5" max="90" value={form.timeout_seconds} onChange={(e) => setForm({ ...form, timeout_seconds: e.target.value })} /></label></div>
      <label>默认检索语法<textarea maxLength={100} rows={3} value={form.search_syntax || ""} onChange={(e) => setForm({ ...form, search_syntax: e.target.value })} placeholder='例如 site:example.com lang:zh after:2025 -广告' /></label><p className="context-note">语法会完整追加到每次搜索词之后。支持 site:、-site:、lang:、after:、before:、"精确短语"、-排除词和 OR。检索语句最多 128 个字符，过长时缩短主题部分并保留语法。Fetch 只接收网页地址，不使用搜索语法。</p>
      <label>搜索本地化 IP（可选）<input value={form.localization || ""} onChange={(e) => setForm({ ...form, localization: e.target.value })} placeholder="留空不限制" /></label>
      <label>DeepSeek 网页工具网络连接方式<select value={form.network_mode} onChange={(e) => setForm({ ...form, network_mode: e.target.value as DeepSeekWebConfig["network_mode"] })}><option value="inherit">继承全局网络设置</option><option value="auto">单独自动检测</option><option value="direct">直接连接</option><option value="system_proxy">系统代理</option><option value="custom_proxy">企业代理手动设置</option></select></label>
      {form.network_mode === "custom_proxy" && <div className="proxy-fields"><label>DeepSeek 网页工具企业代理地址<input value={form.proxy_url} onChange={(e) => setForm({ ...form, proxy_url: e.target.value })} placeholder="http://proxy.company.com:8080" /></label><label>DeepSeek 网页工具代理用户名<input value={form.proxy_username} onChange={(e) => setForm({ ...form, proxy_username: e.target.value })} /></label><label>DeepSeek 网页工具代理密码<input type="password" value={form.proxy_password || ""} onChange={(e) => setForm({ ...form, proxy_password: e.target.value })} placeholder={form.has_proxy_password ? "已保存；留空沿用" : "可选"} /></label></div>}
      <button type="button" className="primary" onClick={() => void save()}>保存 DeepSeek 网页工具</button>
    </fieldset>
    <div className="deepseek-capability-grid">
      <section className="deepseek-capability-card"><h3>搜索可用性测试</h3><label>测试搜索词<input disabled={loading || saving || running} maxLength={128} value={query} onChange={(e) => setQuery(e.target.value)} /></label><button className="secondary" type="button" disabled={loading || saving || !form.search_enabled || !query.trim() || jobs.search?.status === "running"} onClick={() => void save("search")}>测试网页搜索</button><TestResult job={jobs.search} /></section>
      <section className="deepseek-capability-card"><h3>抓取可用性测试</h3><label>测试抓取网页<input disabled={loading || saving || running} maxLength={8192} value={url} onChange={(e) => setUrl(e.target.value)} /></label><button className="secondary" type="button" disabled={loading || saving || !form.fetch_enabled || !url.trim() || jobs.fetch?.status === "running"} onClick={() => void save("fetch")}>测试网页抓取</button><TestResult job={jobs.fetch} /></section>
    </div>
    <section className="deepseek-capability-card"><h3>搜索 → 网页正文 → 模型上下文</h3><p>验证完整网页上下文准备流程，不执行模型生成。正文不会按固定字符数截断。</p><button type="button" className="primary" disabled={loading || saving || !form.search_enabled || !query.trim() || jobs.context?.status === "running"} onClick={() => void save("context")}>保存并测试完整联网流程</button><TestResult job={jobs.context} /></section>
    {message && <p className="settings-feedback" role="status">{message}</p>}
  </section>;
}
