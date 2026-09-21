import { FormEvent, useEffect, useState } from "react";
import { api, Hit, Source } from "./api";

const exampleQueries = [
  "What is the most important system constraint?",
  "Which related concepts should I explore?",
  "What evidence supports this product idea?",
];

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [path, setPath] = useState("");
  const [query, setQuery] = useState(exampleQueries[0]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listSources().then((items) => {
      setSources(items);
      if (items[0]) setSourceId(items[0].id);
    }).catch((error) => setStatus(String(error)));
  }, []);

  async function addSource(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const source = await api.createSource("Local Wiki", path);
      setSources((current) => [...current.filter((item) => item.id !== source.id), source]);
      setSourceId(source.id);
      setStatus("Source configured. Click Refresh index.");
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }

  async function refresh() {
    if (!sourceId) return;
    setBusy(true);
    setStatus("Indexing real Wiki…");
    try {
      const report = await api.refresh(sourceId);
      setStatus(`Index ready · ${JSON.stringify(report)}`);
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }

  async function search(event?: FormEvent) {
    event?.preventDefault();
    if (!sourceId || !query.trim()) return;
    setBusy(true);
    setStatus("Searching BM25 + vector + WikiLink…");
    try {
      const response = await api.search(sourceId, query);
      setHits(response.hits);
      setStatus(`${response.hits.length} results`);
    } catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">CONTENT INTELLIGENCE CANVAS / SPRINT B</p>
        <h1>Internal knowledge retrieval, made inspectable.</h1>
        <p className="lede">Search Debug validates the read-only Wiki path before Canvas work begins.</p>
      </header>

      <section className="setup panel">
        <div>
          <label>Knowledge source</label>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">Select a source</option>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
        </div>
        <form onSubmit={addSource}>
          <label>Local Wiki folder</label>
          <div className="inline">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\Knowledge\\wiki or /Users/me/wiki" />
            <button disabled={busy || !path}>Configure</button>
          </div>
        </form>
        <button className="secondary" onClick={refresh} disabled={busy || !sourceId}>Refresh index</button>
      </section>

      <section className="search panel">
        <div className="examples">
          {exampleQueries.map((example) => <button key={example} onClick={() => setQuery(example)}>{example}</button>)}
        </div>
        <form onSubmit={search} className="querybar">
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search query" />
          <button disabled={busy || !sourceId}>Search Wiki</button>
        </form>
        <p className="status">{status}</p>
      </section>

      <section className="results">
        {hits.map((hit, index) => (
          <article key={hit.chunk_id}>
            <div className="rank">{String(index + 1).padStart(2, "0")}</div>
            <div className="hit-content">
              <div className="hit-head">
                <div><h2>{hit.title}</h2><p>{hit.source_path} · L{hit.start_line}–{hit.end_line}</p></div>
                <strong>{hit.score.toFixed(4)}</strong>
              </div>
              <p className="heading">{hit.heading_path.join(" › ") || "Document intro"}</p>
              <p className="excerpt">{hit.excerpt}</p>
              <div className="tags">{hit.retrieval_reasons.map((reason) => <span key={reason}>{reason}</span>)}</div>
              <details><summary>Why retrieved / Evidence</summary><pre>{JSON.stringify(hit.debug, null, 2)}</pre>
                {hit.original_references.slice(0, 5).map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}>{url}</a>)}
              </details>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
