export interface UnifiedQueryParts {
  search: string;
  filter: string;
  errors: string[];
}

export function parseUnifiedQuery(input: string): UnifiedQueryParts {
  const searchParts: string[] = [];
  const filters: string[] = [];
  const errors: string[] = [];
  let index = 0;

  while (index < input.length) {
    const call = readCall(input, index);
    if (!call) {
      searchParts.push(input[index] ?? "");
      index += 1;
      continue;
    }

    if (!call.closed) {
      errors.push(`${call.name}(...) is missing a closing parenthesis.`);
      break;
    }

    if (call.name === "filter") {
      const filter = call.body.trim();
      if (filter) {
        filters.push(filter);
      }
    } else {
      const search = unquoteSearch(call.body.trim());
      if (search) {
        searchParts.push(` ${search} `);
      }
    }
    index = call.end;
  }

  return {
    search: normalizeSearch(searchParts.join("")),
    filter: filters.join(" and "),
    errors
  };
}

function readCall(input: string, start: number): { name: "filter" | "search"; body: string; end: number; closed: boolean } | null {
  const match = input.slice(start).match(/^(filter|search)\s*\(/i);
  if (!match) {
    return null;
  }
  if (start > 0 && /[A-Za-z0-9_-]/.test(input[start - 1] ?? "")) {
    return null;
  }

  const name = (match[1] ?? "").toLowerCase() as "filter" | "search";
  const bodyStart = start + match[0].length;
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = bodyStart; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return { name, body: input.slice(bodyStart, index), end: index + 1, closed: true };
      }
    }
  }
  return { name, body: input.slice(bodyStart), end: input.length, closed: false };
}

function unquoteSearch(value: string): string {
  if (!value) {
    return "";
  }
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.at(-1) === quote) {
    try {
      return quote === "\"" ? JSON.parse(value) as string : value.slice(1, -1).replace(/\\'/g, "'");
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function normalizeSearch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
