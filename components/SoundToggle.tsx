"use client";

/**
 * The composer's audio group: the completion chime of this browser, and nothing else. The chime is
 * a local preference of this device and never touches the run itself.
 */

interface SoundToggleProps {
  soundEnabled: boolean;
  onToggle: () => void;
}

const SPEAKER_ON = (
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </>
);

const SPEAKER_OFF = (
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="m22 9-6 6m0-6 6 6" />
  </>
);

export function SoundToggle({ soundEnabled, onToggle }: SoundToggleProps) {
  const label = soundEnabled ? "완료음 끄기" : "완료음 켜기";
  return (
    <div
      role="group"
      aria-label="오디오"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <button
        type="button"
        className={`composer-icon-button${soundEnabled ? " is-active" : ""}`}
        onClick={onToggle}
        aria-pressed={soundEnabled}
        title={label}
        aria-label={label}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {soundEnabled ? SPEAKER_ON : SPEAKER_OFF}
        </svg>
      </button>
    </div>
  );
}
