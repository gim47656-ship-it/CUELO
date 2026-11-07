/**
 * 보수 스캔용 세션 기록 읽기(Rust, `native/upkeep-reader`). 파일을 1 MiB 남짓씩 읽어 sessions.ts가 쓰는 필드만 남긴
 * entry 배열(JSON 문자열)로 넘긴다. 남긴 값은 원래 JSON 원문이라 JSON.parse 결과가 줄 전체를 읽은 것과 같다.
 * 그 모양으로 읽지 못한 줄은 원래 줄 문자열로 오고, 여기서 예전처럼 JSON.parse해 깨졌거나 객체가 아니면 건너뛴다.
 * 바이너리는 실행 위치(cwd)의 `bin/native/upkeep-reader/<platform>-<arch>.node`를 처음 쓸 때 읽는다.
 */
import { join } from "node:path";

type NativeReader = { next(): Promise<string | null>; close(): void };
type NativeModule = { UpkeepReader: new (path: string) => NativeReader };

let native: NativeModule | undefined;

/** 이 플랫폼용 바이너리를 읽는다. 없으면 그 오류를 그대로 던진다(다른 읽기 경로로 넘어가지 않는다). */
export function loadUpkeepReader(): NativeModule {
  if (!native) {
    // Next의 require 변환을 거치지 않고 배포된 네이티브 모듈을 직접 연다.
    const addon = { exports: {} as NativeModule };
    process.dlopen(addon, join(process.cwd(), "bin/native/upkeep-reader", `${process.platform}-${process.arch}.node`));
    native = addon.exports;
  }
  return native;
}

/** 파일 하나의 entry를 기록 순서대로 넘긴다. 열기·읽기 실패는 그 자리에서 예외로 올라간다. */
export async function* readSessionEntries<T extends object>(path: string): AsyncGenerator<T> {
  const reader = new (loadUpkeepReader().UpkeepReader)(path);
  try {
    let next = reader.next();
    for (;;) {
      const batch = await next;
      if (batch === null) return;
      // 이 묶음을 넘기는 동안 다음 묶음을 읽어 둔다. 실패는 그 묶음을 기다릴 때 올라간다.
      next = reader.next();
      next.catch(() => {});
      for (const item of JSON.parse(batch) as (T | string)[]) {
        if (typeof item !== "string") {
          yield item;
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(item);
        } catch {
          continue;
        }
        if (entry && typeof entry === "object") yield entry as T;
      }
    }
  } finally {
    reader.close();
  }
}
