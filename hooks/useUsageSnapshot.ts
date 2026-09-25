"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createUsagePoller,
  loadModelStats,
  ResourceClientError,
  type ModelStatsSnapshot,
  type ResourceLoadState,
  type UsagePoller,
  type UsageSnapshot,
} from "@/lib/hanse-resource-client";

export type UsageState =
  | { status: "idle"; data: null; error: null }
  | ResourceLoadState<UsageSnapshot>;

/** The provider the model aggregation records B.AI requests under. The provider a model was
 *  *requested* under is not evidence of the one that served it, so only this field is counted. */
const BAI_PROVIDER = "b-ai";

/**
 * What the existing `omp stats` aggregation reports for B.AI, in that aggregate's own dedupe-free
 * total (input + output + cache read + cache write). "unmeasured" means the aggregation was not
 * read or did not answer, "empty" means it answered without a B.AI record; neither is a measured
 * zero, and only "measured" may be drawn as a number.
 */
export type BaiTokenUsage =
  | { status: "unmeasured" }
  | { status: "empty" }
  | { status: "measured"; tokens: number; from: number | null; to: number | null };

function summarizeBai(state: ResourceLoadState<ModelStatsSnapshot> | null): BaiTokenUsage {
  const data = state?.data;
  if (!data) return { status: "unmeasured" };
  const recorded = data.models.filter((model) => model.provider === BAI_PROVIDER);
  if (recorded.length === 0) return { status: "empty" };
  return {
    status: "measured",
    tokens: recorded.reduce((total, model) => total + model.tokens, 0),
    from: typeof data.range?.from === "number" ? data.range.from : null,
    to: typeof data.range?.to === "number" ? data.range.to : null,
  };
}

export interface UsageSnapshotController {
  state: UsageState;
  loading: boolean;
  /** Forces a read now; the same poller answers, so no second polling loop exists. */
  refresh: () => Promise<ResourceLoadState<UsageSnapshot>>;
  /** Holds the poll while a credential action is in flight, exactly as the panel used to. */
  setPaused: (paused: boolean) => void;
  /** The B.AI total the model aggregation recorded, with the span it covers. This is a readout, not
   *  a running total: it is read when the subscription mounts and again with every refresh, so a
   *  long session keeps it current through the refresh the user already has. */
  bai: BaiTokenUsage;
}

/**
 * The single usage poller of this app. The sidebar readout and the resource panel are two views of
 * this one subscription: mounting the panel does not start a second loop, and closing it does not
 * take the sidebar's numbers away. The B.AI token readout rides along - it reads the model
 * aggregation the resource panel already asks for, on the same refresh, through the sidecar's own
 * cache - and adds no polling loop of its own.
 */
export function useUsageSnapshot(): UsageSnapshotController {
  const [state, setState] = useState<UsageState>({ status: "idle", data: null, error: null });
  const [loading, setLoading] = useState(true);
  const [baiState, setBaiState] = useState<ResourceLoadState<ModelStatsSnapshot> | null>(null);
  const pollerRef = useRef<UsagePoller | null>(null);
  const baiControllerRef = useRef<AbortController | null>(null);

  const readBai = useCallback(() => {
    baiControllerRef.current?.abort();
    const controller = new AbortController();
    baiControllerRef.current = controller;
    void loadModelStats({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setBaiState(result);
    });
  }, []);

  useEffect(() => {
    const poller = createUsagePoller({
      onResult(result) {
        setState(result);
        setLoading(false);
      },
    });
    pollerRef.current = poller;
    poller.start();
    readBai();
    return () => {
      poller.stop();
      baiControllerRef.current?.abort();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [readBai]);

  const refresh = useCallback(async () => {
    const poller = pollerRef.current;
    if (!poller) {
      return {
        status: "error",
        data: null,
        error: new ResourceClientError("사용량 폴링이 시작되지 않았습니다.", "aborted"),
      } satisfies ResourceLoadState<UsageSnapshot>;
    }
    setLoading(true);
    // The token total shares this refresh but never delays the usage answer the caller awaits.
    readBai();
    const result = await poller.refresh();
    setLoading(false);
    return result;
  }, [readBai]);

  const setPaused = useCallback((paused: boolean) => {
    pollerRef.current?.setPaused(paused);
  }, []);

  const bai = useMemo(() => summarizeBai(baiState), [baiState]);

  return { state, loading, refresh, setPaused, bai };
}
