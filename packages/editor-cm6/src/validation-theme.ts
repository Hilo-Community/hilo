import { HILO_STATE_META, type HiloValidationState } from "@hilo/protocol-types";

export interface HiloStateVisualTokens {
  readonly state: HiloValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEn: string;
  readonly labelEs: string;
  readonly dark: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
  readonly light: {
    readonly background: string;
    readonly border: string;
    readonly text: string;
  };
}

export const HILO_STATE_VISUAL_TOKENS: Record<HiloValidationState, HiloStateVisualTokens> = {
  ValidatedGreen: {
    ...HILO_STATE_META.ValidatedGreen,
    dark: { background: "#052e16", border: "#22c55e", text: "#86efac" },
    light: { background: "#dcfce7", border: "#16a34a", text: "#14532d" },
  },
  ReviewYellow: {
    ...HILO_STATE_META.ReviewYellow,
    dark: { background: "#422006", border: "#eab308", text: "#fde047" },
    light: { background: "#fef9c3", border: "#ca8a04", text: "#713f12" },
  },
  FailedRed: {
    ...HILO_STATE_META.FailedRed,
    dark: { background: "#450a0a", border: "#ef4444", text: "#fca5a5" },
    light: { background: "#fee2e2", border: "#dc2626", text: "#7f1d1d" },
  },
  StaleOrange: {
    ...HILO_STATE_META.StaleOrange,
    dark: { background: "#431407", border: "#f97316", text: "#fdba74" },
    light: { background: "#ffedd5", border: "#ea580c", text: "#7c2d12" },
  },
  UnchangedBlue: {
    ...HILO_STATE_META.UnchangedBlue,
    dark: { background: "#0f172a", border: "#3b82f6", text: "#93c5fd" },
    light: { background: "#dbeafe", border: "#2563eb", text: "#1e3a8a" },
  },
};
