import { HILO_STATE_VISUAL_TOKENS } from "@hilo/editor-cm6";
import type { HiloValidationState } from "@hilo/protocol-types";

export interface DesignStateTokens {
  readonly state: HiloValidationState;
  readonly icon: "✓" | "!" | "✕" | "⟳" | "•";
  readonly labelFr: string;
  readonly labelEn: string;
  readonly darkBg: string;
  readonly darkBorder: string;
  readonly darkText: string;
  readonly lightBg: string;
  readonly lightBorder: string;
  readonly lightText: string;
}

// Preserve the web UI's token shape while sharing the editor's palette.
export const HILO_DESIGN_TOKENS = Object.fromEntries(
  Object.values(HILO_STATE_VISUAL_TOKENS).map(({ state, icon, labelFr, labelEn, dark, light }) => [
    state,
    {
      state,
      icon,
      labelFr,
      labelEn,
      darkBg: dark.background,
      darkBorder: dark.border,
      darkText: dark.text,
      lightBg: light.background,
      lightBorder: light.border,
      lightText: light.text,
    } satisfies DesignStateTokens,
  ]),
) as Record<HiloValidationState, DesignStateTokens>;
