import type { Formatter } from "../types.js";
import { jsonFormatter } from "./json.js";
import { prettyFormatter } from "./pretty.js";

export const FORMATTERS = {
  pretty: prettyFormatter,
  json: jsonFormatter,
} as const;

export type FormatterName = keyof typeof FORMATTERS;

export function resolveFormatter(name: FormatterName): Formatter {
  return FORMATTERS[name];
}
