import { useId, type CSSProperties, type ReactNode } from "react";

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
  const gradientId = `omp-pi-gradient-${useId().replaceAll(":", "")}`;

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
      <svg
        viewBox="0 0 24 24"
        width={markSize}
        height={markSize}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.7 0.24 340)" />
            <stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
            <stop offset="1" stopColor="oklch(0.81 0.14 200)" />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${gradientId})`}
          d="M4 6 C7.5 1.8 15.5 2 19 6.2 L22.5 12 L19.3 16.2 C16.4 21.3 8.5 22.2 4.2 17.8 L7 15.2 C10 19.7 15.3 18.7 17 14.2 L19 12 L16.2 9 C14.1 6.4 9.8 6.1 6.8 9.1 Z"
        />
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
