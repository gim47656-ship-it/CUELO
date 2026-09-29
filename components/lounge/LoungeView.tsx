"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ActionButton } from "@seed-design/react";
import type { LoungeController, LoungeStreamingText } from "@/hooks/useLounge";
import { LOUNGE_TEXT_MAX, type LoungeMember, type LoungeMessage } from "@/lib/lounge/types";
import { AccountAvatar } from "../workspace/AccountAvatar";
import { loungeMemberName, useLoungeText } from "./i18n";

/**
 * 가운데 단톡방 대화 화면. 작업 대화(ChatWindow)와 완전히 따로 도는 방이다 — 같은 컨트롤러를
 * 사이드바 멤버 패널과 나눠 쓰고, 작업 세션·초안·실행 상태에는 손대지 않는다.
 *
 * 말풍선은 서버가 확정한 메시지와, 말하는 중인 누적 본문(스트리밍)을 함께 그린다. 답장·멘션·
 * 반응·중단은 모두 서버 조작이며 화면은 서버가 돌려준 결과로만 바뀐다. 입력 중 초안은 이
 * 화면을 닫았다 열어도 남도록 sessionStorage 한 칸에 둔다.
 */

const DRAFT_KEY = "cuelo-lounge-draft";
const REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "👀"] as const;
/** 바닥에서 이만큼 안쪽이면 새 말풍선이 올 때 따라 내려간다. */
const STICK_THRESHOLD_PX = 80;
/** 같은 사람의 연속 말풍선을 한 묶음으로 보는 간격. */
const GROUP_GAP_MS = 5 * 60_000;
/** 글자 수 표시를 켜는 지점. */
const COUNTER_FROM = Math.floor(LOUNGE_TEXT_MAX * 0.8);
/** snapshot이 오기 전의 빈 목록. 렌더마다 새 배열이면 아래 memo가 매번 다시 돈다. */
const NO_MEMBERS: readonly LoungeMember[] = [];
const NO_MESSAGES: readonly LoungeMessage[] = [];

export interface LoungeViewProps {
  lounge: LoungeController;
  /** 화면에 보이는지. 숨겨진 채 마운트돼 있을 때는 포커스·스크롤을 건드리지 않는다. */
  visible?: boolean;
  /** 작업 대화로 돌아간다. 없으면 돌아가기 버튼을 그리지 않는다. */
  onBack?: () => void;
}

interface MentionState {
  start: number;
  query: string;
  index: number;
}

function readDraft(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 멘션 이름을 강조한 본문. 서버가 알아듣는 `@이름` 표기만 칠한다. */
function renderText(text: string, names: readonly string[]): ReactNode {
  if (names.length === 0) return text;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(@(?:${escaped.join("|")}))`, "giu");
  return text.split(pattern).map((part, index) => (
    index % 2 === 1 ? <span key={index} className="lounge-mention">{part}</span> : part
  ));
}

function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

export function LoungeView({ lounge, visible = true, onBack }: LoungeViewProps) {
  const { lt, locale } = useLoungeText();
  const snapshot = lounge.snapshot;
  const room = snapshot?.room ?? null;
  const run = snapshot?.run ?? null;
  const members = snapshot?.members ?? NO_MEMBERS;
  const messages = snapshot?.messages ?? NO_MESSAGES;
  const storeError = snapshot?.loadError ?? null;
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const messageById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const nameOf = useCallback((memberId: string): string => {
    if (memberId === "user") return lt("lounge.you");
    const member = memberById.get(memberId);
    return member ? loungeMemberName(member.alias, locale) : memberId;
  }, [locale, lt, memberById]);
  // 멘션 강조는 두 표기 모두(한국어·영문). 서버가 둘 다 알아듣는다.
  const mentionNames = useMemo(
    () => members.flatMap((member) => [loungeMemberName(member.alias, "ko"), loungeMemberName(member.alias, "en")]),
    [members],
  );
  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }), [locale]);

  const [draft, setDraft] = useState("");
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const listboxId = useId();

  useEffect(() => {
    setDraft(readDraft());
  }, []);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
    try {
      if (value) window.sessionStorage.setItem(DRAFT_KEY, value);
      else window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // 저장하지 못해도 이번 화면의 초안은 그대로 쓴다.
    }
  }, []);

  // 새 말풍선·스트리밍이 오면 바닥을 보고 있던 사람만 따라 내려간다.
  const streamSignature = lounge.streaming.map((entry) => `${entry.messageId}:${entry.text.length}`).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !visible || !stickRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length, streamSignature, visible]);

  // 화면 폭·모바일 키보드로 목록 높이가 바뀌어도 바닥을 보던 사람은 바닥에 남는다.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (visible) composerRef.current?.focus({ preventScroll: true });
  }, [visible]);

  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return members.filter((member) => {
      if (!query) return true;
      return loungeMemberName(member.alias, "ko").toLowerCase().startsWith(query)
        || loungeMemberName(member.alias, "en").toLowerCase().startsWith(query)
        || member.id.startsWith(query);
    });
  }, [members, mention]);

  const canSend = room?.enabled === true && storeError === null && snapshot !== null;
  const sending = lounge.pending.has("send");
  const trimmed = draft.trim();
  const replyTarget = replyToId ? messageById.get(replyToId) ?? null : null;

  const insertMention = (member: LoungeMember) => {
    if (!mention) return;
    const name = loungeMemberName(member.alias, locale);
    const composer = composerRef.current;
    const caret = composer?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`;
    updateDraft(next);
    setMention(null);
    const position = mention.start + name.length + 2;
    window.requestAnimationFrame(() => {
      composer?.focus();
      composer?.setSelectionRange(position, position);
    });
  };

  const submit = async () => {
    if (!canSend || sending || !trimmed || trimmed.length > LOUNGE_TEXT_MAX) return;
    const ok = await lounge.send(trimmed, replyTarget?.id);
    if (ok) {
      updateDraft("");
      setReplyToId(null);
      stickRef.current = true;
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mention && mentionOptions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + mentionOptions.length) % mentionOptions.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionOptions[Math.min(mention.index, mentionOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Escape" && replyToId) {
      event.preventDefault();
      setReplyToId(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const speakingId = run?.active ? run.currentMemberId : null;
  const speakingHasText = lounge.streaming.some((entry) => entry.memberId === speakingId);
  const queued = run?.active ? run.queuedMemberIds.map(nameOf) : [];

  const renderBubble = (
    key: string,
    memberId: string,
    body: ReactNode,
    options: {
      message?: LoungeMessage;
      createdAt?: number;
      grouped: boolean;
      streaming?: boolean;
    },
  ) => {
    const mine = memberId === "user";
    const member = memberById.get(memberId);
    const message = options.message;
    const reply = message?.replyToId ? messageById.get(message.replyToId) ?? null : null;
    return (
      <div
        key={key}
        id={message ? `lounge-message-${message.id}` : undefined}
        className="lounge-bubble-row"
        data-mine={mine ? "true" : undefined}
        data-grouped={options.grouped ? "true" : undefined}
        data-streaming={options.streaming ? "true" : undefined}
      >
        {mine ? null : (
          <span className="lounge-bubble-face">
            {options.grouped || !member ? null : <AccountAvatar seed={member.seed} size={32} provider={member.provider} />}
          </span>
        )}
        <div className="lounge-bubble-stack">
          {mine || options.grouped ? null : <span className="lounge-bubble-name">{nameOf(memberId)}</span>}
          <div className="lounge-bubble-line">
            <div className="lounge-bubble">
              {message?.replyToId ? (
                <button
                  type="button"
                  className="lounge-bubble-quote"
                  onClick={() => {
                    document.getElementById(`lounge-message-${message.replyToId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                  }}
                >
                  <span className="lounge-bubble-quote-name">{reply ? nameOf(reply.memberId) : lt("lounge.missingMessage")}</span>
                  <span className="lounge-bubble-quote-text">{reply ? reply.text : ""}</span>
                </button>
              ) : null}
              <div className="lounge-bubble-text">{body}</div>
            </div>
            {options.createdAt !== undefined ? (
              <time className="lounge-bubble-time" dateTime={new Date(options.createdAt).toISOString()}>
                {timeFormat.format(new Date(options.createdAt))}
              </time>
            ) : null}
          </div>
          {message ? (
            <div className="lounge-bubble-foot">
              {message.reactions.filter((reaction) => reaction.by.length > 0).map((reaction) => (
                <button
                  key={reaction.emoji}
                  type="button"
                  className="lounge-reaction"
                  aria-pressed={reaction.by.includes("user")}
                  aria-label={lt("lounge.reaction", { emoji: reaction.emoji, count: reaction.by.length })}
                  title={reaction.by.map(nameOf).join(", ")}
                  disabled={!canSend}
                  onClick={() => { void lounge.react(message.id, reaction.emoji); }}
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span className="lounge-reaction-count">{reaction.by.length}</span>
                </button>
              ))}
              <span className="lounge-bubble-actions">
                <button
                  type="button"
                  className="lounge-bubble-action"
                  disabled={!canSend}
                  onClick={() => {
                    setReplyToId(message.id);
                    composerRef.current?.focus();
                  }}
                >
                  {lt("lounge.reply")}
                </button>
                <button
                  type="button"
                  className="lounge-bubble-action"
                  aria-expanded={pickerFor === message.id}
                  disabled={!canSend}
                  onClick={() => setPickerFor((current) => current === message.id ? null : message.id)}
                >
                  {lt("lounge.react")}
                </button>
              </span>
              {pickerFor === message.id ? (
                <span className="lounge-reaction-picker" role="group" aria-label={lt("lounge.react")}>
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setPickerFor(null);
                        void lounge.react(message.id, emoji);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderStreaming = (entry: LoungeStreamingText) => renderBubble(
    `stream-${entry.messageId}`,
    entry.memberId,
    <>
      {renderText(entry.text, mentionNames)}
      <span className="lounge-caret" aria-hidden="true" />
    </>,
    { grouped: false, streaming: true },
  );

  const liveStatus = speakingId
    ? lt("lounge.speaking", { name: nameOf(speakingId) })
    : null;

  return (
    <section className="lounge-view" aria-label={lt("lounge.title")} hidden={!visible}>
      <header className="lounge-view-header">
        {onBack ? (
          <ActionButton variant="ghost" size="small" className="lounge-view-back" onClick={onBack}>
            {lt("lounge.back")}
          </ActionButton>
        ) : null}
        <div className="lounge-view-heading">
          <h2 className="lounge-view-title">{lt("lounge.title")}</h2>
          <span className="lounge-view-room" data-on={room?.enabled ? "true" : "false"}>
            {room?.enabled ? lt("lounge.roomOn") : lt("lounge.roomOff")}
          </span>
        </div>
        <ul className="lounge-view-faces" aria-label={lt("lounge.members")}>
          {members.filter((member) => member.enabled).map((member) => (
            <li key={member.id} className="lounge-view-face" data-state={member.state}>
              <AccountAvatar seed={member.seed} size={24} provider={member.provider} />
              <span className="lounge-member-dot" aria-hidden="true" />
              <span className="sr-only">{`${nameOf(member.id)} ${lt(`lounge.state.${member.state}`)}`}</span>
            </li>
          ))}
        </ul>
      </header>

      {lounge.loadError && !snapshot ? (
        <p className="lounge-banner" data-tone="danger" role="alert">{lt("lounge.loadFailed", { error: lounge.loadError })}</p>
      ) : null}
      {storeError ? (
        <p className="lounge-banner" data-tone="danger" role="alert">{lt("lounge.loadFailed", { error: storeError })}</p>
      ) : null}
      {lounge.connection === "reconnecting" && snapshot ? (
        <p className="lounge-banner" role="status">{lt("lounge.reconnecting")}</p>
      ) : null}
      {lounge.actionError ? (
        <p className="lounge-banner" data-tone="danger" role="alert">
          <span>{lt("lounge.actionFailed", { error: lounge.actionError })}</span>
          <button type="button" className="lounge-banner-action" onClick={lounge.dismissActionError} aria-label="✕">✕</button>
        </p>
      ) : null}
      {room && !room.enabled && !storeError ? (
        <p className="lounge-banner">
          <span>{lt("lounge.roomOffBanner")}</span>
          <button
            type="button"
            className="lounge-banner-action"
            disabled={lounge.pending.has("settings")}
            onClick={() => { void lounge.updateSettings({ enabled: true }); }}
          >
            {lt("lounge.turnOn")}
          </button>
        </p>
      ) : room?.asleep ? (
        <p className="lounge-banner">{lt("lounge.asleep")}</p>
      ) : room?.autoTalk && room.autoTalkPausedReason ? (
        <p className="lounge-banner" role="status">{room.autoTalkPausedReason}</p>
      ) : null}

      <div
        ref={listRef}
        className="lounge-log"
        role="log"
        aria-label={lt("lounge.messages")}
        onScroll={(event) => {
          const list = event.currentTarget;
          stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_THRESHOLD_PX;
        }}
      >
        {snapshot && messages.length === 0 && lounge.streaming.length === 0 ? (
          <p className="lounge-empty">{lt("lounge.empty")}</p>
        ) : null}
        {!snapshot && !lounge.loadError ? <p className="lounge-empty">{lt("lounge.connecting")}</p> : null}
        {messages.map((message, index) => {
          const previous = index > 0 ? messages[index - 1] : null;
          const grouped = previous !== null
            && previous.memberId === message.memberId
            && message.createdAt - previous.createdAt < GROUP_GAP_MS
            && !message.replyToId;
          return renderBubble(message.id, message.memberId, renderText(message.text, mentionNames), {
            message,
            createdAt: message.createdAt,
            grouped,
          });
        })}
        {lounge.streaming.map(renderStreaming)}
        {speakingId && !speakingHasText ? renderBubble(
          `typing-${speakingId}`,
          speakingId,
          <span className="lounge-typing" aria-hidden="true"><span /><span /><span /></span>,
          { grouped: false, streaming: true },
        ) : null}
      </div>

      <div className="lounge-composer">
        <div className="lounge-composer-status" role="status" aria-live="polite">
          {liveStatus ? <span>{liveStatus}</span> : null}
          {queued.length > 0 ? <span>{lt("lounge.queued", { names: queued.join(", ") })}</span> : null}
        </div>
        {replyTarget ? (
          <div className="lounge-reply-chip">
            <span className="lounge-reply-chip-text">
              <strong>{lt("lounge.replyTo", { name: nameOf(replyTarget.memberId) })}</strong>
              <span>{replyTarget.text}</span>
            </span>
            <button type="button" className="lounge-banner-action" onClick={() => setReplyToId(null)}>
              {lt("lounge.cancelReply")}
            </button>
          </div>
        ) : null}
        <div className="lounge-composer-row">
          {mention && mentionOptions.length > 0 ? (
            <ul id={listboxId} className="lounge-mention-list" role="listbox" aria-label={lt("lounge.mentionList")}>
              {mentionOptions.map((member, index) => (
                <li
                  key={member.id}
                  id={`${listboxId}-${member.id}`}
                  role="option"
                  aria-selected={index === mention.index}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(member);
                  }}
                >
                  <AccountAvatar seed={member.seed} size={20} provider={member.provider} />
                  <span>{loungeMemberName(member.alias, locale)}</span>
                  <span className="lounge-mention-state">{lt(`lounge.state.${member.state}`)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={composerRef}
            className="lounge-composer-input"
            rows={1}
            value={draft}
            maxLength={LOUNGE_TEXT_MAX}
            disabled={!canSend}
            placeholder={canSend ? lt("lounge.placeholder") : lt("lounge.placeholderOff")}
            aria-label={lt("lounge.composer")}
            role="combobox"
            aria-expanded={mention !== null && mentionOptions.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={mention && mentionOptions[mention.index]
              ? `${listboxId}-${mentionOptions[mention.index].id}`
              : undefined}
            onChange={(event) => {
              const value = event.target.value;
              updateDraft(value);
              const found = mentionAt(value, event.target.selectionStart ?? value.length);
              setMention(found ? { ...found, index: 0 } : null);
            }}
            onBlur={() => setMention(null)}
            onKeyDown={onComposerKeyDown}
          />
          {run?.active ? (
            <ActionButton
              variant="neutralOutline"
              size="small"
              className="lounge-composer-button lounge-stop-button"
              loading={lounge.pending.has("stop")}
              onClick={() => { void lounge.stop(); }}
            >
              {/* 말하는 차례를 끊는 버튼. 보내기와 헷갈리지 않게 정지 모양을 붙인다. */}
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
              {lt("lounge.stop")}
            </ActionButton>
          ) : null}
          <ActionButton
            variant="neutralSolid"
            size="small"
            className="lounge-composer-button"
            disabled={!canSend || !trimmed || trimmed.length > LOUNGE_TEXT_MAX}
            loading={sending}
            onClick={() => { void submit(); }}
          >
            {lt("lounge.send")}
          </ActionButton>
        </div>
        {draft.length >= COUNTER_FROM ? (
          <span className="lounge-composer-counter">{lt("lounge.textLimit", { count: draft.length, max: LOUNGE_TEXT_MAX })}</span>
        ) : null}
      </div>
    </section>
  );
}
