export function normalizeMatchValue(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, "").toLocaleLowerCase();
}

export function pdfBaseName(filename: string) {
  return filename.replace(/\.pdf$/i, "");
}

function filenameCandidates(filename: string) {
  const base = pdfBaseName(filename).normalize("NFKC").trim().toLocaleLowerCase();
  const tokens = base.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const candidates = new Set<string>([normalizeMatchValue(base)]);

  // Join every consecutive token group so names containing a separator can
  // still match, while requiring a real filename boundary around the name.
  for (let start = 0; start < tokens.length; start++) {
    let combined = "";
    for (let end = start; end < tokens.length; end++) {
      combined += tokens[end];
      candidates.add(normalizeMatchValue(combined));
    }
  }
  return candidates;
}

export function resolveFilename(filename: string, names: string[]) {
  const candidates = filenameCandidates(filename);
  const matches = names.filter((name) => candidates.has(normalizeMatchValue(name)));
  return matches.length === 1
    ? { status: "matched" as const, name: matches[0] }
    : matches.length > 1
      ? { status: "ambiguous" as const, names: matches }
      : { status: "unmatched" as const };
}
