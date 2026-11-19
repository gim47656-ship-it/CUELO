"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createUsagePoller,
  ResourceClientError,
  type ResourceLoadState,
  type UsagePoller,
  type UsageSnapshot,
} from "@/lib/hanse-resource-client";

export type UsageState =
  | { status: "idle"; data: null; error: null }
  | ResourceLoadState<UsageSnapshot>;

export interface UsageSnapshotController {
  state: UsageState;
  loading: boolean;
  /** Forces a read now; the same poller answers, so no second polling loop exists. */
  refresh: () => Promise<ResourceLoadState<UsageSnapshot>>;
  /** Holds the poll while a credential action is in flight, exactly as the panel used to. */
  setPaused: (paused: boolean) => void;
}

/**
 * The single usage poller of this app. The sidebar readout and the resource panel are two views of
 * this one subscription: mounting the panel does not start a second loop, and closing it does not
 * take the sidebar's numbers away.
 */
export function useUsageSnapshot(): UsageSnapshotController {
  const [state, setState] = useState<UsageState>({ status: "idle", data: null, error: null });
  const [loading, setLoading] = useState(true);
  const pollerRef = useRef<UsagePoller | null>(null);

  useEffect(() => {
    const poller = createUsagePoller({
      onResult(result) {
        setState(result);
        setLoading(false);
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, []);

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
    const result = await poller.refresh();
    setLoading(false);
    return result;
  }, []);

  const setPaused = useCallback((paused: boolean) => {
    pollerRef.current?.setPaused(paused);
  }, []);

  return { state, loading, refresh, setPaused };
}
