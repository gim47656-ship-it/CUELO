// Windows Job Object로 Claude Code 프로세스 트리 전체를 묶는다.
// Git Bash(MSYS)는 fork 스텁을 거쳐 실행하므로 손자(예: sleep.exe)의 Windows 부모 pid가 이미 끝난 프로세스를
// 가리킨다. 그래서 부모 pid를 따라가는 `taskkill /T`는 그 손자에 닿지 못한다(실측). job에 넣은 프로세스가 만든
// 자손은 job을 물려받으므로 TerminateJobObject 한 번으로 모두 끝나고, 남은 수(ActiveProcesses)로 종료를 관측한다.
// KILL_ON_JOB_CLOSE라서 이 프로세스가 죽어 핸들이 닫혀도 트리가 함께 끝난다.
import { dlopen, FFIType } from "bun:ffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: BASIC_LIMIT(64) + IO_COUNTERS(48) + 4×SIZE_T(32). LimitFlags는 오프셋 16. */
const EXTENDED_LIMIT_SIZE = 144;
/** JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses는 오프셋 40, 전체 48바이트. */
const ACCOUNTING_SIZE = 48;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0100 | 0x0001;

type Kernel32 = ReturnType<typeof openKernel32>;

function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
}

let kernel32: Kernel32 | undefined;

export interface ProcessTreeJob {
  /** job 안에서 아직 살아 있는 프로세스 수. */
  activeProcesses(): number;
  /** job 안의 모든 프로세스를 끝낸다. */
  terminate(): void;
  close(): void;
}

/** `pid`를 새 kill-on-close job에 넣는다. 실패하면 이유와 함께 throw. */
export function attachProcessTreeJob(pid: number): ProcessTreeJob {
  kernel32 ??= openKernel32();
  const k32 = kernel32;
  const job = k32.CreateJobObjectW(null, null);
  if (!job) throw new Error("CreateJobObjectW failed");
  const limits = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!k32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, limits, EXTENDED_LIMIT_SIZE)) {
    k32.CloseHandle(job);
    throw new Error("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed");
  }
  const process = k32.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid);
  if (!process) {
    k32.CloseHandle(job);
    throw new Error(`OpenProcess(${pid}) failed`);
  }
  const assigned = k32.AssignProcessToJobObject(job, process);
  k32.CloseHandle(process);
  if (!assigned) {
    k32.CloseHandle(job);
    throw new Error(`AssignProcessToJobObject(${pid}) failed`);
  }
  let handle: typeof job | undefined = job;
  return {
    activeProcesses() {
      if (!handle) return 0;
      const info = new Uint8Array(ACCOUNTING_SIZE);
      if (!k32.QueryInformationJobObject(handle, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS, info, ACCOUNTING_SIZE, null)) {
        throw new Error("QueryInformationJobObject failed");
      }
      return new DataView(info.buffer).getUint32(40, true);
    },
    terminate() {
      if (handle) k32.TerminateJobObject(handle, 1);
    },
    close() {
      if (handle) k32.CloseHandle(handle);
      handle = undefined;
    },
  };
}
