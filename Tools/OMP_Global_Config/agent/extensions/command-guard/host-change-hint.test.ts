import { describe, expect, test } from "bun:test";

import { hostSystemChangeHint } from "./host-change-hint";

describe("hostSystemChangeHint", () => {
  test("레지스트리·서비스·네트워크·부팅 설정 쓰기는 무엇을 바꾸는지와 함께 안내한다", () => {
    expect(hostSystemChangeHint('reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\X" /v Start /t REG_DWORD /d 4 /f')).toContain(
      "`reg add`",
    );
    expect(hostSystemChangeHint("sc.exe config WinDefend start= disabled")).toContain("`sc config`");
    expect(hostSystemChangeHint("sc \\\\PC01 stop Spooler")).toContain("`sc stop`");
    expect(hostSystemChangeHint("netsh advfirewall set allprofiles state off")).toContain("`netsh … set`");
    expect(hostSystemChangeHint("netsh.exe winsock reset")).toContain("`netsh … reset`");
    expect(hostSystemChangeHint("/mnt/c/Windows/System32/bcdedit.exe /set {current} testsigning on")).toContain("`bcdedit /set`");
  });

  test("다른 셸·명령 치환 안의 호출도 알아보고, 한 명령의 여러 변경을 함께 적는다", () => {
    const hint = hostSystemChangeHint("echo start && bash -c 'REG DELETE HKCU\\Software\\X /f' && x=$(sc.exe delete Old)");
    expect(hint).toContain("`reg delete`");
    expect(hint).toContain("`sc delete`");
  });

  test("변수에 담아 부른 실행 파일도 앞서 대입한 값으로 알아본다", () => {
    expect(hostSystemChangeHint('R=reg.exe; "$R" add HKCU\\Software\\X /v Probe /d 1 /f')).toContain("`reg add`");
  });

  test("조회 명령과 따옴표·heredoc 안의 언급은 안내하지 않는다", () => {
    expect(hostSystemChangeHint('reg.exe query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\X" /v Start')).toBeUndefined();
    expect(hostSystemChangeHint("sc.exe query WinDefend")).toBeUndefined();
    expect(hostSystemChangeHint("netsh interface show interface")).toBeUndefined();
    expect(hostSystemChangeHint("bcdedit.exe /enum")).toBeUndefined();
    expect(hostSystemChangeHint('echo "reg add HKLM\\X /f" && grep -n "sc config" notes.md')).toBeUndefined();
    expect(hostSystemChangeHint('netsh interface ipv4 show config "reset"')).toBeUndefined();
    expect(hostSystemChangeHint("netsh -r reset interface ipv4 show config")).toBeUndefined();
    expect(hostSystemChangeHint("reg.exe constructor")).toBeUndefined();
    expect(hostSystemChangeHint("sc.exe __proto__")).toBeUndefined();
    expect(hostSystemChangeHint("cat > plan.md <<'EOF'\nreg add HKLM\\X /f\nEOF")).toBeUndefined();
  });
});
