import type { JevRuleQuestion } from "../jev.js";

export const securityQuestions = {
  "hardcoded-secret": {
    type: "noul",
    instructions:
      "A credential or key is embedded in the code as a literal: a password, API key, access token, private key, or connection string with credentials. Look for high-entropy strings assigned to credential-like names, PEM blocks, and credentials inside URLs. Do not count obvious placeholders such as \"changeme\", \"example\", or \"test\", or values read from configuration, environment, or a secret manager. Only count a literal that grants access to a real system if the code ships with it.",
    criteria: {
      true: "a literal value in the code authenticates to, unlocks, or grants access to a real system",
      false:
        "the value is a placeholder, test fixture, public constant, or read from configuration, environment, or a secret manager",
    },
    report: { min: 0.9, severity: "error", message: "hardcoded secret" },
    locate: { lineMin: 0.3 },
  },
  "no-sensitive-logging": {
    type: "noul",
    instructions:
      "The code logs or exposes sensitive data such as passwords, API keys, tokens, or PII",
    criteria: {
      true: "a password, key, token, session value, or personal data reaches logs, errors, URLs, or an external sink",
      false:
        "only non-sensitive values are logged, or sensitive values are redacted or hashed before they reach the sink",
    },
    report: { min: 0.85, severity: "error", message: "logs sensitive data" },
    locate: { lineMin: 0.3 },
  },
  "broken-access-control": {
    type: "noul",
    instructions:
      "A privileged or sensitive operation can be performed without an authorization check, or an access decision depends on data the caller can forge: a request field, cookie, header, or client-supplied role, tenant, or user id. Look for missing ownership checks, checks that compare against attacker-controlled input, and endpoints that trust the caller's claims. Do not count authentication logic itself or static patterns. Only count when a concrete request from an unauthorized caller succeeds.",
    criteria: {
      true: "a concrete request from a caller who should not have access performs the privileged operation",
      false:
        "the operation enforces authorization on the server using data the caller cannot forge, or the operation is not privileged",
    },
    report: {
      min: 0.85,
      severity: "error",
      message: "broken access control",
    },
    locate: { lineMin: 0.3 },
  },
  "sql-injection": {
    type: "noul",
    instructions:
      "User-controlled data reaches a SQL or database query as text instead of a bound parameter: string concatenation or interpolation into a query, an ORM raw fragment built from input, or a stored procedure called with concatenated SQL. Do not count constant queries or values passed through parameters. Only count when a concrete input changes the structure of the query.",
    criteria: {
      true: "a concrete input alters the query text instead of being treated as a value",
      false:
        "all user data reaches the query as bound parameters, or the query is constant",
    },
    report: { min: 0.9, severity: "error", message: "SQL injection" },
    locate: { lineMin: 0.3 },
  },
  "command-injection": {
    type: "noul",
    instructions:
      "User-controlled data reaches a shell, process spawn, or eval-like sink as code or parsed arguments: a template string passed to a shell, a spawn with shell enabled and interpolated input, or eval or Function built from input. Do not count spawn calls that pass an argument array with no shell, or constant commands. Only count when a concrete input executes an additional command, changes arguments, or runs code.",
    criteria: {
      true: "a concrete input executes an additional command, changes arguments, or runs code",
      false:
        "the command is constant, or user data reaches the process as a separate argument with no shell",
    },
    report: { min: 0.9, severity: "error", message: "command injection" },
    locate: { lineMin: 0.3 },
  },
  "path-traversal": {
    type: "noul",
    instructions:
      "User-controlled data is used to build a filesystem path or archive entry without normalization or an allowlist, so input containing \"..\", an absolute path, or an alternate separator can read or write outside the intended directory. Do not count paths joined from trusted configuration or constants, or inputs constrained by a strict allowlist. Only count when a concrete input escapes the intended location.",
    criteria: {
      true: "a concrete input escapes the intended directory through the constructed path or entry name",
      false:
        "the path comes from trusted configuration or constants, or input is constrained by a strict allowlist",
    },
    report: { min: 0.9, severity: "error", message: "path traversal" },
    locate: { lineMin: 0.3 },
  },
  "server-side-request-forgery": {
    type: "noul",
    instructions:
      "A URL from user-controlled data is fetched or navigated to without restricting scheme and destination, so the caller can reach internal services, cloud metadata, or local files through file:// or a redirect. Do not count fetches to constant URLs or destinations pinned by configuration. Only count when a concrete input makes the request leave the intended destinations.",
    criteria: {
      true: "a concrete input makes the server request an unintended destination such as an internal host or local file",
      false:
        "the destination is constant or pinned by configuration, or user input is restricted by a scheme and host allowlist",
    },
    report: {
      min: 0.85,
      severity: "error",
      message: "server-side request forgery",
    },
    locate: { lineMin: 0.3 },
  },
  "cross-site-scripting": {
    type: "noul",
    instructions:
      "User-controlled data reaches HTML, a DOM sink, or a template without escaping or sanitization: innerHTML, document.write, a raw-HTML template directive, or a URL placed in href or src with a script scheme. Do not count values that are escaped or sanitized at the sink. Only count when a concrete input runs script or breaks out of the intended context.",
    criteria: {
      true: "a concrete input runs script or breaks out of the intended HTML, attribute, or URL context",
      false:
        "user data is escaped or sanitized for the context it reaches, or cannot contain markup",
    },
    report: { min: 0.85, severity: "warning", message: "cross-site scripting" },
    locate: { lineMin: 0.3 },
  },
  "unsafe-deserialization": {
    type: "noul",
    instructions:
      "Untrusted data is deserialized with a mechanism that can execute code or construct arbitrary objects: eval, Function, a YAML or XML parser with code-executing features enabled, a language-native object serializer, or a custom format that instantiates types from the payload. Do not count plain JSON parsed as data, even if its shape is unchecked. Only count when a crafted payload can run code or instantiate classes the code did not intend.",
    criteria: {
      true: "a crafted payload can execute code or instantiate types the code did not intend",
      false:
        "the data is parsed as plain data, or the parser is configured without code-executing or type-instantiating features",
    },
    report: {
      min: 0.85,
      severity: "warning",
      message: "unsafe deserialization",
    },
    locate: { lineMin: 0.3 },
  },
  "insecure-randomness": {
    type: "noul",
    instructions:
      "A value that protects something is generated with a predictable source: Math.random, Date.now, a counter, or a hash of them, used for tokens, session ids, passwords, nonces, or keys. Do not count randomness for layout, sampling, games, or jitter. Only count when guessing the value would let an attacker bypass a control or predict a secret.",
    criteria: {
      true: "guessing the generated value would let an attacker bypass a control or predict a secret",
      false:
        "the value is not security-sensitive, or it comes from a cryptographically secure source",
    },
    report: { min: 0.85, severity: "warning", message: "insecure randomness" },
    locate: { lineMin: 0.3 },
  },
  "weak-crypto": {
    type: "noul",
    instructions:
      "Cryptography is too weak for the data it protects: MD5 or SHA-1 used for passwords or integrity, ECB mode, a static or reused IV or nonce, a hardcoded or unsalted password hash, or custom cryptography instead of a standard construction. Do not count MD5 or SHA-1 used only as a non-security checksum or cache key. Only count when the weakness lets an attacker recover data or forge a value in practice.",
    criteria: {
      true: "the weakness lets an attacker recover protected data or forge a value in practice",
      false:
        "the construction is a standard one with an appropriate algorithm and fresh parameters, or the hash is a non-security checksum",
    },
    report: { min: 0.85, severity: "warning", message: "weak cryptography" },
    locate: { lineMin: 0.3 },
  },
  "verbose-error-exposure": {
    type: "noul",
    instructions:
      "A raw error, stack trace, query, or internal detail from a failure is returned to the caller or rendered in a response instead of a generic message: the response body includes the exception or its message, a template prints the stack, or an API returns internal paths or database errors. Do not count server-side logging or errors shown only in development. Only count when a remote or untrusted caller can read internal details.",
    criteria: {
      true: "a remote or untrusted caller can read internal error details from the response",
      false:
        "the response shows a generic message, or the details are only logged server-side or shown in development",
    },
    report: {
      min: 0.8,
      severity: "warning",
      message: "verbose error exposure",
    },
    locate: { lineMin: 0.3 },
  },
} satisfies Record<string, JevRuleQuestion>;
