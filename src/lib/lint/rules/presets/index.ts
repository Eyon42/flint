import type { JevRuleQuestion } from "../jev.js";
import { qualityQuestions } from "./quality.js";
import { securityQuestions } from "./security.js";

export type JevPresetName = "quality" | "security";

export const presets: Record<JevPresetName, Record<string, JevRuleQuestion>> = {
  quality: qualityQuestions,
  security: securityQuestions,
};

export const PRESET_NAMES = Object.keys(presets) as JevPresetName[];

export { qualityQuestions, securityQuestions };
