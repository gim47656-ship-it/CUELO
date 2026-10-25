"use client";

import type { InterpreterCallController, InterpreterCallOptions } from "@/components/translator/useInterpreterCall";
import { CloudRelaySocket, releaseCloudRelayCall } from "@/lib/gemini-interpreter-audio";
import { useLiveInterpreterCall, type LiveInterpreterTransport } from "@/hooks/useGeminiInterpreterCall";

/**
 * Google Cloud(Vertex AI) 통역. Vertex의 Live API에는 일회용 토큰이 없어 자격은 서버의 ADC에만 있고,
 * 서버(`/api/live/interpret/cloud`)가 Vertex에 연결해 그 메시지를 SSE로 넘긴다. 브라우저는 서버가 준
 * 호출 번호만 안다. 고를 키가 없으므로, 서버 준비(`GET`의 `configured`·`signedIn`)를 확인하고 부르는 쪽이 연다.
 */
export const CLOUD_TRANSPORT: LiveInterpreterTransport = {
  endpoint: "/api/live/interpret/cloud",
  session: (record) => {
    const callId = typeof record.callId === "string" ? record.callId : "";
    return callId ? { createSocket: () => new CloudRelaySocket(callId) } : null;
  },
  // An answer that lost its race (stop, unmount, a newer open) still holds a relay slot and a Vertex
  // connection until the attach timeout; give them back now.
  discard: (record) => {
    if (typeof record.callId === "string" && record.callId) releaseCloudRelayCall(record.callId);
  },
};

export function useCloudInterpreterCall(options: InterpreterCallOptions): InterpreterCallController {
  return useLiveInterpreterCall(options, CLOUD_TRANSPORT);
}
