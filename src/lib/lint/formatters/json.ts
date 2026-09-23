import type { Formatter } from "../types.js";

export const jsonFormatter: Formatter = {
  name: "json",
  render(result) {
    const payload = {
      version: 1,
      diagnostics: result.diagnostics,
      toolDiagnostics: result.toolDiagnostics,
      notices: result.notices,
      summary: result.summary,
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  },
};
