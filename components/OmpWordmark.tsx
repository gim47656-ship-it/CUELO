import type { CSSProperties, ReactNode } from "react";

type OmpWordmarkProps = {
  label?: ReactNode;
  markSize?: number;
  gap?: number;
  style?: CSSProperties;
  labelStyle?: CSSProperties;
};

export function OmpWordmark({
  label = "CUELO",
  markSize = 22,
  gap = 10,
  style,
  labelStyle,
}: OmpWordmarkProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap,
        minWidth: 0,
        color: "var(--text)",
        ...style,
      }}
    >
      {/* 나선 램프: 관측한 일이 돌아와 한가운데 켜진 큐 신호가 된다. 고리는 글자색, 램프만 색을 쓴다. */}
      <svg
        viewBox="0 0 100 100"
        width={markSize}
        height={markSize}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <path
          d="M77.9 30.5 A34 34 0 0 0 16 50 A26 26 0 0 0 68 50"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <circle cx="42" cy="50" r="8.5" fill="var(--brand-lamp)" />
      </svg>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          color: "inherit",
          fontFamily: '"Plus Jakarta Sans", Geist, ui-sans-serif, system-ui, sans-serif',
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: "-0.025em",
          whiteSpace: "nowrap",
          ...labelStyle,
        }}
      >
        {label}
      </span>
    </span>
  );
}
