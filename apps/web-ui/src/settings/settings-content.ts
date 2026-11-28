/** Categories of the Settings sidebar. Each group is a heading inside its category. */
export const SETTINGS_SECTIONS = [
  {
    id: "external-agents",
    label: "External Agents",
    groups: ["ACP Registry"],
    keywords: "acp registry agents install update remove",
  },
  {
    id: "ai-completion",
    label: "AI Completion",
    groups: ["Local model"],
    keywords: "ollama local model completion qwen suggestions privacy offline",
  },
  {
    id: "appearance",
    label: "Appearance",
    groups: ["Theme"],
    keywords: "appearance theme dark light color colors palette",
  },
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
