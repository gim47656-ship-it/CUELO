"use client";

import { useEffect, useRef, useState } from "react";
import { cleanInterpreterAssist, HISTORY_MAX_LINES, INTERPRETER_TEXT_OUTPUT_MAX_CHARS, type InterpreterAssistParts, type InterpreterAssistResult, type InterpreterContext } from "@/lib/translator-context";

export interface AssistLine {
  id: string;
  mine: string;
  theirs: string;
  speaker: "mine" | "theirs";
  text: string;
  interpretation?: string;
}
export interface AssistSettings { replies: boolean; meaning: boolean }
interface AssistEntry { controller: AbortController; lineId: string; settled: boolean }
interface AssistCache { parts: InterpreterAssistParts; result: InterpreterAssistResult }

export function lineAssistParts(line: AssistLine, settings: AssistSettings): InterpreterAssistParts {
  return { replies: line.speaker === "theirs" && settings.replies, nuance: line.speaker === "theirs" && settings.meaning, check: line.speaker === "mine" && settings.meaning && !!line.interpretation };
}

export function lineAssistKey(line: AssistLine, parts: InterpreterAssistParts): string {
  return JSON.stringify([JSON.stringify([line.id, line.mine, line.theirs, line.speaker, line.text, line.interpretation]), parts.replies, parts.nuance, parts.check]);
}

/** A settled superset can satisfy a narrower toggle selection without another call. */
export function cachedLineAssist(results: Record<string, AssistCache>, line: AssistLine, parts: InterpreterAssistParts) {
  const cached = results[lineAssistKey(line, { replies: false, nuance: false, check: false })];
  const missing = { replies: parts.replies && !cached?.parts.replies, nuance: parts.nuance && !cached?.parts.nuance, check: parts.check && !cached?.parts.check };
  return { result: cleanInterpreterAssist(cached?.result, parts, line.speaker), missing, complete: !missing.replies && !missing.nuance && !missing.check };
}

/** Each finished line/parts combination is tried once. Failure never affects interpretation. */
export function useLineAssist(lines: readonly AssistLine[], settings: AssistSettings, context: InterpreterContext, enabled: boolean) {
  const requests = useRef(new Map<string, AssistEntry>());
  const [results, setResults] = useState<Record<string, AssistCache>>({});
  const contextRef = useRef(context);
  contextRef.current = context;
  const liveBasesRef = useRef(new Set<string>());
  liveBasesRef.current = new Set(lines.map((line) => lineAssistKey(line, { replies: false, nuance: false, check: false })));
  const latestOther = lines.findLast((line) => line.speaker === "theirs")?.id;
  const wanted = enabled ? lines.map((line) => ({ line, parts: lineAssistParts(line, { ...settings, replies: settings.replies && line.id === latestOther }) })).filter(({ parts }) => parts.replies || parts.nuance || parts.check) : [];
  // Values, not parent array identity, determine which requests remain valid.
  const signature = JSON.stringify({ wanted, ids: lines.map((line) => line.id) });
  useEffect(() => {
    const { wanted: current, ids } = JSON.parse(signature) as { wanted: { line: AssistLine; parts: InterpreterAssistParts }[]; ids: string[] };
    const jobs = current.map(({ line, parts }) => ({ line, parts: cachedLineAssist(results, line, parts).missing })).filter(({ parts }) => parts.replies || parts.nuance || parts.check);
    const keys = new Set(jobs.map(({ line, parts }) => lineAssistKey(line, parts)));
    for (const [key, request] of requests.current) {
      if (!ids.includes(request.lineId) || (!keys.has(key) && !request.settled)) { request.controller.abort(); requests.current.delete(key); }
    }
    for (const { line, parts } of jobs) {
      const key = lineAssistKey(line, parts);
      if (requests.current.has(key) || cachedLineAssist(results, line, parts).complete) continue;
      const controller = new AbortController();
      const entry: AssistEntry = { controller, lineId: line.id, settled: false };
      requests.current.set(key, entry);
      void (async () => {
        const timeout = setTimeout(() => controller.abort(), 28_000);
        try {
          const response = await fetch("/api/live/interpret/assist", {
            method: "POST", headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ ...line, parts, context: { ...contextRef.current, history: contextRef.current.history.slice(-HISTORY_MAX_LINES).map((item) => ({ ...item, text: item.text.slice(0, INTERPRETER_TEXT_OUTPUT_MAX_CHARS) })) } }),
          });
          if (!response.ok) return;
          const result = cleanInterpreterAssist(await response.json(), parts, line.speaker);
          if (controller.signal.aborted || requests.current.get(key) !== entry) return;
          const base = lineAssistKey(line, { replies: false, nuance: false, check: false });
          if (!liveBasesRef.current.has(base)) return;
          setResults((previous) => {
            const cached = previous[base];
            const liveBases = liveBasesRef.current;
            return { ...Object.fromEntries(Object.entries(previous).filter(([id]) => liveBases.has(id))), [base]: { result: { ...cached?.result, ...result }, parts: { replies: parts.replies || !!cached?.parts.replies, nuance: parts.nuance || !!cached?.parts.nuance, check: parts.check || !!cached?.parts.check } } };
          });
        } catch { /* Assist is optional: no banner, retry or translation changes. */ }
        finally { clearTimeout(timeout); entry.settled = true; }
      })();
    }
  }, [signature, results]);
  useEffect(() => {
    const active = requests.current;
    return () => { for (const request of active.values()) request.controller.abort(); active.clear(); };
  }, []);
  const byLine = new Map<string, InterpreterAssistResult>();
  for (const { line, parts } of wanted) {
    const { result } = cachedLineAssist(results, line, parts);
    if (Object.keys(result).length) byLine.set(line.id, result);
  }
  return byLine;
}
