"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TranslationParams } from "@/lib/i18n/types";
import { type RoutinePost, findTitleHeading, splitPostDetails } from "@/lib/routines/post";
import type { RoutineSchedule } from "@/lib/routines/schedule";
import type { RoutinePostSummary } from "@/lib/routines/store";
import {
  type BoardData, type BoardRoutine, type BoardScreen, isNewRoutinePost, markRoutinePostRead, readApiError, refreshRoutineBoard,
  showRoutineScreen, useReadRoutinePosts, useRoutineBoard,
} from "./board-store";
import styles from "./RoutineView.module.css";

/**
 * 루틴 게시판. 사이드바 「루틴」이나 `/?view=routine`으로 열리고, 통역 화면처럼 작업 화면 위에 덮인다.
 * 루틴 하나가 디시 갤러리 하나다: 갤러리 목록 → 게시판 표 → 글 보기, 그리고 루틴 설정 폼. 목록과 게시판 머리에서
 * 루틴이 켜졌는지, 어느 PC에서 언제 다음에 도는지 보이고, 한 번에 끄고 켤 수 있다.
 */

type T = (key: string, params?: TranslationParams) => string;

const KST = "Asia/Seoul";
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const kstParts = (iso: string) => {
  const parts: Record<string, string> = {};
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: KST, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date)) parts[part.type] = part.value;
  return { date: `${parts.year}.${parts.month}.${parts.day}`, md: `${parts.month}.${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};

function boardDate(iso: string): string {
  const parts = kstParts(iso);
  if (!parts) return "-";
  return parts.date === kstParts(new Date().toISOString())?.date ? parts.time : parts.md;
}

const shortDateTime = (iso: string | null) => {
  const parts = iso ? kstParts(iso) : null;
  return parts ? `${parts.md} ${parts.time}` : "-";
};

/** 요청 실패(서버 오류와 네트워크 오류 모두)를 화면에 보일 문장으로 바꾼다. */
async function request<B>(url: string, init: RequestInit, t: T): Promise<{ ok: true; body: B } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return { ok: false, error: await readApiError(res) };
    return { ok: true, body: await res.json() as B };
  } catch (error) {
    return { ok: false, error: t("routines.networkError", { error: error instanceof Error ? error.message : String(error) }) };
  }
}

function daysLabel(days: number[], t: T): string {
  if (days.length === 7) return t("routines.everyDay");
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return t("routines.weekdays");
  return days.map((day) => t(`routines.day.${day}`)).join(", ");
}

function scheduleLabel(schedule: RoutineSchedule, t: T): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (schedule.kind === "weekly") return t("routines.sched.weekly", { days: daysLabel(schedule.days, t), times: schedule.times.join(", ") });
  if (schedule.kind === "once") return t("routines.sched.once", { date: schedule.date, time: schedule.time });
  const rest = schedule.everyHours === 1
    ? t("routines.sched.hourlyOne", { minute: pad(schedule.minute) })
    : t("routines.sched.hourlyN", { every: schedule.everyHours, minute: pad(schedule.minute), start: pad((schedule.startHour ?? 0) % schedule.everyHours) });
  return schedule.days ? t("routines.sched.withDays", { days: daysLabel(schedule.days, t), rest }) : rest;
}

/**
 * 마지막으로 끝난 회차. 글이 남는 회차(글 올림, 실패, 시간 초과)는 어느 PC든 최신 글로 보고, 글 없이 끝난 「알릴 것 없음」은
 * 이 PC의 실행 기록이 그 글보다 나중일 때만 쓴다. 다른 PC에서 글 없이 끝난 회차는 그 PC의 기록이라 여기서는 보이지 않는다.
 */
function lastResult(routine: BoardRoutine): { status: "ok" | "failed" | "timeout" | "quiet"; at: string; fromPost: boolean } | null {
  const post = routine.posts[0];
  const fromPost = post ? { status: post.status, at: post.finishedAt || post.startedAt, fromPost: true } : null;
  const run = routine.lastRun ? { status: routine.lastRun.status, at: routine.lastRun.finishedAt, fromPost: false } : null;
  if (run?.status === "quiet" && (!fromPost || Date.parse(run.at) > Date.parse(fromPost.at))) return run;
  return fromPost ?? run;
}

function lastRunLabel(routine: BoardRoutine, t: T): string | null {
  const result = lastResult(routine);
  return result ? t("routines.lastRun", { time: shortDateTime(result.at), result: t(`routines.lastRun.${result.status}`) }) : null;
}

function NewMark({ t }: { t: T }) {
  return <span className={styles.badge} data-status="new" title={t("routines.newMarkLabel")} aria-label={t("routines.newMarkLabel")}>{t("routines.newMark")}</span>;
}

/** 갤러리 목록 한 줄 아래: 마지막 실행 결과와 시각, 그 아랫줄에 최근 글 제목(누르면 그 글). */
function LatestLine({ routine, read, t }: { routine: BoardRoutine; read: ReadonlySet<string>; t: T }) {
  const result = lastResult(routine);
  const post = routine.posts[0];
  if (!result) return <span className={styles.latest}><span className={styles.latestMeta}>{t("routines.noRunYet")}</span></span>;
  return (
    <span className={styles.latest}>
      <span className={styles.latestMeta}>
        <span className={styles.badge} data-status={result.status}>{t(`routines.lastRun.${result.status}`)}</span>
        <span className={styles.mono}>{shortDateTime(result.at)}</span>
        {post && !result.fromPost ? <span>· {t("routines.col.latest")} {shortDateTime(post.startedAt)}</span> : null}
      </span>
      {post ? (
        <span className={styles.latestMeta}>
          {isNewRoutinePost(routine.id, post, read) ? <NewMark t={t} /> : null}
          <button type="button" className={`${styles.link} ${styles.latestTitle}`} onClick={() => showRoutineScreen({ kind: "post", id: routine.id, file: post.file })}>{post.title}</button>
        </span>
      ) : null}
    </span>
  );
}

/** 글 화면은 제목을 머리에 따로 보이므로, 본문에서 그 제목과 같은 첫 `# ` 제목(코드 블록 밖)을 뺀다. */
function bodyWithoutTitle(body: string, title: string): string {
  const heading = findTitleHeading(body);
  if (!heading || heading.text.replace(/\s+/g, " ") !== title) return body;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  lines.splice(heading.index, 1);
  return lines.join("\n").replace(/^\s+/, "");
}

function StatusBadge({ status, t }: { status: RoutinePostSummary["status"]; t: T }) {
  if (status === "ok") return null;
  return <span className={styles.badge} data-status={status}>{t(`routines.status.${status}`)}</span>;
}

function EnabledBadge({ routine, t }: { routine: BoardRoutine; t: T }) {
  return <span className={styles.badge} data-status={routine.enabled ? "on" : "off"}>{routine.enabled ? t("routines.on") : t("routines.off")}</span>;
}

function SyncLine({ data, t }: { data: BoardData; t: T }) {
  const { sync } = data;
  const parts = [
    sync.syncing ? t("routines.sync.syncing") : sync.lastSyncAt ? t("routines.sync.ok", { time: shortDateTime(sync.lastSyncAt) }) : t("routines.sync.never"),
    ...(sync.pending === null ? [] : [sync.pending > 0 ? t("routines.sync.pending", { count: sync.pending }) : t("routines.sync.nothing")]),
  ];
  return (
    <span className={styles.sync} data-state={sync.lastError ? "error" : undefined} role="status">
      {parts.join(" · ")}
      {sync.lastError ? ` · ${t("routines.sync.error", { error: sync.lastError })}` : null}
    </span>
  );
}

/** 확인 없이 바로 끄고 켜는 버튼. 끝나면 다른 PC에 언제 닿는지 알린다. */
function ToggleButton({ routine, t, onMessage }: { routine: BoardRoutine; t: T; onMessage: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const enabled = !routine.enabled;
    const result = await request(`/api/routines/${encodeURIComponent(routine.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
    }, t);
    onMessage(result.ok ? t(enabled ? "routines.toggledOn" : "routines.toggledOff", { name: routine.name }) : result.error);
    await refreshRoutineBoard();
    setBusy(false);
  };
  return (
    <button type="button" className={styles.button} data-variant={routine.enabled ? "off" : undefined} disabled={busy} onClick={() => void toggle()}>
      {routine.enabled ? t("routines.turnOff") : t("routines.turnOn")}
    </button>
  );
}

function RunButton({ routine, data, t, onMessage }: { routine: BoardRoutine; data: BoardData; t: T; onMessage: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const here = routine.host === data.thisHost;
  const run = async () => {
    setBusy(true);
    const result = await request(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" }, t);
    onMessage(result.ok ? t("routines.runStarted") : result.error);
    await refreshRoutineBoard();
    setBusy(false);
  };
  return (
    <button
      type="button"
      className={styles.button}
      disabled={busy || routine.running}
      onClick={() => void run()}
      title={here ? undefined : t("routines.runHereHint", { host: data.thisHost })}
    >
      {here ? t("routines.runNow") : t("routines.runHere")}
    </button>
  );
}

function Crumb({ routine, tail, t }: { routine?: BoardRoutine; tail?: string; t: T }) {
  return (
    <nav className={styles.crumb} aria-label={t("routines.title")}>
      <button type="button" className={styles.link} onClick={() => showRoutineScreen({ kind: "gallery" })}>{t("routines.title")}</button>
      {routine ? <>›<button type="button" className={styles.link} onClick={() => showRoutineScreen({ kind: "board", id: routine.id })}>{routine.name}</button></> : null}
      {tail ? <>›<span>{tail}</span></> : null}
    </nav>
  );
}

function BoardHead({ routine, data, t, onMessage }: { routine: BoardRoutine; data: BoardData; t: T; onMessage: (text: string) => void }) {
  const here = routine.host === data.thisHost;
  const last = lastRunLabel(routine, t);
  return (
    <header className={styles.head}>
      <h1>
        <EnabledBadge routine={routine} t={t} />
        {routine.name}
        {routine.running ? <span className={styles.badge} data-status="running">{t("routines.running")}</span> : null}
      </h1>
      <div className={styles.headActions}>
        <ToggleButton routine={routine} t={t} onMessage={onMessage} />
        <RunButton routine={routine} data={data} t={t} onMessage={onMessage} />
        <button type="button" className={styles.button} onClick={() => showRoutineScreen({ kind: "form", id: routine.id })}>{t("routines.settings")}</button>
      </div>
      <div className={styles.sub}>
        <span className={styles.facts}>
          <span>{scheduleLabel(routine.schedule, t)} {t("routines.koreaTime")}</span>
          <span>{t("routines.metaHost", { host: routine.host })}</span>
          {routine.enabled && routine.nextRunAt ? <span className={styles.strong}>{t("routines.nextRun", { time: shortDateTime(routine.nextRunAt) })}</span> : null}
          {last ? <span>{last}</span> : null}
          {routine.cwd ? <span>{t("routines.metaCwd", { cwd: routine.cwd })}</span> : null}
        </span>
        <span className={styles.subNote}>
          {t("routines.hostNote", { host: routine.host })}
          {here ? null : <> {t("routines.runHereHint", { host: data.thisHost })}.</>}
        </span>
      </div>
    </header>
  );
}

function PostTable({ routine, current, t }: { routine: BoardRoutine; current?: string; t: T }) {
  const read = useReadRoutinePosts();
  const [onlyFailed, setOnlyFailed] = useState(false);
  const failed = routine.posts.filter((post) => post.status !== "ok");
  const shown = onlyFailed ? failed : routine.posts;
  const total = routine.posts.length;
  return (
    <>
      <div className={styles.tabs}>
        <button type="button" aria-pressed={!onlyFailed} onClick={() => setOnlyFailed(false)}>{t("routines.tabAll", { count: total })}</button>
        <button type="button" aria-pressed={onlyFailed} onClick={() => setOnlyFailed(true)}>{t("routines.tabFailed", { count: failed.length })}</button>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.no}>{t("routines.col.no")}</th>
            <th className={styles.title}>{t("routines.col.title")}</th>
            <th className={styles.host}>{t("routines.col.author")}</th>
            <th>{t("routines.col.date")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={4} className={styles.emptyCell}>
                {onlyFailed ? <p>{t("routines.noFailed")}</p> : (
                  <>
                    <p>{t("routines.noPosts")}</p>
                    <p>{routine.enabled ? t("routines.noPostsNext", { time: shortDateTime(routine.nextRunAt) }) : t("routines.noPostsOff")}</p>
                  </>
                )}
              </td>
            </tr>
          ) : shown.map((post) => (
            <tr key={post.file} aria-current={post.file === current ? "true" : undefined}>
              <td className={`${styles.no} ${styles.mono}`}>{total - routine.posts.indexOf(post)}</td>
              <td className={styles.title}>
                <StatusBadge status={post.status} t={t} />{post.status === "ok" ? null : " "}
                {isNewRoutinePost(routine.id, post, read) ? <><NewMark t={t} /> </> : null}
                <button type="button" className={styles.link} onClick={() => showRoutineScreen({ kind: "post", id: routine.id, file: post.file })}>{post.title}</button>
              </td>
              <td className={`${styles.host} ${styles.mono}`}>{post.host}</td>
              <td className={styles.mono}>{boardDate(post.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type Filter = "all" | "on" | "off";

function Gallery({ data, t }: { data: BoardData; t: T }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [message, setMessage] = useState<string | null>(null);
  const read = useReadRoutinePosts();
  const newButton = <button type="button" className={styles.button} data-variant="primary" onClick={() => showRoutineScreen({ kind: "form", id: null })}>{t("routines.new")}</button>;
  if (data.routines.length === 0) {
    return (
      <>
        <header className={styles.head}><h1>{t("routines.title")}</h1><div className={styles.headActions}><SyncLine data={data} t={t} /></div></header>
        <div className={styles.empty}><p>{t("routines.empty")}</p><p>{t("routines.emptyHint")}</p>{newButton}</div>
      </>
    );
  }
  const on = data.routines.filter((routine) => routine.enabled);
  const shown = filter === "on" ? on : filter === "off" ? data.routines.filter((routine) => !routine.enabled) : data.routines;
  return (
    <>
      <header className={styles.head}>
        <h1>{t("routines.title")}</h1>
        <div className={styles.headActions}><SyncLine data={data} t={t} />{newButton}</div>
        <div className={styles.sub}>
          <span className={styles.strong}>{t("routines.enabledCount", { on: on.length, total: data.routines.length })}</span>
          <span className={styles.subNote}>{t("routines.galleryIntro")}</span>
        </div>
      </header>
      {message ? <div className={styles.notice} data-tone="info" role="status">{message}</div> : null}
      <div className={styles.tabs}>
        {(["all", "on", "off"] as const).map((key) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {t(`routines.filter.${key}`, { count: key === "all" ? data.routines.length : key === "on" ? on.length : data.routines.length - on.length })}
          </button>
        ))}
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t("routines.col.state")}</th>
            <th className={styles.title}>{t("routines.col.gallery")}</th>
            <th className={styles.wide}>{t("routines.col.schedule")}</th>
            <th className={styles.host}>{t("routines.col.host")}</th>
            <th>{t("routines.col.next")}</th>
            <th className={styles.wide}>{t("routines.col.posts")}</th>
            <th><span className={styles.visuallyHidden}>{t("routines.col.toggle")}</span></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((routine) => {
            const fresh = routine.posts.filter((post) => isNewRoutinePost(routine.id, post, read)).length;
            return (
              <tr key={routine.id} data-enabled={routine.enabled ? "true" : "false"}>
                <td><EnabledBadge routine={routine} t={t} /></td>
                <td className={styles.title}>
                  <button type="button" className={styles.link} onClick={() => showRoutineScreen({ kind: "board", id: routine.id })}><strong>{routine.name}</strong></button>
                  {fresh > 0 ? <> <span className={styles.badge} data-status="new">{t("routines.newPosts", { count: fresh })}</span></> : null}
                  {routine.running ? <> <span className={styles.badge} data-status="running">{t("routines.running")}</span></> : null}
                  <LatestLine routine={routine} read={read} t={t} />
                  <span className={styles.rowSchedule}>{scheduleLabel(routine.schedule, t)}</span>
                </td>
                <td className={styles.wide}>{scheduleLabel(routine.schedule, t)}</td>
                <td className={`${styles.host} ${styles.mono}`}>{routine.host}</td>
                <td className={styles.mono}>{routine.enabled ? shortDateTime(routine.nextRunAt) : "-"}</td>
                <td className={`${styles.wide} ${styles.mono}`}>{routine.posts.length}</td>
                <td><ToggleButton routine={routine} t={t} onMessage={setMessage} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.foot}><SyncLine data={data} t={t} /></div>
    </>
  );
}

function Board({ routine, data, t }: { routine: BoardRoutine; data: BoardData; t: T }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <Crumb t={t} />
      <BoardHead routine={routine} data={data} t={t} onMessage={setMessage} />
      {message ? <div className={styles.notice} data-tone="info" role="status">{message}</div> : null}
      <PostTable routine={routine} t={t} />
      <div className={styles.foot}>
        <SyncLine data={data} t={t} />
        <button type="button" className={styles.button} onClick={() => showRoutineScreen({ kind: "gallery" })}>{t("routines.galleryList")}</button>
      </div>
    </>
  );
}

/**
 * 글 본문. 처음엔 짧은 본문만 일정 높이까지 보이고(넘치면 「글 전체 보기」), `## 자세히` 아래 상세는 접어 둔다.
 * `## 자세히`가 없는 예전 긴 글도 같은 높이에서 잘려 보인다.
 */
function PostBody({ body, t }: { body: string; t: T }) {
  const { summary, details } = splitPostDetails(body);
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useLayoutEffect(() => {
    const outer = frame.current;
    const inner = content.current;
    if (open || !outer || !inner) return;
    const measure = () => setOverflow(inner.offsetHeight > outer.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [open, summary]);
  return (
    <div className={styles.postBody}>
      {summary.trim() ? (
        <>
          <div ref={frame} className={styles.clamp} data-clamped={open ? undefined : "true"} data-overflow={!open && overflow ? "true" : undefined}>
            <div ref={content}><MarkdownBody>{summary}</MarkdownBody></div>
          </div>
          {!open && overflow ? <button type="button" className={styles.expand} onClick={() => setOpen(true)}>{t("routines.expandPost")}</button> : null}
        </>
      ) : null}
      {details ? (
        <details className={styles.details} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>{t(detailsOpen ? "routines.detailsHide" : "routines.details")}</summary>
          <MarkdownBody>{details}</MarkdownBody>
        </details>
      ) : null}
    </div>
  );
}

function PostView({ routine, file, data, t }: { routine: BoardRoutine; file: string; data: BoardData; t: T }) {
  const [post, setPost] = useState<RoutinePost | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPost(null);
    setError(null);
    void request<{ post: RoutinePost }>(`/api/routines/${encodeURIComponent(routine.id)}/posts/${encodeURIComponent(file)}`, { cache: "no-store" }, t)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPost(result.body.post);
          markRoutinePostRead(routine.id, file);
        } else setError(t("routines.loadFailed", { error: result.error }));
      });
    return () => {
      cancelled = true;
    };
  }, [routine.id, file, t]);
  const started = post ? kstParts(post.startedAt) : null;
  const finished = post ? kstParts(post.finishedAt) : null;
  return (
    <>
      <Crumb routine={routine} t={t} />
      {error ? <div className={styles.notice} data-tone="danger">{error}</div> : null}
      {post ? (
        <article>
          <header className={styles.postHead}>
            <h2><StatusBadge status={post.status} t={t} />{post.status === "ok" ? null : " "}{post.title}</h2>
            <div className={styles.postMeta}>
              <span>{t("routines.postAuthor", { host: post.host })}</span>
              {started ? <span className={styles.mono}>{started.date} {started.time}{finished ? ` ~ ${finished.time}` : ""}</span> : null}
              {post.sessionId && post.host === data.thisHost ? <a href={`/?session=${encodeURIComponent(post.sessionId)}`}>{t("routines.openSession")}</a> : null}
            </div>
          </header>
          <PostBody key={file} body={bodyWithoutTitle(post.body, post.title)} t={t} />
        </article>
      ) : null}
      <PostTable routine={routine} current={file} t={t} />
    </>
  );
}

function DayPicker({ days, onChange, labelId, t }: { days: number[]; onChange: (days: number[]) => void; labelId: string; t: T }) {
  return (
    <div className={styles.days} role="group" aria-labelledby={labelId}>
      {DAYS.map((day) => (
        <label key={day}>
          <input
            type="checkbox"
            checked={days.includes(day)}
            onChange={(e) => onChange(e.target.checked ? [...days, day].sort() : days.filter((d) => d !== day))}
          />
          {t(`routines.day.${day}`)}
        </label>
      ))}
    </div>
  );
}

function todayKst(): string {
  const parts = kstParts(new Date().toISOString());
  return parts ? parts.date.replace(/\./g, "-") : "";
}

function RoutineForm({ routine, data, t }: { routine: BoardRoutine | null; data: BoardData; t: T }) {
  const initial = routine?.schedule;
  const [name, setName] = useState(routine?.name ?? "");
  const [kind, setKind] = useState<RoutineSchedule["kind"]>(initial?.kind ?? "weekly");
  const [days, setDays] = useState<number[]>(initial?.kind === "weekly" ? initial.days : initial?.kind === "hourly" && initial.days ? initial.days : DAYS);
  const [times, setTimes] = useState<string[]>(initial?.kind === "weekly" ? initial.times : ["09:00"]);
  const [newTime, setNewTime] = useState("");
  const [everyHours, setEveryHours] = useState(initial?.kind === "hourly" ? initial.everyHours : 1);
  const [minute, setMinute] = useState(initial?.kind === "hourly" ? initial.minute : 0);
  const [startHour, setStartHour] = useState(initial?.kind === "hourly" ? initial.startHour ?? 0 : 0);
  const [onceDate, setOnceDate] = useState(initial?.kind === "once" ? initial.date : todayKst());
  const [onceTime, setOnceTime] = useState(initial?.kind === "once" ? initial.time : "09:00");
  const [host, setHost] = useState(routine?.host ?? data.thisHost);
  const [cwd, setCwd] = useState(routine?.cwd ?? "");
  const [model, setModel] = useState(routine?.model ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => showRoutineScreen(routine ? { kind: "board", id: routine.id } : { kind: "gallery" });

  const schedule = (): RoutineSchedule | string => {
    if (kind === "once") return { kind, date: onceDate, time: onceTime };
    if (days.length === 0) return t("routines.form.daysRequired");
    if (kind === "weekly") return times.length === 0 ? t("routines.form.timesRequired") : { kind, days, times };
    return { kind, everyHours, minute, ...(everyHours > 1 ? { startHour } : {}), ...(days.length === 7 ? {} : { days }) };
  };

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const built = schedule();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await request<{ routine: { id: string } }>(routine ? `/api/routines/${encodeURIComponent(routine.id)}` : "/api/routines", {
      method: routine ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled, schedule: built, host, prompt, cwd, model }),
    }, t);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshRoutineBoard();
    showRoutineScreen({ kind: "board", id: result.body.routine.id });
  };

  const remove = async () => {
    if (!routine || !window.confirm(t("routines.form.deleteConfirm", { name: routine.name, count: routine.posts.length }))) return;
    setBusy(true);
    const result = await request(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" }, t);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await refreshRoutineBoard();
    showRoutineScreen({ kind: "gallery" });
  };

  const addTime = () => {
    if (!newTime || times.includes(newTime)) return;
    setTimes([...times, newTime].sort());
    setNewTime("");
  };

  const title = routine ? t("routines.form.editTitle") : t("routines.form.newTitle");
  return (
    <>
      <Crumb routine={routine ?? undefined} tail={title} t={t} />
      <header className={styles.head}><h1>{title}</h1></header>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-name">{t("routines.form.name")}</label>
          <div className={styles.field}><input id="routine-name" type="text" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
        </div>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-kind">{t("routines.form.schedule")}</label>
          <div className={styles.field}>
            <select id="routine-kind" className={styles.narrow} value={kind} onChange={(e) => setKind(e.target.value as RoutineSchedule["kind"])}>
              <option value="weekly">{t("routines.form.kind.weekly")}</option>
              <option value="hourly">{t("routines.form.kind.hourly")}</option>
              <option value="once">{t("routines.form.kind.once")}</option>
            </select>
            <span className={styles.hint}>{t("routines.koreaTime")}</span>
          </div>
        </div>
        {kind !== "once" ? (
          <div className={styles.row}>
            <span className={styles.rowLabel} id="routine-days">{t("routines.form.days")}</span>
            <div className={styles.field}>
              <DayPicker days={days} onChange={setDays} labelId="routine-days" t={t} />
              {kind === "hourly" ? <span className={styles.hint}>{t("routines.form.hourlyDaysHint")}</span> : null}
            </div>
          </div>
        ) : null}
        {kind === "weekly" ? (
          <div className={styles.row}>
            <span className={styles.rowLabel} id="routine-times">{t("routines.form.times")}</span>
            <div className={styles.field}>
              <ul className={styles.chips} aria-labelledby="routine-times">
                {times.map((time) => (
                  <li key={time}>
                    <span className={styles.mono}>{time}</span>
                    <button type="button" className={styles.chipRemove} aria-label={t("routines.form.removeTime", { time })} onClick={() => setTimes(times.filter((x) => x !== time))}>×</button>
                  </li>
                ))}
              </ul>
              <div className={styles.inline}>
                <input type="time" aria-label={t("routines.form.newTime")} value={newTime} onChange={(e) => setNewTime(e.target.value)} />
                <button type="button" className={styles.button} onClick={addTime}>{t("routines.form.addTime")}</button>
              </div>
            </div>
          </div>
        ) : null}
        {kind === "hourly" ? (
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t("routines.form.interval")}</span>
            <div className={styles.field}>
              <div className={styles.inline}>
                <select aria-label={t("routines.form.everyHours")} value={everyHours} onChange={(e) => setEveryHours(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{t("routines.form.everyHoursOption", { n })}</option>)}
                </select>
                <label className={styles.inline}>{t("routines.form.minute")}
                  <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Math.min(59, Math.max(0, Number(e.target.value) || 0)))} />
                </label>
                {everyHours > 1 ? (
                  <label className={styles.inline}>{t("routines.form.startHour")}
                    <input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(Math.min(23, Math.max(0, Number(e.target.value) || 0)))} />
                  </label>
                ) : null}
              </div>
              <span className={styles.hint}>{scheduleLabel({ kind: "hourly", everyHours, minute, startHour, ...(days.length === 7 || days.length === 0 ? {} : { days }) }, t)}</span>
            </div>
          </div>
        ) : null}
        {kind === "once" ? (
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t("routines.form.when")}</span>
            <div className={styles.field}>
              <div className={styles.inline}>
                <input type="date" aria-label={t("routines.form.date")} required value={onceDate} onChange={(e) => setOnceDate(e.target.value)} />
                <input type="time" aria-label={t("routines.form.time")} required value={onceTime} onChange={(e) => setOnceTime(e.target.value)} />
              </div>
              <span className={styles.hint}>{t("routines.form.onceHint")}</span>
            </div>
          </div>
        ) : null}
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-host">{t("routines.form.host")}</label>
          <div className={styles.field}>
            <input id="routine-host" className={styles.narrow} type="text" required list="routine-hosts" value={host} onChange={(e) => setHost(e.target.value)} />
            <datalist id="routine-hosts">{data.hosts.map((known) => <option key={known} value={known} />)}</datalist>
            <span className={styles.hint}>{t("routines.form.hostHint", { host: data.thisHost })}</span>
          </div>
        </div>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-model">{t("routines.form.model")}</label>
          <div className={styles.field}>
            <input id="routine-model" type="text" maxLength={300} value={model} placeholder={t("routines.form.modelPlaceholder")} aria-describedby="routine-model-hint" onChange={(e) => setModel(e.target.value)} />
            <span id="routine-model-hint" className={styles.hint}>{t("routines.form.modelHint")}</span>
          </div>
        </div>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-cwd">{t("routines.form.cwd")}</label>
          <div className={styles.field}>
            <input id="routine-cwd" type="text" value={cwd} placeholder={t("routines.form.cwdPlaceholder")} onChange={(e) => setCwd(e.target.value)} />
            <span className={styles.hint}>{t("routines.form.cwdHint")}</span>
          </div>
        </div>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="routine-prompt">{t("routines.form.prompt")}</label>
          <div className={styles.field}>
            <textarea id="routine-prompt" required value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <span className={styles.hint}>{t("routines.form.quietHint")}</span>
          </div>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t("routines.form.enabled")}</span>
          <label className={styles.check}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("routines.form.enabledLabel")}
            <span className={styles.hint}>{t("routines.form.enabledHint")}</span>
          </label>
        </div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.formActions}>
          <button type="button" className={styles.button} onClick={cancel}>{t("routines.form.cancel")}</button>
          <button type="submit" className={styles.button} data-variant="primary" disabled={busy}>{busy ? t("routines.form.saving") : t("routines.form.save")}</button>
        </div>
      </form>
      {routine ? (
        <section className={styles.danger}>
          <span>{t("routines.form.deleteText", { count: routine.posts.length })}</span>
          <button type="button" className={styles.button} data-variant="danger" disabled={busy || routine.running} onClick={() => void remove()}>{t("routines.form.delete")}</button>
        </section>
      ) : null}
    </>
  );
}

function SetupNotice({ setup, t }: { setup: NonNullable<BoardData["setup"]>; t: T }) {
  return (
    <>
      <header className={styles.head}><h1>{t("routines.title")}</h1></header>
      <section className={styles.notice}>
        <h2>{t("routines.setupTitle")}</h2>
        <p>{t(setup.reason === "missing" ? "routines.setupMissing" : "routines.setupNotGit", { dir: setup.dir })}</p>
        <p>{t("routines.setupBody")}</p>
        <button type="button" className={styles.button} onClick={() => void refreshRoutineBoard()}>{t("routines.reload")}</button>
      </section>
    </>
  );
}

function Screen({ data, screen, t }: { data: BoardData; screen: BoardScreen; t: T }) {
  if (data.setup) return <SetupNotice setup={data.setup} t={t} />;
  const id = "id" in screen ? screen.id : null;
  const routine = id ? data.routines.find((r) => r.id === id) ?? null : null;
  if (id && !routine) {
    // 다른 PC에서 지웠으면 열려 있던 설정 폼이 새 루틴 만들기로 바뀌지 않게, 지워졌다고만 알린다.
    return (
      <>
        <Crumb t={t} />
        <div className={styles.notice} data-tone="danger">{t("routines.deletedElsewhere")}</div>
      </>
    );
  }
  if (screen.kind === "form") return <RoutineForm key={screen.id ?? "new"} routine={routine} data={data} t={t} />;
  if (screen.kind === "post" && routine) return <PostView routine={routine} file={screen.file} data={data} t={t} />;
  if (screen.kind === "board" && routine) return <Board key={routine.id} routine={routine} data={data} t={t} />;
  return <Gallery data={data} t={t} />;
}

export function RoutineView({ visible = true, onBack }: { visible?: boolean; onBack: () => void }) {
  const { t } = useI18n();
  const { data, loadError, screen } = useRoutineBoard();
  const syncing = data?.sync.syncing ?? false;
  const running = data?.routines.some((routine) => routine.running) ?? false;

  useEffect(() => {
    if (!visible) return;
    void refreshRoutineBoard();
    // 백그라운드 받기가 끝나면 다시 읽어 다른 PC의 글을 보인다. 이 PC에서 도는 루틴이 있으면 끝을 기다려 다시 읽는다.
    const delay = syncing ? 2_000 : running ? 10_000 : 60_000;
    const timer = setInterval(() => void refreshRoutineBoard(), delay);
    return () => clearInterval(timer);
  }, [visible, syncing, running]);

  return (
    <section className={styles.view} hidden={!visible} aria-label={t("routines.tab")}>
      <div className={styles.topbar}>
        <button type="button" className={styles.back} onClick={onBack}>‹ {t("routines.back")}</button>
        <h2>{t("routines.tab")}</h2>
      </div>
      <div className={styles.body}>
        {loadError && !data ? <div className={styles.notice} data-tone="danger">{t("routines.loadFailed", { error: loadError })}</div> : null}
        {data ? <Screen data={data} screen={screen} t={t} /> : null}
      </div>
    </section>
  );
}

/** 사이드바 「루틴」 보기의 내용: 짧은 안내와 루틴 목록(켜진 루틴 먼저). 고르면 가운데에 그 루틴 게시판이 열린다. */
export function RoutinePanel({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  const { data, screen } = useRoutineBoard();
  const read = useReadRoutinePosts();
  const current = "id" in screen ? screen.id : null;
  const open = (next: BoardScreen) => {
    showRoutineScreen(next);
    onOpen?.();
  };
  const routines = data?.routines ?? [];
  const on = routines.filter((routine) => routine.enabled).length;
  return (
    <div id="navigator-routine-panel" className={styles.panel}>
      <p>{t("routines.panelIntro")}</p>
      {routines.length > 0 ? (
        <>
          <p className={styles.strong}>{t("routines.enabledCount", { on, total: routines.length })}</p>
          <ul className={styles.panelList}>
            {routines.map((routine) => {
              const fresh = routine.posts.filter((post) => isNewRoutinePost(routine.id, post, read)).length;
              return (
                <li key={routine.id}>
                  <button type="button" aria-current={routine.id === current ? "true" : undefined} onClick={() => open({ kind: "board", id: routine.id })}>
                    <span>{routine.name}</span>
                    <span className={styles.panelBadges}>
                      {fresh > 0 ? <span className={styles.badge} data-status="new">{t("routines.newPosts", { count: fresh })}</span> : null}
                      <span className={styles.badge} data-status={routine.enabled ? "on" : "off"}>{routine.enabled ? t("routines.on") : t("routines.off")}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <ul className={styles.panelList}>
        <li><button type="button" onClick={() => open({ kind: "gallery" })}>{t("routines.galleryList")}</button></li>
        <li><button type="button" onClick={() => open({ kind: "form", id: null })}>{t("routines.new")}</button></li>
      </ul>
    </div>
  );
}
