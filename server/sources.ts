import type { EvidenceExcerpt, Source } from "../shared/types.js";

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only metadata outside model-authored text can produce provider-origin sources. */
export function providerSources(value: unknown): Source[] {
  const sources: Source[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 10) return;
    if (typeof node === "string") {
      const url = safeUrl(node);
      if (url)
        sources.push({ url, title: new URL(url).hostname, origin: "provider" });
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((n) => walk(n, depth + 1));
      return;
    }
    const item = record(node);
    const url = safeUrl(item.url ?? item.link);
    if (url)
      sources.push({
        url,
        title:
          typeof item.title === "string"
            ? item.title.slice(0, 300)
            : new URL(url).hostname,
        origin: "provider",
      });
    Object.values(item).forEach((child) => {
      if (typeof child === "object") walk(child, depth + 1);
    });
  };
  walk(value, 0);
  return sources;
}

export function collectSources(answer: string, metadata: unknown[]): Source[] {
  const sources = metadata.flatMap(providerSources);
  for (const match of answer.matchAll(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
  )) {
    const url = safeUrl(match[2]);
    if (url)
      sources.push({ url, title: match[1].slice(0, 300), origin: "answer" });
  }
  return [...new Map(sources.reverse().map((s) => [s.url, s])).values()]
    .reverse()
    .slice(0, 40);
}

export function cleanDisplayText(text: string): string {
  // Groq sometimes emits browser line-reference tokens without their URL mapping.
  // Do not invent a source URL or claim those references are verified citations.
  return text
    .replace(/【\d+†L[^】]*】/g, " [source reference]")
    .replace(/〖[^〗]*〗/g, " [source reference]")
    .replace(/cite[^]*/g, " [source reference]");
}

/** Groq's browser returns numbered search results and line-numbered opened pages.
 * Map IDs only when the actual tool output and result-array cardinalities agree. */
export function browserEvidence(
  rawText: string,
  tools: unknown[],
): {
  text: string;
  evidence: EvidenceExcerpt[];
  unresolved: boolean;
} {
  const refs = new Map<string, Source>();
  const ambiguous = new Set<string>();
  const pages = new Map<string, { title: string; text: string }>();
  for (const value of tools) {
    const tool = record(value);
    const output = typeof tool.output === "string" ? tool.output : "";
    const results = record(tool.search_results).results;
    if (Array.isArray(results)) {
      const ids = [
        ...new Set(
          [...output.matchAll(/【(\d+)†(?!L\d)/g)].map((match) => match[1]),
        ),
      ];
      if (ids.length === results.length)
        results.forEach((result, index) => {
          const item = record(result);
          const url = safeUrl(item.url);
          if (!url) return;
          const existing = refs.get(ids[index]);
          if (existing && existing.url !== url) ambiguous.add(ids[index]);
          refs.set(ids[index], {
            url,
            title: String(item.title || new URL(url).hostname),
            origin: "provider",
          });
          if (typeof item.content === "string" && item.content.trim())
            pages.set(url, {
              title: String(item.title || url),
              text: item.content,
            });
        });
    }
    const url = safeUrl(
      output.match(/(?:^|\n)L\d+: URL: (https?:\/\/\S+)/)?.[1],
    );
    if (url && !/https?:\/\/exa\.ai\/search/.test(url)) {
      const known = [...refs.values()].find((source) => source.url === url);
      pages.set(url, {
        title: known?.title ?? new URL(url).hostname,
        text: output,
      });
    }
  }
  const citedLines = new Map<string, Set<number>>();
  let unresolved = false;
  const replace = (
    _whole: string,
    id: string,
    start: string,
    end?: string,
  ): string => {
    const source = ambiguous.has(id) ? undefined : refs.get(id);
    if (!source) {
      unresolved = true;
      return " [source reference unavailable]";
    }
    const lines = citedLines.get(source.url) ?? new Set<number>();
    const first = Number(start);
    const last = Math.min(Number(end ?? start), first + 50);
    for (let line = Math.max(0, first - 3); line <= last + 3; line++)
      lines.add(line);
    citedLines.set(source.url, lines);
    return `[${Number(id) + 1}](${source.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  };
  const text = rawText.replace(
    /[【〖](\d+)†L(\d+)(?:-L?(\d+))?[】〗]/g,
    replace,
  );
  const evidence: EvidenceExcerpt[] = [];
  let remaining = 8000;
  // Cited passages first; material not exposed by the provider is never reconstructed.
  const ordered = [...new Set([...citedLines.keys(), ...pages.keys()])];
  const perPage = Math.min(
    2000,
    Math.floor(
      8000 / Math.max(1, ordered.filter((url) => pages.has(url)).length),
    ),
  );
  for (const url of ordered) {
    const page = pages.get(url);
    if (!page) continue;
    const selected = citedLines.get(url);
    let excerpt = selected
      ? page.text
          .split("\n")
          .filter((line) => {
            const number = line.match(/^L(\d+):/);
            return number && selected.has(Number(number[1]));
          })
          .join("\n")
      : page.text;
    if (!excerpt.trim()) excerpt = page.text;
    excerpt = excerpt.slice(0, Math.min(perPage, remaining));
    if (!excerpt) break;
    evidence.push({ url, title: page.title, text: excerpt });
    remaining -= excerpt.length;
    if (remaining <= 0) break;
  }
  return { text, evidence, unresolved };
}
