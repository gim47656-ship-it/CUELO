#!/usr/bin/env python3
"""Local OCR of a screen region with click targets (Korean + English), about 1 s per 2560x1376 frame.

Run by the screen-fast-path plugin with ~/.omp/python-env/bin/python and the X session's DISPLAY/XAUTHORITY.
  screen_find.py --models DIR [--window REGEX] [--png PATH] [--find TEXT] [--click TEXT] [--nth N]
  --window  capture the largest visible window whose title matches (default: whole root window)
  --png     OCR an existing image instead of capturing (coordinates are image pixels; no click)
  --find    print only boxes whose text contains TEXT (case-insensitive, spaces ignored)
  --click   click the center of the Nth (default 1st) box containing TEXT through XTEST, then restore the mouse
Prints "x y score text" per box in global screen coordinates, then "clicked x y" after a click.
Exit codes: 0 ok, 2 bad arguments or no window, 3 nothing matched, 4 capture/click failure.
The captured png is deleted before OCR results are printed.
"""
import argparse, os, subprocess, sys, tempfile, time


def sh(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout.strip()


def fail(code, message):
    print(message, file=sys.stderr)
    sys.exit(code)


def find_window(pattern):
    """Largest visible window whose title matches; returns its X id."""
    try:
        ids = sh("xdotool", "search", "--onlyvisible", "--name", pattern).split()
    except subprocess.CalledProcessError:
        ids = []
    best = None
    for w in ids:
        try:
            g = dict(l.split("=", 1) for l in sh("xdotool", "getwindowgeometry", "--shell", w).splitlines())
        except subprocess.CalledProcessError:
            continue
        area = int(g["WIDTH"]) * int(g["HEIGHT"])
        if best is None or area > best[1]:
            best = (w, area)
    if not best or best[1] < 10000:
        fail(2, f"no visible window title matches {pattern!r}")
    return best[0]


# Capture runs in the system python3, which has the GTK bindings; the OCR venv does not need them.
# A window is read from its own pixels, so a window covered by others (or a compositing WM's redirected window)
# still gives its own content; the root window gives whatever is on top.
# With "-" as the output path it only prints the origin, so a later position is read the same way as the capture's.
CAPTURE = (
    "import gi,sys; gi.require_version('Gdk','3.0'); gi.require_version('GdkX11','3.0'); from gi.repository import Gdk,GdkX11; "
    "w=GdkX11.X11Window.foreign_new_for_display(GdkX11.X11Display.get_default(),int(sys.argv[1])) if sys.argv[1]!='root' else Gdk.get_default_root_window(); "
    "_,x,y=w.get_origin(); "
    "p=None if sys.argv[2]=='-' else Gdk.pixbuf_get_from_window(w,0,0,w.get_width(),w.get_height()); "
    "sys.argv[2]=='-' or p or sys.exit('capture returned nothing (window minimized or not viewable?)'); "
    "p and p.savev(sys.argv[2],'png',[],[]); print(x,y)"
)


def capture(window, path):
    """Save the window (or whole screen) to path, or with path "-" only read its origin; returns the origin."""
    run = subprocess.run(["/usr/bin/python3", "-c", CAPTURE, window or "root", path], capture_output=True, text=True)
    if run.returncode != 0:
        fail(4, f"screen capture failed: {(run.stderr or run.stdout).strip()[-300:]}")
    x0, y0 = run.stdout.split()
    return int(x0), int(y0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--models", required=True)
    p.add_argument("--window")
    p.add_argument("--png")
    p.add_argument("--find")
    p.add_argument("--click")
    p.add_argument("--nth", type=int, default=1)
    p.add_argument("--tmpdir", help="where the capture goes; the caller removes it even if this process is killed")
    a = p.parse_args()
    if a.png and a.click:
        fail(2, "--click needs a live screen; --png coordinates are image pixels")
    if a.nth < 1:
        fail(2, "--nth starts at 1")
    origin = (0, 0)
    png, tmp, window = a.png, None, None
    if not png:
        window = find_window(a.window) if a.window else None
        fd, tmp = tempfile.mkstemp(suffix=".png", prefix="screen-find-", dir=a.tmpdir)
        os.close(fd)
        png = tmp
    try:
        if tmp:
            origin = capture(window, tmp)
        elif not os.path.isfile(png):
            fail(2, f"no such image: {png}")
        from rapidocr_onnxruntime import RapidOCR
        eng = RapidOCR(
            rec_model_path=os.path.join(a.models, "korean_PP-OCRv5_rec_mobile.onnx"),
            rec_keys_path=os.path.join(a.models, "ppocrv5_korean_dict.txt"),
        )
        res, _ = eng(png)
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    boxes = []
    for box, txt, score in res or []:
        x = int(sum(pt[0] for pt in box) / 4) + origin[0]
        y = int(sum(pt[1] for pt in box) / 4) + origin[1]
        boxes.append((y, x, float(score), txt))
    boxes.sort()
    norm = lambda s: "".join(s.split()).lower()
    want = a.click or a.find
    if want:
        boxes = [b for b in boxes if norm(want) in norm(b[3])]
    for y, x, s, t in boxes:
        print(x, y, round(s, 2), t)
    if not boxes:
        fail(3, f"no text matches {want!r}" if want else "no text recognised")
    if a.click:
        if len(boxes) < a.nth:
            fail(3, f"only {len(boxes)} matches for {want!r}, nth={a.nth}")
        y, x, _, _ = boxes[a.nth - 1]
        m = None
        try:
            m = dict(l.split("=", 1) for l in sh("xdotool", "getmouselocation", "--shell").splitlines())
            # XTEST clicks land on whatever is on top, so a covered window has to come to the front first.
            if window:
                sh("xdotool", "windowactivate", "--sync", window)
                time.sleep(0.2)
                # The window may have moved since the capture; shift the target by the same amount.
                after = capture(window, "-")
                x, y = x + after[0] - origin[0], y + after[1] - origin[1]
            sh("xdotool", "mousemove", str(x), str(y), "click", "1")
        except subprocess.CalledProcessError as e:
            fail(4, f"click failed: {e.stderr.strip()[-300:]}")
        finally:
            if m:
                subprocess.run(["xdotool", "mousemove", m["X"], m["Y"]], capture_output=True)
        print(f"clicked {x} {y}")


if __name__ == "__main__":
    main()
