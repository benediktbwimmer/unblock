import { slugify, type ImportedMarkdownTask, type MarkdownImportPlan } from "./types.js";

interface SectionContext {
  sourceDoc: string | null;
  sourceSection: string | null;
  prefix: string;
  nextSequence: number;
}

const defaultPrefixes = new Map<string, string>([
  ["prism-engine-v1", "V1"],
  ["runtime", "RUNTIME"],
  ["programming", "PROGRAMMING"],
  ["coordination", "COORDINATION"],
  ["orchestration", "ORCH"],
  ["data", "DATA"],
  ["execution", "EXEC"],
  ["security", "SEC"],
  ["window", "WINDOW"],
  ["future", "FUTURE"]
]);

export function parseMarkdownTracker(filePath: string, markdown: string): MarkdownImportPlan {
  const lines = markdown.split(/\r?\n/);
  const tasks: ImportedMarkdownTask[] = [];
  const issues: MarkdownImportPlan["issues"] = [];
  let section: SectionContext = {
    sourceDoc: null,
    sourceSection: null,
    prefix: "TASK",
    nextSequence: 1
  };
  const prefixesSeen = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    const heading = raw.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      section = sectionFromHeading(heading[2] ?? "", prefixesSeen);
      continue;
    }

    if (!raw.trim().startsWith("|")) {
      continue;
    }
    if (/^\|\s*-+\s*\|/.test(raw) || /\|\s*Done\s*\|/i.test(raw)) {
      continue;
    }

    const cells = splitMarkdownTableRow(raw);
    if (cells.length < 2) {
      issues.push({ line: lineNumber, message: "Malformed table row.", source: raw });
      continue;
    }

    const doneCell = cells[0]?.trim() ?? "";
    const featureCell = stripInlineMarkdown(cells[1]?.trim() ?? "");
    const assigneeCell = stripInlineMarkdown(cells[2]?.trim() ?? "");
    const completionBarCell = stripInlineMarkdown(cells[3]?.trim() ?? "");

    if (!featureCell) {
      issues.push({ line: lineNumber, message: "Missing feature text.", source: raw });
      continue;
    }

    const lifecycle = /\[[xX]\]/.test(doneCell) ? "finished" : "open";
    const id = `${section.prefix}-${String(section.nextSequence).padStart(3, "0")}`;
    section.nextSequence += 1;

    tasks.push({
      id,
      parentTaskId: null,
      title: featureCell,
      lifecycle,
      sourceDoc: section.sourceDoc,
      sourceSection: section.sourceSection,
      sourceLine: lineNumber,
      sourceText: raw,
      completionBar: completionBarCell || null,
      assignee: assigneeCell && !/^none$/i.test(assigneeCell) ? assigneeCell : null
    });
  }

  return { filePath, tasks, issues };
}

function sectionFromHeading(text: string, prefixesSeen: Map<string, number>): SectionContext {
  const docMatch = text.match(/`([^`]+)`/);
  const sourceDoc = docMatch?.[1] ?? null;
  const clean = stripInlineMarkdown(text).replace(/\s+-\s+/, " ").trim();
  const sourceSection = clean || null;
  const slug = slugify(clean);
  const explicit = [...defaultPrefixes.entries()].find(([needle]) => slug.includes(needle))?.[1];
  const basePrefix = explicit ?? slug.split("-").filter(Boolean).slice(0, 2).map((part) => part.slice(0, 4).toUpperCase()).join("");
  const count = (prefixesSeen.get(basePrefix) ?? 0) + 1;
  prefixesSeen.set(basePrefix, count);
  return {
    sourceDoc,
    sourceSection,
    prefix: count === 1 ? basePrefix : `${basePrefix}${count}`,
    nextSequence: 1
  };
}

function splitMarkdownTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
