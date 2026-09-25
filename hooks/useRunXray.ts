"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHanseEfficiencyClient,
  EfficiencyClientError,
  type HanseEfficiencyClient,
} from "@/lib/hanse-efficiency-client";
import {
  EXPERIMENT_DEFAULT_SESSIONS,
  RUN_LIST_DEFAULT_LIMIT,
  type ExperimentResponse,
  type ExperimentScope,
  type RunDetail,
  type RunSummary,
} from "@/lib/run-xray-types";
import type { WorkspaceEfficiencyTab } from "@/lib/workspace-layout";

export interface RunXrayListState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  runs: RunSummary[];
  error: string | null;
}

export interface RunXrayDetailState {
  status: "idle" | "loading" | "ready" | "error";
  runId: string | null;
  detail: RunDetail | null;
  error: string | null;
}

export interface RunXrayExperimentState {
  status: "idle" | "loading" | "ready" | "empty" | "error";
  response: ExperimentResponse | null;
  error: string | null;
}

export interface UseRunXrayOptions {
  sessionId: string | null;
  /** 패널 실제 표시 여부. 보이지 않으면 요청하지 않는다. */
  visible: boolean;
  activeTab: WorkspaceEfficiencyTab;
  client?: HanseEfficiencyClient;
}

export interface UseRunXray {
  list: RunXrayListState;
  detail: RunXrayDetailState;
  experiments: RunXrayExperimentState;
  selectedRunId: string | null;
  selectRun: (runId: string | null) => void;
  refreshRuns: () => void;
  refreshExperiments: (folder?: string | null, scope?: ExperimentScope) => void;
  experimentFolder: string | null;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof EfficiencyClientError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * Run 목록·상세·구성 비교를 읽는 훅. 기록 읽기만 하며 새 계측을 시작하지
 * 않는다. 자동 폴링이나 주기 타이머는 만들지 않고 수동 새로고침만 제공한다.
 */
export function useRunXray({ sessionId, visible, activeTab, client: clientOverride }: UseRunXrayOptions): UseRunXray {
  const [client] = useState<HanseEfficiencyClient>(() => clientOverride ?? createHanseEfficiencyClient());
  const [list, setList] = useState<RunXrayListState>({ status: "idle", runs: [], error: null });
  const [detail, setDetail] = useState<RunXrayDetailState>({ status: "idle", runId: null, detail: null, error: null });
  const [experiments, setExperiments] = useState<RunXrayExperimentState>({ status: "idle", response: null, error: null });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [experimentFolder, setExperimentFolder] = useState<string | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const experimentControllerRef = useRef<AbortController | null>(null);
  const experimentFolderRef = useRef<string | null>(null);

  // 세션이 바뀌면 이전 선택과 상세를 버린다. 목록이 오기 전 낡은 상세를
  // 보여주지 않기 위해서다.
  useEffect(() => {
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setSelectedRunId(null);
    setDetail({ status: "idle", runId: null, detail: null, error: null });
    setList({ status: "idle", runs: [], error: null });
  }, [sessionId]);

  const requestRuns = useCallback(() => {
    if (!visible || activeTab !== "governor" || !sessionId) return;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setList((current) => ({
      status: "loading",
      runs: current.status === "ready" || current.status === "empty" ? current.runs : [],
      error: null,
    }));
    void client.listRuns(sessionId, RUN_LIST_DEFAULT_LIMIT, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || listControllerRef.current !== controller) return;
        if (response.runs.length === 0) {
          setList({ status: "empty", runs: [], error: null });
          return;
        }
        setList({ status: "ready", runs: response.runs, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || listControllerRef.current !== controller) return;
        setList({ status: "error", runs: [], error: toMessage(error, "실행 목록을 불러오지 못했습니다.") });
      });
  }, [activeTab, client, sessionId, visible]);

  const requestDetail = useCallback((runId: string) => {
    if (!visible) return;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetail({ status: "loading", runId, detail: null, error: null });
    void client.getRun(runId, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted || detailControllerRef.current !== controller) return;
        setDetail({ status: "ready", runId, detail: loaded, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || detailControllerRef.current !== controller) return;
        setDetail({ status: "error", runId, detail: null, error: toMessage(error, "실행 상세를 불러오지 못했습니다.") });
      });
  }, [client, visible]);

  const requestExperiments = useCallback((folder: string | null, scope: ExperimentScope = "all") => {
    if (!visible || activeTab !== "lab") return;
    experimentControllerRef.current?.abort();
    const controller = new AbortController();
    experimentControllerRef.current = controller;
    setExperiments((current) => ({
      status: "loading",
      response: current.status === "ready" || current.status === "empty" ? current.response : null,
      error: null,
    }));
    void client.listExperiments(folder, EXPERIMENT_DEFAULT_SESSIONS, scope, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || experimentControllerRef.current !== controller) return;
        if (response.configs.length === 0) {
          setExperiments({ status: "empty", response, error: null });
          return;
        }
        setExperiments({ status: "ready", response, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || experimentControllerRef.current !== controller) return;
        setExperiments({ status: "error", response: null, error: toMessage(error, "구성 비교를 불러오지 못했습니다.") });
      });
  }, [activeTab, client, visible]);

  // 실행 통제 보기가 켜질 때 목록을 불러온다. 폴더 선택은 구성 비교의
  // 몫이므로 이 이펙트는 폴더 변경에 반응하지 않는다.
  useEffect(() => {
    if (!visible || activeTab !== "governor") return;
    requestRuns();
    return () => {
      listControllerRef.current?.abort();
      listControllerRef.current = null;
    };
  }, [activeTab, requestRuns, sessionId, visible]);

  // 구성 비교 보기가 켜질 때 집계를 불러온다. run 목록과는 독립적이다.
  // 폴더 변경은 refreshExperiments가 직접 요청하므로 이 이펙트는 폴더에
  // 반응하지 않고 중복 요청을 만들지 않는다.
  useEffect(() => {
    if (!visible || activeTab !== "lab") return;
    requestExperiments(experimentFolderRef.current);
    return () => {
      experimentControllerRef.current?.abort();
      experimentControllerRef.current = null;
    };
  }, [activeTab, requestExperiments, visible]);

  // 선택한 run의 상세를 지연 로드한다.
  useEffect(() => {
    if (!visible || activeTab !== "governor" || selectedRunId === null) return;
    requestDetail(selectedRunId);
    return () => {
      detailControllerRef.current?.abort();
      detailControllerRef.current = null;
    };
  }, [activeTab, requestDetail, selectedRunId, visible]);

  useEffect(() => () => {
    listControllerRef.current?.abort();
    detailControllerRef.current?.abort();
    experimentControllerRef.current?.abort();
  }, []);

  const selectRun = useCallback((runId: string | null) => {
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setSelectedRunId(runId);
    if (runId === null) {
      setDetail({ status: "idle", runId: null, detail: null, error: null });
    }
  }, []);

  const refreshRuns = useCallback(() => {
    requestRuns();
  }, [requestRuns]);

  const refreshExperiments = useCallback((folder?: string | null, scope: ExperimentScope = "all") => {
    // undefined는 기존 선택 유지, null은 명시적인 전체 폴더 조회다.
    const next = folder === undefined ? experimentFolderRef.current : folder;
    if (folder !== undefined) {
      experimentFolderRef.current = folder;
      setExperimentFolder(folder);
    }
    requestExperiments(next, scope);
  }, [requestExperiments]);

  return { list, detail, experiments, selectedRunId, selectRun, refreshRuns, refreshExperiments, experimentFolder };
}
