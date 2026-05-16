import { useCallback, useEffect, useRef } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { fetchJson, getKeyboardShortcuts } from "../api";
import type { MatcherFieldValueSuggestionRecord, MatcherGrammarRecord } from "../types";

export function TopMatcherEditor({
  value,
  projectId,
  grammar,
  suggestSignal,
  variant = "matcher",
  onChange,
  onApply
}: {
  value: string;
  projectId: string;
  grammar: MatcherGrammarRecord | null;
  suggestSignal: number;
  variant?: "matcher" | "query";
  onChange: (value: string) => void;
  onApply: () => void;
}) {
  const completionProviderRef = useRef<{ dispose: () => void } | null>(null);
  const editorRef = useRef<any>(null);
  const onApplyRef = useRef(onApply);

  useEffect(() => {
    onApplyRef.current = onApply;
  }, [onApply]);

  useEffect(() => () => completionProviderRef.current?.dispose(), []);

  useEffect(() => {
    if (suggestSignal > 0 && editorRef.current) {
      editorRef.current.focus();
      editorRef.current.trigger("toolbar", "editor.action.triggerSuggest", {});
    }
  }, [suggestSignal]);

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    if (grammar) {
      completionProviderRef.current?.dispose();
      completionProviderRef.current = registerMatcherCompletions(monaco, projectId, grammar, variant);
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      editor.trigger("keyboard", "editor.action.triggerSuggest", {});
    });
    editor.onKeyDown((event: any) => {
      if (event.keyCode !== monaco.KeyCode.Enter && event.browserEvent.key !== "Enter") {
        return;
      }
      if (event.shiftKey || event.browserEvent.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.browserEvent.preventDefault();
        event.browserEvent.stopPropagation();
        editor.trigger("keyboard", "hideSuggestWidget", {});
        onApplyRef.current();
        return;
      }
      const suggestVisible = Boolean((editor as any)._contextKeyService?.getContextKeyValue?.("suggestWidgetVisible"));
      if (!suggestVisible) {
        event.preventDefault();
        event.stopPropagation();
        event.browserEvent.preventDefault();
        event.browserEvent.stopPropagation();
      }
    });
  }, [grammar, projectId, variant]);

  return (
    <div
      className="top-matcher-editor"
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          editorRef.current?.trigger("keyboard", "hideSuggestWidget", {});
          onApplyRef.current();
        }
      }}
    >
      <Editor
        key={`${projectId}-${grammar ? "ready" : "loading"}-${variant}-top-matcher`}
        height="34px"
        defaultLanguage="unblock-query"
        language="unblock-query"
        theme="unblock"
        beforeMount={configureMatcherLanguage}
        onMount={handleMount}
        value={value}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          lineHeight: 22,
          lineNumbers: "off",
          folding: false,
          wordWrap: "off",
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          renderLineHighlight: "none",
          glyphMargin: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          scrollbar: { horizontal: "hidden", vertical: "hidden" },
          padding: { top: 6, bottom: 0 },
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          fixedOverflowWidgets: true
        }}
        onChange={(next) => onChange((next ?? "").replace(/\s*\r?\n\s*/g, " "))}
      />
    </div>
  );
}

export function MatcherGrammarPanel({ grammar }: { grammar: MatcherGrammarRecord | null }) {
  return (
    <aside className="instruction-grammar-panel">
      <div>
        <h2>Matcher Reference</h2>
        <p>Generated from the matcher definition used by CLI, API, and preview.</p>
      </div>
      {grammar ? (
        <>
          <section>
            <h3>Clauses</h3>
            <div className="grammar-clause-list">
              {grammar.clauses.map((clause) => (
                <div className="grammar-clause" key={clause.name}>
                  <strong>{clause.name}</strong>
                  {clause.forms.map((form) => <code key={form}>{form}</code>)}
                  <p>{clause.description}</p>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3>Fields</h3>
            <div className="grammar-chip-list">
              {grammar.fields.map((field) => <code key={field}>{field}</code>)}
            </div>
          </section>
          <section>
            <h3>Operators</h3>
            <p>Fields: {grammar.fieldOperators.join(" ")}</p>
            <p>Counts and depth: {grammar.comparisonOperators.join(" ")}</p>
            <p>Boolean: {grammar.booleanOperators.join(", ")}</p>
          </section>
          <section>
            <h3>Values</h3>
            <div className="grammar-value-list">
              {grammar.valueForms.map((value) => (
                <p key={value.name}><strong>{value.name}</strong>: {value.description}</p>
              ))}
            </div>
          </section>
          <section>
            <h3>Graph</h3>
            <p>{grammar.graphVerbs.join(" / ")}</p>
            <p>{grammar.edgeKinds.join(" + ")}</p>
          </section>
          <section>
            <h3>Notes</h3>
            <ul>
              {grammar.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
          <section>
            <h3>Examples</h3>
            <div className="grammar-examples">
              {grammar.examples.map((example) => <code key={example}>{example}</code>)}
            </div>
          </section>
        </>
      ) : (
        <p className="muted">Loading grammar...</p>
      )}
    </aside>
  );
}

export const configureMatcherLanguage: BeforeMount = (monaco) => {
  const languageId = "unblock-query";
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === languageId)) {
    monaco.languages.register({ id: languageId });
  }
  monaco.languages.setMonarchTokensProvider(languageId, {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\b(filter|search|and|or|not|in|is|empty|now|today|depth|tag|assigned|machine|actor|status|lifecycle|parent|priority|created|updated|started|finished|archived|id|source|doc|section|descendant|of)\b/, "keyword"],
        [/\b(depends|on|unblocks)\b/, "keyword.graph"],
        [/[()]/, "delimiter.parenthesis"],
        [/,/, "delimiter"],
        [/(>=|<=|!=|=|>|<)/, "operator"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        [/\d+/, "number"],
        [/[A-Za-z0-9._:/-]+/, "identifier"]
      ]
    }
  });
  monaco.languages.setLanguageConfiguration(languageId, {
    comments: { lineComment: "#" },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" }
    ]
  });
  monaco.editor.defineTheme("unblock", {
    base: window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "176f53", fontStyle: "bold" },
      { token: "keyword.graph", foreground: "2f7dd1", fontStyle: "bold" },
      { token: "operator", foreground: "9e3528" },
      { token: "string", foreground: "7a4d00" },
      { token: "number", foreground: "7a4d00" }
    ],
    colors: {
      "editor.background": window.matchMedia("(prefers-color-scheme: dark)").matches ? "#181c23" : "#ffffff",
      "editor.lineHighlightBackground": "#00000000"
    }
  });
};

function registerMatcherCompletions(monaco: any, projectId: string, grammar: MatcherGrammarRecord, variant: "matcher" | "query"): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider("unblock-query", {
    triggerCharacters: [" ", "=", "(", ",", ":", "-", "."],
    provideCompletionItems: async (model: any, position: { lineNumber: number; column: number }) => {
      const rawLine = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const activeFilter = variant === "query" ? activeFilterPrefix(rawLine) : null;
      const line = activeFilter?.text ?? rawLine;
      const token = currentMatcherToken(line);
      const range = new monaco.Range(position.lineNumber, position.column - token.length, position.lineNumber, position.column);
      const context = activeFilter || variant === "matcher" ? getMatcherCompletionContext(line, grammar) : { kind: "query-root" as const };
      const suggestions: unknown[] = [];

      if (context.kind === "query-root") {
        suggestions.push(
          {
            label: "filter(...)",
            kind: monaco.languages.CompletionItemKind.Function,
            detail: "structured unblock filter",
            insertText: "filter(${1:status = ready})",
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: "000000",
            range
          },
          {
            label: "search(...)",
            kind: monaco.languages.CompletionItemKind.Function,
            detail: "explicit text search",
            insertText: "search(\"${1:terms}\")",
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: "000001",
            range
          }
        );
      } else if (context.kind === "value") {
        const values = await fetchMatcherValueSuggestions(projectId, context.field, context.prefix || token, 50);
        suggestions.push(...values.map((item, index) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Value,
          detail: `${item.detail}${item.count > 0 ? ` / ${item.count}` : ""}`,
          insertText: isMatcherTimeField(context.field) ? item.value : formatMatcherValue(item.value),
          sortText: completionSortText(index),
          range
        })));
      } else if (context.kind === "operator") {
        const operators = isMatcherTimeField(context.field) ? [...grammar.comparisonOperators, "is empty", "is not empty"] : grammar.fieldOperators;
        suggestions.push(...operators.map((operator) => ({
          label: operator,
          kind: monaco.languages.CompletionItemKind.Operator,
          insertText: operator === "in" ? "in ()" : operator === "not in" ? "not in ()" : operator,
          range
        })));
      } else if (context.kind === "task") {
        const values = await fetchMatcherValueSuggestions(projectId, "id", context.prefix || token, 50);
        suggestions.push(...values.map((item, index) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Reference,
          detail: item.detail,
          insertText: formatMatcherValue(item.value),
          sortText: completionSortText(index),
          range
        })));
        suggestions.push(...grammar.comparisonOperators.map((operator) => ({
          label: operator,
          kind: monaco.languages.CompletionItemKind.Operator,
          detail: "count comparison",
          insertText: operator,
          range
        })));
      } else {
        suggestions.push(...grammar.fields.map((field) => ({
          label: field,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: "field",
          insertText: field,
          range
        })));
        suggestions.push(
          { label: "depends on", kind: monaco.languages.CompletionItemKind.Keyword, detail: "dependency relation", insertText: "depends on ", range },
          { label: "unblocks", kind: monaco.languages.CompletionItemKind.Keyword, detail: "unblocks relation", insertText: "unblocks ", range },
          { label: "descendant of", kind: monaco.languages.CompletionItemKind.Keyword, detail: "hierarchy relation", insertText: "descendant of ", range },
          ...grammar.booleanOperators.map((operator) => ({ label: operator, kind: monaco.languages.CompletionItemKind.Keyword, insertText: operator, range }))
        );
      }

      return { suggestions };
    }
  });
}

function activeFilterPrefix(line: string): { text: string } | null {
  const filterStart = line.toLowerCase().lastIndexOf("filter(");
  if (filterStart === -1) {
    return null;
  }
  const bodyStart = filterStart + "filter(".length;
  let depth = 1;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = bodyStart; index < line.length; index += 1) {
    const char = line[index] ?? "";
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
        return null;
      }
    }
  }
  return { text: line.slice(bodyStart) };
}

function completionSortText(index: number): string {
  return String(index).padStart(6, "0");
}

function getMatcherCompletionContext(line: string, grammar: MatcherGrammarRecord): { kind: "root" } | { kind: "operator"; field: string } | { kind: "task"; prefix: string } | { kind: "value"; field: string; prefix: string } {
  const sortedFields = [...grammar.fields].sort((left, right) => right.length - left.length);
  for (const field of sortedFields) {
    const fieldRegex = fieldMatcherRegex(field);
    const comparison = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s*(?:=|!=|>=|<=|>|<)\\s*([^\\s(),]*)$`, "i"));
    if (comparison) {
      return { kind: "value", field, prefix: comparison[1] ?? "" };
    }
    const membership = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+in\\s*\\([^)]*$`, "i"));
    if (membership) {
      return { kind: "value", field, prefix: currentMatcherToken(line) };
    }
    const negativeMembership = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+not\\s+in\\s*\\([^)]*$`, "i"));
    if (negativeMembership) {
      return { kind: "value", field, prefix: currentMatcherToken(line) };
    }
    if (line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s*$`, "i"))) {
      return { kind: "operator", field };
    }
    if (line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+not\\s*$`, "i"))) {
      return { kind: "operator", field };
    }
  }
  const taskRelation = line.match(/(?:^|[\s(])(?:depends\s+on|unblocks|descendant\s+of)\s+([A-Za-z0-9._:/-]*)$/i);
  if (taskRelation) {
    return { kind: "task", prefix: taskRelation[1] ?? "" };
  }
  return { kind: "root" };
}

function fieldMatcherRegex(field: string): string {
  return field.split(/\s+/).map(escapeRegExp).join("\\s+");
}

function currentMatcherToken(line: string): string {
  return line.match(/[A-Za-z0-9._:/-]*$/)?.[0] ?? "";
}

async function fetchMatcherValueSuggestions(projectId: string, field: string, prefix: string, limit: number): Promise<MatcherFieldValueSuggestionRecord[]> {
  const params = new URLSearchParams({ projectId, field, limit: String(limit) });
  if (prefix) {
    params.set("prefix", prefix);
  }
  return fetchJson<MatcherFieldValueSuggestionRecord[]>(`/api/matcher/suggest?${params.toString()}`);
}

function formatMatcherValue(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value);
}

function isMatcherTimeField(field: string): boolean {
  return field === "created" || field === "updated" || field === "started" || field === "finished" || field === "archived";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
