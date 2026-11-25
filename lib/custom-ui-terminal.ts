import type { ExtensionRender, ExtensionRows, ExtensionTheme, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { createRoot, createSurface, getOwner, runWithOwner, type Surface } from "@oh-my-pi/pi-tui";
import { createTerminalDriver, type ProcessTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { ThemeSymbols } from "@oh-my-pi/pi-tui/theme/symbols";

const WEB_TERMINAL_SIZE = Object.freeze({ columns: 92, rows: 40 });
const plain = (text: string): string => text;
const plainStyle = (_style: unknown, text: string): string => text;

// The browser owns the modal's styling; explicit ANSI in an extension's output still works.
export const CUSTOM_UI_THEME: ExtensionTheme = {
  name: "web",
  dark: true,
  depth: "truecolor",
  symbols: new ThemeSymbols({ preset: "unicode" }),
  style: plainStyle,
  fg: plainStyle,
  fgResolved: plainStyle,
  bg: plainStyle,
  palette: plainStyle,
  has: () => false,
  fgSgr: () => "",
  hex: () => "",
  bold: plain,
  italic: plain,
  underline: plain,
  strikethrough: plain,
  inverse: plain,
};

export interface HeadlessCustomUi {
  readonly ui: ExtensionUiHost;
  run<T>(factory: () => T): T;
  mount(output: ExtensionRender): Promise<void>;
  handleInput(data: string): void;
  dispose(): void;
}

function isRows(output: ExtensionRender): output is ExtensionRows {
  return output !== null && typeof output === "object" && "render" in output && typeof output.render === "function";
}

export function createHeadlessCustomUi(
  present: (lines: string[]) => void,
  onError: (error: unknown) => void,
): HeadlessCustomUi {
  const root = createRoot((dispose) => ({ owner: getOwner(), dispose }));
  let surface: Surface | undefined;
  let driver: ProcessTerminalDriver | undefined;
  let backend: TermBackend | undefined;
  let rows: ExtensionRows | undefined;
  let disposed = false;

  const renderRows = () => {
    if (disposed || !rows) return;
    let lines: string[];
    try {
      lines = Array.from(rows.render(WEB_TERMINAL_SIZE.columns));
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (!disposed) present(lines);
  };

  return {
    ui: {
      size: () => WEB_TERMINAL_SIZE,
      requestRender: renderRows,
      async suspend() { throw new Error("CUELO web custom UI has no terminal to suspend"); },
    },
    run: (factory) => runWithOwner(root.owner, factory),
    async mount(output) {
      if (isRows(output)) {
        if (disposed) output.dispose?.();
        else {
          rows = output;
          renderRows();
        }
        return;
      }
      if (disposed) return;

      // Let pi-tui lay out the view and route keys to its focus path without a server TTY.
      surface = runWithOwner(root.owner, () => createSurface(() => ({ dock: output })));
      surface.focus(surface.dock()[0] ?? null);
      const memory = memoryTerminal(WEB_TERMINAL_SIZE);
      const terminal = createTerminalDriver(memory.options);
      await terminal.start();
      if (disposed) {
        await terminal.stop();
        return;
      }
      driver = terminal;
      const frameDriver: ProcessTerminalDriver = Object.create(terminal, {
        present: { value: (plan: FramePlan) => {
          if (!disposed) present(Array.from(plan.fullscreen ?? plan.viewport));
          return plan.history?.id;
        } },
      });
      // The terminal renderer schedules reactive frames; catch extension paint
      // errors there too. A fixed-input clock disables out-of-band terminal ticks.
      backend = new class extends TermBackend {
        override renderNow() {
          try {
            super.renderNow();
          } catch (error) {
            onError(error);
          }
        }
      }({ surface, driver: frameDriver, theme: () => CUSTOM_UI_THEME, clock: Date.now });
      backend.start();
    },
    handleInput(data) {
      if (disposed) return;
      if (rows) {
        rows.handleInput?.(data);
        renderRows();
      } else if (backend) {
        for (const event of decodeInput(data)) {
          if (disposed) break;
          backend.dispatch(event);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      backend?.stop();
      if (driver) void driver.stop().catch(onError);
      for (const cleanup of [rows?.dispose?.bind(rows), surface?.dispose, root.dispose]) {
        try {
          cleanup?.();
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}
