export function cleanSourcePath(value: string): string {
  const raw = value.replace(/\uFEFF/g, "").trim().replace(/^["'“”‘’]|["'“”‘’]$/g, "");
  const matches = [...raw.matchAll(/[A-Za-z]:[\\/]|\\\\[^\\\s]+\\/g)];
  if (matches.length) return raw.slice(matches[matches.length - 1].index).split(/\r?\n/)[0].trim().replace(/^["'“”‘’]|["'“”‘’]$/g, "");
  return raw.split(/\r?\n/).reverse().map((line) => line.trim().replace(/^["']|["']$/g, "")).find((line) => line.startsWith("/") || line.startsWith("~/")) || raw;
}
