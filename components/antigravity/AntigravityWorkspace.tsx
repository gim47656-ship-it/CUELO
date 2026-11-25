"use client";

import { memo, useEffect, useRef, useState } from "react";
import { ActionButton, Menu } from "@seed-design/react";
import Image from "next/image";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { MessageView } from "@/components/MessageView";
import { WorkbenchIcon } from "@/components/workspace/WorkbenchIcon";
import { useI18n } from "@/hooks/useI18n";
import { ANTIGRAVITY_API, antigravityFetch, browserProblem, useAntigravitySession, type BrowserProblem } from "@/hooks/useAntigravitySession";
import { copyText } from "@/lib/clipboard";
import type { AntigravityEntry, AntigravitySessionInfo, AntigravityTool } from "@/lib/antigravity/types";
import type { ImageContent, TextContent } from "@/lib/types";
import styles from "./workspace.module.css";

const NAME = "Antigravity";
interface Character { alias: string; faceUrl: string | null }
interface HistoryPage { sessions: AntigravitySessionInfo[]; nextCursor?: string }

type OpenTarget = { sessionId?: string };
const toolStatus = {
  pending: "antigravity.pending",
  in_progress: "antigravity.running",
  completed: "antigravity.completed",
  failed: "antigravity.failed",
} as const;

function LoginCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  return (
    <>
      <div className={styles.loginCommand}>
        <pre><code>{command}</code></pre>
        <ActionButton type="button" variant="neutralWeak" size="small" onClick={() => {
          void copyText(command).then(() => setResult("copied"), () => setResult("failed"));
        }}>{t("updates.copyCommand")}</ActionButton>
      </div>
      {result && <span role="status">{t(result === "copied" ? "updates.commandCopied" : "updates.copyFailed")}</span>}
    </>
  );
}

function Problem({ issue, retry }: { issue: BrowserProblem; retry?: () => void }) {
  const { t } = useI18n();
  const auth = issue.code === "auth_required";
  const title = auth ? "antigravity.authTitle" : issue.code === "disconnected" ? "antigravity.disconnected"
    : issue.code === "not_installed" ? "antigravity.notInstalled" : issue.code === "update_draining" ? "antigravity.updating"
    : issue.code === "model_required" ? "antigravity.chooseModel" : "antigravity.unavailable";
  return (
    <section role="alert" className={styles.notice}>
      <strong>{t(title)}</strong>
      {auth ? (
        <>
          <div>{t("antigravity.authInstruction")}</div>
          <LoginCommand command={issue.command ?? "agy acp --login"} />
        </>
      ) : (issue.code === "bad_request" || issue.code === "unavailable") && <div>{issue.error}</div>}
      {retry && <ActionButton type="button" variant={auth ? "neutralSolid" : "neutralWeak"} size="small" onClick={retry}>{t("antigravity.retry")}</ActionButton>}
    </section>
  );
}

function ToolDetails({ tool, open = false }: { tool: AntigravityTool; open?: boolean }) {
  const { t } = useI18n();
  return (
    <details className={styles.tool} open={open || undefined}>
      <summary>
        <span className={styles.toolTitle}>{tool.title}</span>
        <span className={styles.toolStatus} data-status={tool.status}>{t(toolStatus[tool.status])}</span>
      </summary>
      {tool.paths?.map((path, index) => <code className={styles.path} key={`${path}:${index}`}>{path}</code>)}
      {tool.input && <><div className={styles.detailLabel}>{t("antigravity.command")}</div><pre>{tool.input}</pre></>}
      {tool.diffs?.map(({ path, oldText, newText }, index) => (
        <section className={styles.diff} key={`${path}:${index}`}>
          <code className={styles.path}>{path}</code>
          <div className={styles.diffColumns}>
            {oldText !== null && <div><div className={styles.detailLabel}><span aria-hidden="true">− </span>{t("antigravity.before")}</div><pre className={styles.before}>{oldText}</pre></div>}
            <div><div className={styles.detailLabel}><span aria-hidden="true">+ </span>{t("antigravity.after")}</div><pre className={styles.after}>{newText}</pre></div>
          </div>
        </section>
      ))}
      {tool.output && <><div className={styles.detailLabel}>{t("antigravity.output")}</div><pre>{tool.output}</pre></>}
    </details>
  );
}

function Avatar({ character }: { character: Character | null }) {
  return character?.faceUrl
    ? <Image className={styles.avatar} src={character.faceUrl} width={32} height={32} alt="" unoptimized />
    : <span className={styles.avatar}><WorkbenchIcon name="bot" size={19} /></span>;
}

const Entry = memo(function Entry({ entry, character, streaming }: { entry: AntigravityEntry; character: Character | null; streaming: boolean }) {
  if (entry.type === "tool") return <ToolDetails tool={entry.tool} open={Boolean(entry.tool.diffs?.length)} />;
  const content = entry.content.map((block): TextContent | ImageContent => block.type === "resource"
    ? { type: "text", text: block.resource.text }
    : block.type === "resource_link" ? { type: "text", text: block.name }
      : block.type === "image" ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } : block);
  if (entry.type === "user") return <MessageView message={{ role: "user", content }} />;
  return (
    <div className={styles.agentEntry}>
      {entry.type === "assistant" && <div className={styles.speaker}><Avatar character={character} /><strong>{character?.alias ?? NAME}</strong></div>}
      <MessageView message={{ role: "assistant", provider: "", model: "", content: entry.type === "thought"
        ? [{ type: "thinking", thinking: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("") }]
        : content }} isStreaming={streaming} />
    </div>
  );
});

function Conversation({ session, revision, character, onRetry, onSessionUpdate, onAuthRequired }: { session: AntigravitySessionInfo; revision: number; character: Character | null; onRetry: () => void; onSessionUpdate: (info: AntigravitySessionInfo) => void; onAuthRequired: (sessionId: string | null) => void }) {
  const { t } = useI18n();
  const chat = useAntigravitySession(session, revision);
  const composer = useRef<ChatInputHandle>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const { state, streamProblem, actionProblem, recovery } = chat;
  const info = state?.session;
  useEffect(() => { if (info) onSessionUpdate(info); }, [info, onSessionUpdate]);
  useEffect(() => {
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state]);
  const permissionToolIds = new Set(state?.permissions.map(({ tool }) => tool.id));
  const issue = streamProblem ?? actionProblem ?? state?.problem;
  const authRequired = issue?.code === "auth_required";
  useEffect(() => { onAuthRequired(authRequired ? session.sessionId : null); }, [authRequired, session.sessionId, onAuthRequired]);
  const model = state?.options.find((option) => option.kind === "model");
  return (
    <>
      <div ref={scroll} className={styles.transcript} onScroll={(event) => {
        const frame = event.currentTarget;
        following.current = frame.scrollHeight - frame.clientHeight - frame.scrollTop < 120;
      }}>
        <div className={styles.column}>
          {!state && !issue && <div role="status">{t("antigravity.opening")}</div>}
          {state && !state.entries.length && !issue && <p className={styles.hint}>{t("antigravity.emptyConversation")}</p>}
          {state?.entries.map((entry, index) => entry.type === "tool" && permissionToolIds.has(entry.tool.id) ? null
            : <Entry entry={entry} key={entry.key} character={character} streaming={state.streaming && index === state.entries.length - 1} />)}
          {state?.plan.length ? (
            <details className={styles.tool}>
              <summary>{t("antigravity.plan")}</summary>
              <ul>{state.plan.map((item, index) => <li key={index}>{item.content} <small>{t(toolStatus[item.status as keyof typeof toolStatus] ?? item.status)}</small></li>)}</ul>
            </details>
          ) : null}
          {state?.permissions.map(({ id, tool, canAllow }) => (
            <section key={id} className={styles.permission} aria-label={t("antigravity.permission")}>
              <strong><WorkbenchIcon name="circle-alert" /> {t("antigravity.permission")}</strong>
              <ToolDetails tool={tool} open />
              <div className={styles.actions}>
                <ActionButton type="button" variant="neutralWeak" size="medium" disabled={chat.deciding !== null || Boolean(streamProblem)} onClick={(event) => { if (event.nativeEvent.isTrusted) void chat.decide(id, false); }}>{t("antigravity.deny")}</ActionButton>
                <ActionButton type="button" variant="neutralSolid" size="medium" disabled={!canAllow || chat.deciding !== null || Boolean(streamProblem)} onClick={(event) => { if (event.nativeEvent.isTrusted) void chat.decide(id, true); }}>{t("antigravity.allow")}</ActionButton>
              </div>
            </section>
          ))}
          {issue && <Problem issue={issue} retry={streamProblem || issue.code === "auth_required" ? onRetry : undefined} />}
          {recovery && (
            <div role="status" className={styles.notice}>
              <div>{t(state && recovery.serverId !== state.serverId ? "antigravity.restarted" : "antigravity.interrupted")}</div>
              {state && !state.streaming && !streamProblem && (
                <ActionButton type="button" variant="neutralWeak" size="small" onClick={() => {
                  const { value, images, documents } = recovery.draft;
                  composer.current?.restoreSubmission(value, images, documents);
                  chat.restored();
                }}>{t("antigravity.restore")}</ActionButton>
              )}
            </div>
          )}
        </div>
      </div>
      <ChatInput ref={composer} draftKey={`antigravity:${session.cwd}:${session.sessionId}`} cwd={session.cwd}
        onSend={(...args) => { following.current = true; return chat.send(...args); }} onAbort={() => { void chat.cancel(); }}
        isStreaming={Boolean(state?.streaming)} external={{
          sendDisabled: !model?.current || Boolean(streamProblem) || authRequired || chat.switching || Boolean(state?.cancelling),
          controls: state?.options.map((option) => (
            <Menu.Root key={option.id} placement="top-start" strategy="fixed">
              <Menu.Trigger asChild>
                <button type="button" className={`composer-chip ${styles.picker}`}
                  disabled={Boolean(state.streaming || chat.switching || streamProblem || authRequired) || !option.choices.length}
                  aria-label={t(`antigravity.${option.kind}`)}>
                  <span>{option.choices.find(({ value }) => value === option.current)?.name
                    ?? t(option.kind === "model" ? "antigravity.chooseModel" : "antigravity.thinking")}</span>
                  <WorkbenchIcon name="chevron-down" size={12} />
                </button>
              </Menu.Trigger>
              <Menu.Positioner>
                <Menu.Content aria-label={t(`antigravity.${option.kind}`)}>
                  <Menu.ScrollArea>
                    {option.choices.map(({ value, name }) => (
                      <Menu.Item key={value} role="menuitemradio" aria-checked={value === option.current}
                        onClick={() => {
                          if (value !== option.current) void chat.setOption(option.id, value);
                        }}>
                        <Menu.ItemBody><Menu.ItemLabel>{name}</Menu.ItemLabel></Menu.ItemBody>
                      </Menu.Item>
                    ))}
                  </Menu.ScrollArea>
                </Menu.Content>
              </Menu.Positioner>
            </Menu.Root>
          )),
        }} />
    </>
  );
}

export function AntigravityWorkspace(props: { cwd: string | null; onBack: () => void }) {
  const { t } = useI18n();
  // Fetch Metadata is unavailable to browsers on plain HTTP LAN origins.
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return <section className={styles.workspace} aria-label={NAME} data-antigravity-workspace>
      <header className={styles.header}>
        <ActionButton type="button" size="small" variant="ghost" layout="iconOnly" aria-label={t("antigravity.back")} onClick={props.onBack}><WorkbenchIcon name="x" /></ActionButton>
        <strong>{NAME}</strong>
      </header>
      <div role="alert" className={styles.headerStatus}>{t("antigravity.insecureOrigin")}</div>
    </section>;
  }
  return <ConnectedWorkspace {...props} />;
}

function ConnectedWorkspace({ cwd, onBack }: { cwd: string | null; onBack: () => void }) {
  const { t } = useI18n();
  const [character, setCharacter] = useState<Character | null>(null);
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [issue, setIssue] = useState<BrowserProblem | null>(null);
  const [session, setSession] = useState<AntigravitySessionInfo | null>(null);
  const [authSessionId, setAuthSessionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [showHistory, setShowHistory] = useState(true);
  const [opening, setOpening] = useState(false);
  const lastOpen = useRef<OpenTarget | null>(null);
  const pending = useRef(false);
  const storageKey = `cuelo-antigravity-open:${cwd}`;
  const authRequired = issue?.code === "auth_required" || (session !== null && authSessionId === session.sessionId);

  useEffect(() => {
    const controller = new AbortController();
    void antigravityFetch<{ character: Character | null }>(`${ANTIGRAVITY_API}/character`, undefined, controller.signal)
      .then((result) => setCharacter(result.character)).catch(() => { /* The neutral avatar needs no assets. */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!cwd || !showHistory) return;
    const controller = new AbortController();
    const url = `${ANTIGRAVITY_API}?${new URLSearchParams({ cwd })}`;
    void antigravityFetch<HistoryPage>(url, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setHistory(result);
      if (!pending.current) setIssue((current) => current?.code === "auth_required" ? null : current);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !pending.current) setIssue(browserProblem(error));
    });
    return () => controller.abort();
  }, [cwd, listRevision, showHistory]);

  // Restore only the view. Reopening ACP history never sends a prompt.
  useEffect(() => {
    if (!cwd) return;
    let sessionId: string | null = null;
    try { sessionId = sessionStorage.getItem(storageKey); } catch { return; }
    if (!sessionId) return;
    const controller = new AbortController();
    void antigravityFetch<{ session: AntigravitySessionInfo }>(ANTIGRAVITY_API, { cwd, sessionId }, controller.signal).then(({ session }) => {
      if (controller.signal.aborted || pending.current) return;
      setSession(session);
      setShowHistory(false);
      setIssue(null);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || pending.current) return;
      lastOpen.current = { sessionId };
      setIssue(browserProblem(error));
    });
    return () => controller.abort();
  }, [cwd, storageKey]);

  async function open(target: OpenTarget) {
    if (!cwd || pending.current) return;
    pending.current = true;
    lastOpen.current = target;
    setOpening(true);
    try {
      const result = await antigravityFetch<{ session: AntigravitySessionInfo }>(ANTIGRAVITY_API, { cwd, ...target });
      setIssue(null);
      setSession(result.session);
      setRevision((value) => value + 1);
      setShowHistory(false);
      try { sessionStorage.setItem(storageKey, result.session.sessionId); } catch { /* Tab restoration is optional. */ }
    } catch (error) { setIssue(browserProblem(error)); }
    finally { pending.current = false; setOpening(false); }
  }

  function retry() {
    if (lastOpen.current) void open(lastOpen.current);
    else setListRevision((value) => value + 1);
  }

  async function more() {
    if (!cwd || !history?.nextCursor) return;
    try {
      const page = await antigravityFetch<HistoryPage>(`${ANTIGRAVITY_API}?${new URLSearchParams({ cwd, cursor: history.nextCursor })}`);
      setHistory({ sessions: [...history.sessions, ...page.sessions], nextCursor: page.nextCursor });
    } catch (error) { setIssue(browserProblem(error)); }
  }

  return (
    <section className={styles.workspace} aria-label={NAME} data-antigravity-workspace>
      <header className={styles.header}>
        <ActionButton type="button" size="small" variant="ghost" layout="iconOnly" aria-label={t("antigravity.back")} title={t("antigravity.back")} onClick={onBack}><WorkbenchIcon name="x" /></ActionButton>
        <div className={styles.identity}>
          <strong>{NAME}</strong>
          {session?.title && <span title={session.title}>{session.title}</span>}
          {cwd && <span title={cwd}>{cwd}</span>}
        </div>
        {!authRequired && <>
          <ActionButton type="button" size="small" variant="neutralWeak" disabled={!cwd || opening} aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>{t("antigravity.history")}</ActionButton>
          <ActionButton type="button" size="small" variant="neutralSolid" disabled={!cwd || opening} onClick={() => void open({})}>{t("antigravity.newConversation")}</ActionButton>
        </>}
      </header>
      {opening && <div className={styles.headerStatus} role="status">{t("antigravity.opening")}</div>}
      {issue && <div className={styles.headerStatus}><Problem issue={issue} retry={retry} /></div>}
      {cwd && showHistory && !authRequired && (
        <section className={styles.history} aria-label={t("antigravity.history")}>
          {!history && !issue ? <p role="status">{t("antigravity.opening")}</p> : history?.sessions.length === 0 ? <p>{t("antigravity.noHistory")}</p> : null}
          {history?.sessions.map((item) => (
            <button type="button" key={item.sessionId} className={styles.historyItem} aria-current={item.sessionId === session?.sessionId ? "true" : undefined} disabled={opening} onClick={() => void open({ sessionId: item.sessionId })}>
              <WorkbenchIcon name="message-square" /><span>{item.title ?? t("antigravity.defaultTitle")}</span>
            </button>
          ))}
          {history?.nextCursor && <ActionButton type="button" variant="ghost" size="small" onClick={() => void more()}>{t("antigravity.moreHistory")}</ActionButton>}
        </section>
      )}
      {session ? <Conversation key={session.sessionId} revision={revision} session={session} character={character} onSessionUpdate={setSession} onAuthRequired={setAuthSessionId} onRetry={() => void open({ sessionId: session.sessionId })} />
        : !authRequired && <div className={styles.empty}><Avatar character={character} /><strong>{character?.alias ?? NAME}</strong><p>{t(cwd ? "antigravity.startHint" : "antigravity.noProject")}</p></div>}
    </section>
  );
}
