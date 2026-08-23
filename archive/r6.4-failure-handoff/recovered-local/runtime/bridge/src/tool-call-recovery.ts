import { createHash } from "node:crypto";

export type ToolProtocolRecoveryKind =
  | "dsml_content_to_tool_calls"
  | "structured_tool_call_delta_normalized"
  | "markdown_shell_fence_to_tool_calls"
  | "text_tool_call_envelope_to_tool_calls";

export interface ToolProtocolTransformResult {
  body: Buffer;
  contentType: string;
  changed: boolean;
  recoveryKinds: ToolProtocolRecoveryKind[];
  recoveredToolNames: string[];
  /** Native structured calls observed without requiring recovery. */
  nativeToolCallCount?: number;
  nativeToolNames?: string[];
  /** A tool-call marker was present but could not be converted safely. */
  failure?: string;
}

interface RecoveredToolCall {
  name: string;
  arguments: string;
  id: string;
}

interface ParsedTextToolCalls {
  calls: RecoveredToolCall[];
  remainingText: string;
  markerFound: boolean;
  failure?: string;
}

interface SseEnvelope {
  base: Record<string, unknown>;
  reasoning: string;
  content: string;
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>;
  structuredNeedsNormalization: boolean;
  usage?: unknown;
  finishReason?: unknown;
}

const DSML_PREFIX = String.raw`(?:(?:\uFF5C|\|)DSML(?:\uFF5C|\|))?`;
const INVOKE_RE = new RegExp(`<${DSML_PREFIX}invoke\\b([^>]*)>([\\s\\S]*?)<\\/${DSML_PREFIX}invoke\\s*>`, "giu");
const PARAM_RE = new RegExp(`<${DSML_PREFIX}parameter\\b([^>]*)>([\\s\\S]*?)<\\/${DSML_PREFIX}parameter\\s*>`, "giu");
const OUTER_OPEN_RE = new RegExp(`<${DSML_PREFIX}tool_calls\\s*>`, "giu");
const OUTER_CLOSE_RE = new RegExp(`<\\/${DSML_PREFIX}tool_calls\\s*>`, "giu");
const ANY_DSML_RE = /<(?:(?:\uFF5C|\|)DSML(?:\uFF5C|\|))?(?:tool_calls|invoke|parameter)\b/iu;
const MAX_RECOVERED_CALLS = 16;
const MAX_ARGUMENT_BYTES = 2_000_000;
const SHELL_FENCE_MARKER_RE = /```[ \t]*(?:bash|sh|shell|zsh|pwsh|powershell)\b/iu;
const EXACT_SHELL_FENCE_RE = /^\s*```[ \t]*(bash|sh|shell|zsh|pwsh|powershell)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/iu;
const BOUNDED_LEAF_MARKER = "# CODEX-HARNESS BOUNDED LEAF CONTRACT";
const MUTATING_MODE_RE = /^Mode:\s*(?:implementation|test|repair)\s*$/imu;
const WRITE_LEASE_SECTION_RE = /^## Harness exclusive write leases\s*\n([\s\S]*?)(?=\n\n|\n## |$)/imu;

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(attributes);
  return match?.[2] === undefined ? undefined : decodeXml(match[2]);
}

function insideFence(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  return (prefix.match(/```/g)?.length ?? 0) % 2 === 1;
}

function hasDsmlMarkerOutsideFence(text: string): boolean {
  const marker = new RegExp(ANY_DSML_RE.source, "giu");
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    if (!insideFence(text, match.index)) return true;
    if (match[0].length === 0) marker.lastIndex += 1;
  }
  return false;
}

function stableCallId(seed: string, index: number): string {
  return `call_bridge_${createHash("sha256").update(seed).update(`\n${index}`).digest("hex").slice(0, 24)}`;
}

function parseParameterValue(raw: string, stringAttribute: string | undefined): unknown {
  const decoded = decodeXml(raw);
  if (stringAttribute?.toLowerCase() === "true") return decoded;
  if (stringAttribute?.toLowerCase() === "false") return JSON.parse(decoded.trim());
  const trimmed = decoded.trim();
  if (trimmed === "") return "";
  try { return JSON.parse(trimmed); }
  catch { return decoded; }
}

function previousMatch(re: RegExp, text: string, before: number): RegExpExecArray | undefined {
  re.lastIndex = 0;
  let found: RegExpExecArray | undefined;
  for (let current = re.exec(text); current; current = re.exec(text)) {
    if (current.index >= before) break;
    found = current;
    if (current[0].length === 0) re.lastIndex += 1;
  }
  return found;
}

function nextMatch(re: RegExp, text: string, after: number): RegExpExecArray | undefined {
  re.lastIndex = after;
  return re.exec(text) ?? undefined;
}

export function allowedToolNamesFromRequest(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const tools = body.tools;
  if (!Array.isArray(tools)) return names;
  for (const raw of tools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const tool = raw as Record<string, unknown>;
    const fn = tool.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names;
}

export function parseDsmlToolCalls(text: string, allowedNames: ReadonlySet<string>): ParsedTextToolCalls {
  const markerFound = hasDsmlMarkerOutsideFence(text);
  if (!markerFound) return { calls: [], remainingText: text, markerFound: false };
  const calls: RecoveredToolCall[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  INVOKE_RE.lastIndex = 0;
  for (let match = INVOKE_RE.exec(text); match; match = INVOKE_RE.exec(text)) {
    if (insideFence(text, match.index)) continue;
    if (calls.length >= MAX_RECOVERED_CALLS) {
      return { calls: [], remainingText: text, markerFound: true, failure: `DSML contains more than ${MAX_RECOVERED_CALLS} tool calls` };
    }
    const invokeAttributes = match[1] ?? "";
    const body = match[2] ?? "";
    const name = attribute(invokeAttributes, "name")?.trim();
    if (!name) return { calls: [], remainingText: text, markerFound: true, failure: "DSML invoke is missing a tool name" };
    if (!allowedNames.has(name)) {
      return { calls: [], remainingText: text, markerFound: true, failure: `DSML requested an undisclosed tool: ${name}` };
    }
    const argumentsObject: Record<string, unknown> = {};
    PARAM_RE.lastIndex = 0;
    for (let parameter = PARAM_RE.exec(body); parameter; parameter = PARAM_RE.exec(body)) {
      const parameterName = attribute(parameter[1] ?? "", "name")?.trim();
      if (!parameterName) return { calls: [], remainingText: text, markerFound: true, failure: `DSML tool ${name} has a parameter without a name` };
      if (Object.hasOwn(argumentsObject, parameterName)) {
        return { calls: [], remainingText: text, markerFound: true, failure: `DSML tool ${name} repeats parameter ${parameterName}` };
      }
      try {
        argumentsObject[parameterName] = parseParameterValue(parameter[2] ?? "", attribute(parameter[1] ?? "", "string"));
      } catch (error) {
        return {
          calls: [], remainingText: text, markerFound: true,
          failure: `DSML tool ${name} parameter ${parameterName} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const argumentsJson = JSON.stringify(argumentsObject);
    if (Buffer.byteLength(argumentsJson, "utf8") > MAX_ARGUMENT_BYTES) {
      return { calls: [], remainingText: text, markerFound: true, failure: `DSML tool ${name} arguments exceed ${MAX_ARGUMENT_BYTES} bytes` };
    }
    calls.push({ name, arguments: argumentsJson, id: stableCallId(match[0], calls.length) });
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) INVOKE_RE.lastIndex += 1;
  }
  if (calls.length === 0) {
    return { calls: [], remainingText: text, markerFound: true, failure: "DSML marker was present but no complete executable invoke block was found" };
  }

  const first = ranges[0]!;
  const last = ranges.at(-1)!;
  const outerOpen = previousMatch(OUTER_OPEN_RE, text, first.start);
  const outerClose = nextMatch(OUTER_CLOSE_RE, text, last.end);
  const removeStart = outerOpen && !insideFence(text, outerOpen.index) ? outerOpen.index : first.start;
  const removeEnd = outerClose && !insideFence(text, outerClose.index)
    ? outerClose.index + outerClose[0].length
    : last.end;
  const remainingText = `${text.slice(0, removeStart)}${text.slice(removeEnd)}`.trim();
  return { calls, remainingText, markerFound: true };
}


function messageContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
  }).join("\n");
}

function taskContractText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  return messages.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const message = raw as Record<string, unknown>;
    if (message.role !== "user") return [];
    const text = messageContentText(message.content);
    return text.includes(BOUNDED_LEAF_MARKER) ? [text] : [];
  }).join("\n\n");
}

/**
 * Markdown shell recovery is deliberately narrower than DSML recovery. It is
 * only available for a Bridge-authored mutating leaf with at least one real
 * write lease. An exact standalone shell fence is then treated as a degraded
 * native tool call, including after earlier tool results when a task requires
 * more than one bounded command.
 */
export function isMutatingBoundedLeafRequest(body: Record<string, unknown>): boolean {
  const contract = taskContractText(body);
  if (!contract || !MUTATING_MODE_RE.test(contract)) return false;
  const leases = WRITE_LEASE_SECTION_RE.exec(contract)?.[1] ?? "";
  return leases.split(/\r?\n/u).some((line) => {
    const value = line.trim();
    return value.startsWith("- ") && value !== "- （无）" && value !== "- (none)";
  });
}

export function parseMarkdownShellToolCall(
  text: string,
  allowedNames: ReadonlySet<string>,
  requestBody: Record<string, unknown>,
): ParsedTextToolCalls {
  if (!isMutatingBoundedLeafRequest(requestBody)) {
    return { calls: [], remainingText: text, markerFound: false };
  }
  const markerFound = SHELL_FENCE_MARKER_RE.test(text);
  if (!markerFound) return { calls: [], remainingText: text, markerFound: false };
  const match = EXACT_SHELL_FENCE_RE.exec(text);
  if (!match) {
    return {
      calls: [], remainingText: text, markerFound: true,
      failure: "minimal Harness returned executable shell Markdown that was not a single standalone fenced block",
    };
  }
  const language = (match[1] ?? "").toLowerCase();
  const command = match[2] ?? "";
  if (command.trim().length === 0) {
    return { calls: [], remainingText: text, markerFound: true, failure: "minimal Harness returned an empty shell Markdown block" };
  }
  const toolName = ["pwsh", "powershell"].includes(language) ? "pwsh" : "bash";
  if (!allowedNames.has(toolName)) {
    return {
      calls: [], remainingText: text, markerFound: true,
      failure: `minimal Harness returned a ${language} Markdown block but the ${toolName} tool was not disclosed`,
    };
  }
  const argumentsJson = JSON.stringify({ command });
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_ARGUMENT_BYTES) {
    return {
      calls: [], remainingText: text, markerFound: true,
      failure: `Markdown shell tool arguments exceed ${MAX_ARGUMENT_BYTES} bytes`,
    };
  }
  return {
    calls: [{ name: toolName, arguments: argumentsJson, id: stableCallId(text, 0) }],
    remainingText: "",
    markerFound: true,
  };
}

const TEXT_TOOL_TAG_MARKER_RE = /<(?:tool[_-]?calls?|function[_-]?calls?)\b/iu;
const EXACT_SINGLE_TOOL_TAG_RE = /^\s*<(tool[_-]?call|function[_-]?call)(?:\s+name\s*=\s*(["'])([A-Za-z0-9_-]{1,64})\2)?\s*>([\s\S]*?)<\/\1\s*>\s*$/iu;
const EXACT_TOOL_COLLECTION_TAG_RE = /^\s*<(tool[_-]?calls|function[_-]?calls)\s*>([\s\S]*?)<\/\1\s*>\s*$/iu;
const EXACT_JSON_TOOL_FENCE_RE = /^\s*```[ \t]*(?:json|tool|tool[_-]?call|function[_-]?call)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/iu;
const EXACT_NAMED_TOOL_JSON_RE = /^\s*([A-Za-z0-9_-]{1,64})(?:[ \t]+tool[_ -]?call)?[ \t]*:?\s*\r?\n([\s\S]+?)\s*$/iu;
const EXACT_FUNCTION_STYLE_RE = /^\s*([A-Za-z0-9_-]{1,64})\s*\(\s*([\s\S]+)\s*\)\s*$/u;
const EXACT_INLINE_NAMED_TOOL_JSON_RE = /^\s*([A-Za-z0-9_-]{1,64})(?:[ \t]+tool[_ -]?call)?[ \t]*:?\s+([\[{][\s\S]*[\]}])\s*$/iu;
const EXACT_BRACKET_CALLING_TOOL_RE = /^\s*\[Calling[ \t]+tool:[ \t]*([A-Za-z0-9_-]{1,64})[ \t]+with[ \t]+arguments:[ \t]*([\s\S]+)\]\s*$/iu;
const EXACT_LABELLED_TOOL_RE = /^\s*(?:tool[_ -]?call|function[_ -]?call)[ \t]*:[ \t]*([A-Za-z0-9_-]{1,64})\s*(?:\r?\n|[ \t]+)(?:arguments|parameters)[ \t]*:[ \t]*([\s\S]+?)\s*$/iu;
const TEXT_TOOL_SHAPE_MARKER_RE = /["'](?:tool_calls|tool_call|tool|tool_name|function_name|arguments|parameters)["']\s*:/iu;

interface ParsedCallValue {
  calls?: RecoveredToolCall[];
  failure?: string;
}

function argumentObject(value: unknown, name: string): { value?: Record<string, unknown>; failure?: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) return { value: value as Record<string, unknown> };
  if (typeof value !== "string") return { failure: `textual tool call ${name} arguments must be a JSON object or string` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { failure: `textual tool call ${name} arguments are empty` };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { value: parsed as Record<string, unknown> };
  } catch { /* shell command strings are handled below */ }
  if (name === "bash" || name === "pwsh") return { value: { command: value } };
  return { failure: `textual tool call ${name} arguments are not a JSON object` };
}

function callFromRecord(
  record: Record<string, unknown>,
  allowedNames: ReadonlySet<string>,
  seed: string,
  index: number,
  forcedName?: string,
): { call?: RecoveredToolCall; failure?: string } {
  const functionRecord = record.function && typeof record.function === "object" && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : undefined;
  const rawName = forcedName
    ?? (typeof functionRecord?.name === "string" ? functionRecord.name : undefined)
    ?? (typeof record.name === "string" ? record.name : undefined)
    ?? (typeof record.tool === "string" ? record.tool : undefined)
    ?? (typeof record.tool_name === "string" ? record.tool_name : undefined)
    ?? (typeof record.function_name === "string" ? record.function_name : undefined);
  const name = rawName?.trim();
  if (!name) return { failure: "textual tool call is missing a tool name" };
  if (!allowedNames.has(name)) return { failure: `textual response requested an undisclosed tool: ${name}` };

  const rawArguments = functionRecord?.arguments
    ?? record.arguments
    ?? record.parameters
    ?? record.input
    ?? record.args
    ?? (forcedName ? record : undefined);
  const parsedArguments = argumentObject(rawArguments, name);
  if (!parsedArguments.value) return { failure: parsedArguments.failure ?? `textual tool call ${name} has invalid arguments` };
  const argumentsJson = JSON.stringify(parsedArguments.value);
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_ARGUMENT_BYTES) {
    return { failure: `textual tool call ${name} arguments exceed ${MAX_ARGUMENT_BYTES} bytes` };
  }
  const rawId = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : undefined;
  return { call: { name, arguments: argumentsJson, id: rawId ?? stableCallId(seed, index) } };
}

function looksLikeCallRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.tool_calls) || Array.isArray(record.calls)) return true;
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") return true;
  return [record.name, record.tool, record.tool_name, record.function_name].some((entry) => typeof entry === "string");
}

function callsFromJsonValue(
  value: unknown,
  allowedNames: ReadonlySet<string>,
  seed: string,
  forcedName?: string,
): ParsedCallValue {
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.tool_calls)) entries = record.tool_calls;
    else if (Array.isArray(record.calls)) entries = record.calls;
    else entries = [record];
  } else return { failure: "textual tool-call payload must be a JSON object or array" };
  if (entries.length === 0) return { failure: "textual tool-call payload is empty" };
  if (entries.length > MAX_RECOVERED_CALLS) return { failure: `textual response contains more than ${MAX_RECOVERED_CALLS} tool calls` };
  const calls: RecoveredToolCall[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { failure: `textual tool call ${index} is not a JSON object` };
    const parsed = callFromRecord(entry as Record<string, unknown>, allowedNames, seed, index, forcedName);
    if (!parsed.call) return { failure: parsed.failure ?? `textual tool call ${index} is invalid` };
    calls.push(parsed.call);
  }
  return { calls };
}

function parseJsonToolPayload(
  raw: string,
  allowedNames: ReadonlySet<string>,
  seed: string,
  forcedName?: string,
): ParsedCallValue {
  let value: unknown;
  try { value = JSON.parse(raw.trim()) as unknown; }
  catch (error) { return { failure: `textual tool-call JSON is invalid: ${error instanceof Error ? error.message : String(error)}` }; }
  return callsFromJsonValue(value, allowedNames, seed, forcedName);
}

/**
 * Recover only exact, whole-response textual tool-call envelopes. This covers
 * compatibility layers that serialize an OpenAI tool call into assistant text
 * instead of the structured `tool_calls` field. Ordinary prose and ordinary
 * JSON output are never executable: the payload must carry an explicit tool
 * call marker/name and the named tool must already be disclosed by the request.
 */
export function parseTextualToolCallEnvelope(
  text: string,
  allowedNames: ReadonlySet<string>,
  requestBody: Record<string, unknown>,
): ParsedTextToolCalls {
  if (!isMutatingBoundedLeafRequest(requestBody)) return { calls: [], remainingText: text, markerFound: false };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { calls: [], remainingText: text, markerFound: false };

  const collection = EXACT_TOOL_COLLECTION_TAG_RE.exec(trimmed);
  if (collection) {
    const inner = collection[2] ?? "";
    const wrappers = [...inner.matchAll(/<(tool[_-]?call|function[_-]?call)(?:\s+name\s*=\s*(["'])([A-Za-z0-9_-]{1,64})\2)?\s*>([\s\S]*?)<\/\1\s*>/giu)];
    if (wrappers.length > 0) {
      const consumed = wrappers.map((match) => match[0]).join("");
      if (inner.replace(/\s/gu, "") !== consumed.replace(/\s/gu, "")) {
        return { calls: [], remainingText: text, markerFound: true, failure: "textual tool-call collection contains ambiguous content outside call wrappers" };
      }
      const calls: RecoveredToolCall[] = [];
      for (const [index, wrapper] of wrappers.entries()) {
        const forcedName = wrapper[3];
        const raw = (wrapper[4] ?? "").trim();
        const parsed = parseJsonToolPayload(raw, allowedNames, wrapper[0], forcedName);
        if (!parsed.calls) return { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
        for (const call of parsed.calls) calls.push({ ...call, id: call.id || stableCallId(wrapper[0], index) });
      }
      return { calls, remainingText: "", markerFound: true };
    }
    const parsed = parseJsonToolPayload(inner, allowedNames, trimmed);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
  }

  const single = EXACT_SINGLE_TOOL_TAG_RE.exec(trimmed);
  if (single) {
    const forcedName = single[3];
    const inner = (single[4] ?? "").trim();
    const parsed = parseJsonToolPayload(inner, allowedNames, trimmed, forcedName);
    if (parsed.calls) return { calls: parsed.calls, remainingText: "", markerFound: true };
    if (forcedName && (forcedName === "bash" || forcedName === "pwsh") && inner.length > 0) {
      const direct = callFromRecord({ arguments: inner }, allowedNames, trimmed, 0, forcedName);
      if (direct.call) return { calls: [direct.call], remainingText: "", markerFound: true };
    }
    return { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
  }

  const fenced = EXACT_JSON_TOOL_FENCE_RE.exec(trimmed);
  if (fenced) {
    const raw = fenced[1] ?? "";
    const parsed = parseJsonToolPayload(raw, allowedNames, trimmed);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let value: unknown;
    try { value = JSON.parse(trimmed) as unknown; }
    catch { value = undefined; }
    const markerFound = Boolean(value && typeof value === "object" && (
      Array.isArray(value)
        ? value.length > 0 && value.every(looksLikeCallRecord)
        : looksLikeCallRecord(value)
          || Object.keys(value as Record<string, unknown>).some((key) => ["tool_calls", "calls"].includes(key))
    ));
    if (markerFound) {
      const parsed = callsFromJsonValue(value, allowedNames, trimmed);
      return parsed.calls
        ? { calls: parsed.calls, remainingText: "", markerFound: true }
        : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
    }
  }

  const named = EXACT_NAMED_TOOL_JSON_RE.exec(trimmed);
  if (named && allowedNames.has(named[1] ?? "")) {
    const name = named[1] ?? "";
    const parsed = parseJsonToolPayload(named[2] ?? "", allowedNames, trimmed, name);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
  }

  const functionStyle = EXACT_FUNCTION_STYLE_RE.exec(trimmed);
  if (functionStyle && allowedNames.has(functionStyle[1] ?? "")) {
    const name = functionStyle[1] ?? "";
    const parsed = parseJsonToolPayload(functionStyle[2] ?? "", allowedNames, trimmed, name);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? "textual tool-call payload is invalid" };
  }

  const inlineNamed = EXACT_INLINE_NAMED_TOOL_JSON_RE.exec(trimmed);
  if (inlineNamed && allowedNames.has(inlineNamed[1] ?? "")) {
    const name = inlineNamed[1] ?? "";
    const parsed = parseJsonToolPayload(inlineNamed[2] ?? "", allowedNames, trimmed, name);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? `textual tool call ${name} is invalid` };
  }

  const bracket = EXACT_BRACKET_CALLING_TOOL_RE.exec(trimmed);
  if (bracket) {
    const name = bracket[1] ?? "";
    if (!allowedNames.has(name)) return { calls: [], remainingText: text, markerFound: true, failure: `textual response requested an undisclosed tool: ${name}` };
    const parsed = parseJsonToolPayload(bracket[2] ?? "", allowedNames, trimmed, name);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? `textual tool call ${name} is invalid` };
  }

  const labelled = EXACT_LABELLED_TOOL_RE.exec(trimmed);
  if (labelled) {
    const name = labelled[1] ?? "";
    if (!allowedNames.has(name)) return { calls: [], remainingText: text, markerFound: true, failure: `textual response requested an undisclosed tool: ${name}` };
    const parsed = parseJsonToolPayload(labelled[2] ?? "", allowedNames, trimmed, name);
    return parsed.calls
      ? { calls: parsed.calls, remainingText: "", markerFound: true }
      : { calls: [], remainingText: text, markerFound: true, failure: parsed.failure ?? `textual tool call ${name} is invalid` };
  }

  const markerFound = TEXT_TOOL_TAG_MARKER_RE.test(trimmed)
    || (TEXT_TOOL_SHAPE_MARKER_RE.test(trimmed) && [...allowedNames].some((name) => trimmed.includes(name)));
  return markerFound
    ? { calls: [], remainingText: text, markerFound: true, failure: "textual tool-call marker was present but the response was not an exact supported envelope" }
    : { calls: [], remainingText: text, markerFound: false };
}

function ssePayloads(buffer: Buffer): Array<Record<string, unknown>> {
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  const payloads: Array<Record<string, unknown>> = [];
  for (const event of text.split(/\n\n+/)) {
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payloads.push(parsed as Record<string, unknown>);
    } catch { /* malformed provider data is handled by the provider adapter */ }
  }
  return payloads;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectSse(buffer: Buffer): SseEnvelope {
  const payloads = ssePayloads(buffer);
  const envelope: SseEnvelope = { base: {}, reasoning: "", content: "", toolCalls: new Map(), structuredNeedsNormalization: false };
  for (const payload of payloads) {
    if (Object.keys(envelope.base).length === 0) {
      const { choices: _choices, usage: _usage, ...base } = payload;
      envelope.base = base;
    }
    if (payload.usage !== undefined) envelope.usage = payload.usage;
    const choices = payload.choices;
    if (!Array.isArray(choices)) continue;
    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) continue;
      const choice = rawChoice as Record<string, unknown>;
      if (choice.finish_reason !== undefined) envelope.finishReason = choice.finish_reason;
      const deltaRaw = choice.delta;
      if (!deltaRaw || typeof deltaRaw !== "object" || Array.isArray(deltaRaw)) continue;
      const delta = deltaRaw as Record<string, unknown>;
      if (typeof delta.reasoning_content === "string") envelope.reasoning += delta.reasoning_content;
      if (typeof delta.content === "string") envelope.content += delta.content;
      const toolCalls = delta.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const rawCall of toolCalls) {
        if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
        const call = rawCall as Record<string, unknown>;
        const rawIndex = call.index;
        const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : envelope.toolCalls.size;
        const current = envelope.toolCalls.get(index) ?? { arguments: "" };
        const id = nonEmpty(call.id);
        if (call.id !== undefined && id === undefined) envelope.structuredNeedsNormalization = true;
        if (id !== undefined) current.id = id;
        const fnRaw = call.function;
        if (fnRaw && typeof fnRaw === "object" && !Array.isArray(fnRaw)) {
          const fn = fnRaw as Record<string, unknown>;
          const name = nonEmpty(fn.name);
          if (fn.name !== undefined && name === undefined) envelope.structuredNeedsNormalization = true;
          if (name !== undefined) current.name = name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        }
        envelope.toolCalls.set(index, current);
      }
    }
  }
  return envelope;
}

function sseLine(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function synthesizedSse(
  envelope: SseEnvelope,
  calls: RecoveredToolCall[],
  remainingText: string,
): Buffer {
  const chunks: string[] = [];
  const base = envelope.base;
  if (envelope.reasoning) {
    chunks.push(sseLine({ ...base, choices: [{ index: 0, delta: { reasoning_content: envelope.reasoning }, finish_reason: null }] }));
  }
  if (remainingText) {
    chunks.push(sseLine({ ...base, choices: [{ index: 0, delta: { content: remainingText }, finish_reason: null }] }));
  }
  calls.forEach((call, index) => {
    chunks.push(sseLine({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
        finish_reason: null,
      }],
    }));
  });
  chunks.push(sseLine({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    ...(envelope.usage === undefined ? {} : { usage: envelope.usage }),
  }));
  chunks.push("data: [DONE]\n\n");
  return Buffer.from(chunks.join(""));
}

function normalizedStructuredCalls(
  envelope: SseEnvelope,
  allowedNames: ReadonlySet<string>,
): { calls?: RecoveredToolCall[]; failure?: string } {
  if (envelope.toolCalls.size === 0) return {};
  const calls: RecoveredToolCall[] = [];
  for (const [index, call] of [...envelope.toolCalls.entries()].sort((left, right) => left[0] - right[0])) {
    const name = call.name?.trim();
    if (!name) return { failure: `structured tool call ${index} has no stable name` };
    if (!allowedNames.has(name)) return { failure: `structured response requested an undisclosed tool: ${name}` };
    let parsed: unknown;
    try { parsed = JSON.parse(call.arguments || "{}"); }
    catch (error) { return { failure: `structured tool call ${name} has invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: `structured tool call ${name} arguments must be a JSON object` };
    calls.push({ name, arguments: JSON.stringify(parsed), id: call.id ?? stableCallId(`${name}\n${call.arguments}`, index) });
  }
  return { calls };
}

function recoveredSse(
  body: Buffer,
  envelope: SseEnvelope,
  parsed: ParsedTextToolCalls,
  kind: ToolProtocolRecoveryKind,
): ToolProtocolTransformResult {
  if (parsed.failure) {
    return {
      body,
      contentType: "text/event-stream; charset=utf-8",
      changed: false,
      recoveryKinds: [],
      recoveredToolNames: [],
      failure: parsed.failure,
    };
  }
  return {
    body: synthesizedSse(envelope, parsed.calls, parsed.remainingText),
    contentType: "text/event-stream; charset=utf-8",
    changed: true,
    recoveryKinds: [kind],
    recoveredToolNames: parsed.calls.map((call) => call.name),
  };
}

function transformSse(
  body: Buffer,
  allowedNames: ReadonlySet<string>,
  requestBody: Record<string, unknown>,
): ToolProtocolTransformResult {
  const envelope = collectSse(body);
  if (envelope.toolCalls.size > 0) {
    const structured = normalizedStructuredCalls(envelope, allowedNames);
    if (structured.failure) {
      return { body, contentType: "text/event-stream; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [], failure: structured.failure };
    }
    const calls = structured.calls ?? [];
    if (!envelope.structuredNeedsNormalization) {
      return {
        body,
        contentType: "text/event-stream; charset=utf-8",
        changed: false,
        recoveryKinds: [],
        recoveredToolNames: [],
        nativeToolCallCount: calls.length,
        nativeToolNames: calls.map((call) => call.name),
      };
    }
    return {
      body: synthesizedSse(envelope, calls, envelope.content),
      contentType: "text/event-stream; charset=utf-8",
      changed: true,
      recoveryKinds: ["structured_tool_call_delta_normalized"],
      recoveredToolNames: calls.map((call) => call.name),
      nativeToolCallCount: calls.length,
      nativeToolNames: calls.map((call) => call.name),
    };
  }

  const dsml = parseDsmlToolCalls(envelope.content, allowedNames);
  if (dsml.markerFound) return recoveredSse(body, envelope, dsml, "dsml_content_to_tool_calls");

  const markdown = parseMarkdownShellToolCall(envelope.content, allowedNames, requestBody);
  if (markdown.markerFound) return recoveredSse(body, envelope, markdown, "markdown_shell_fence_to_tool_calls");

  const textual = parseTextualToolCallEnvelope(envelope.content, allowedNames, requestBody);
  if (textual.markerFound) return recoveredSse(body, envelope, textual, "text_tool_call_envelope_to_tool_calls");

  return { body, contentType: "text/event-stream; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [] };
}

function applyJsonCalls(
  choice: Record<string, unknown>,
  message: Record<string, unknown>,
  parsed: ParsedTextToolCalls,
  kind: ToolProtocolRecoveryKind,
  recoveredNames: string[],
  kinds: Set<ToolProtocolRecoveryKind>,
): string | undefined {
  if (parsed.failure) return parsed.failure;
  message.content = parsed.remainingText || null;
  message.tool_calls = parsed.calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
  choice.finish_reason = "tool_calls";
  recoveredNames.push(...parsed.calls.map((call) => call.name));
  kinds.add(kind);
  return undefined;
}

function transformJson(
  body: Buffer,
  allowedNames: ReadonlySet<string>,
  requestBody: Record<string, unknown>,
): ToolProtocolTransformResult {
  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body, contentType: "application/json; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [] };
    root = parsed as Record<string, unknown>;
  } catch {
    return { body, contentType: "application/json; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [] };
  }
  const choices = root.choices;
  if (!Array.isArray(choices)) return { body, contentType: "application/json; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [] };
  let changed = false;
  const kinds = new Set<ToolProtocolRecoveryKind>();
  const recoveredNames: string[] = [];
  const nativeNames: string[] = [];
  let nativeCount = 0;
  for (const rawChoice of choices) {
    if (!rawChoice || typeof rawChoice !== "object" || Array.isArray(rawChoice)) continue;
    const choice = rawChoice as Record<string, unknown>;
    const messageRaw = choice.message;
    if (!messageRaw || typeof messageRaw !== "object" || Array.isArray(messageRaw)) continue;
    const message = messageRaw as Record<string, unknown>;
    const existing = message.tool_calls;
    if (Array.isArray(existing) && existing.length > 0) {
      const envelope: SseEnvelope = { base: {}, reasoning: "", content: typeof message.content === "string" ? message.content : "", toolCalls: new Map(), structuredNeedsNormalization: false };
      existing.forEach((rawCall, index) => {
        if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) return;
        const call = rawCall as Record<string, unknown>;
        const fnRaw = call.function;
        const fn = fnRaw && typeof fnRaw === "object" && !Array.isArray(fnRaw) ? fnRaw as Record<string, unknown> : {};
        const stableId = nonEmpty(call.id);
        const stableName = nonEmpty(fn.name);
        if (stableId === undefined || stableName === undefined) envelope.structuredNeedsNormalization = true;
        envelope.toolCalls.set(index, {
          ...(stableId === undefined ? {} : { id: stableId }),
          ...(stableName === undefined ? {} : { name: stableName }),
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        });
      });
      const normalized = normalizedStructuredCalls(envelope, allowedNames);
      if (normalized.failure) return { body, contentType: "application/json; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [], failure: normalized.failure };
      const calls = normalized.calls ?? [];
      nativeCount += calls.length;
      nativeNames.push(...calls.map((call) => call.name));
      if (envelope.structuredNeedsNormalization) {
        message.tool_calls = calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
        choice.finish_reason = "tool_calls";
        recoveredNames.push(...calls.map((call) => call.name));
        kinds.add("structured_tool_call_delta_normalized");
        changed = true;
      }
      continue;
    }
    if (typeof message.content !== "string") continue;

    const candidates: Array<[ParsedTextToolCalls, ToolProtocolRecoveryKind]> = [
      [parseDsmlToolCalls(message.content, allowedNames), "dsml_content_to_tool_calls"],
      [parseMarkdownShellToolCall(message.content, allowedNames, requestBody), "markdown_shell_fence_to_tool_calls"],
      [parseTextualToolCallEnvelope(message.content, allowedNames, requestBody), "text_tool_call_envelope_to_tool_calls"],
    ];
    const selected = candidates.find(([candidate]) => candidate.markerFound);
    if (!selected) continue;
    const failure = applyJsonCalls(choice, message, selected[0], selected[1], recoveredNames, kinds);
    if (failure) return { body, contentType: "application/json; charset=utf-8", changed: false, recoveryKinds: [], recoveredToolNames: [], failure };
    changed = true;
  }
  return {
    body: changed ? Buffer.from(JSON.stringify(root)) : body,
    contentType: "application/json; charset=utf-8",
    changed,
    recoveryKinds: [...kinds],
    recoveredToolNames: recoveredNames,
    ...(nativeCount > 0 ? { nativeToolCallCount: nativeCount, nativeToolNames: [...new Set(nativeNames)] } : {}),
  };
}

export function transformProviderToolCalls(
  contentType: string,
  body: Buffer,
  requestBody: Record<string, unknown>,
): ToolProtocolTransformResult {
  const allowedNames = allowedToolNamesFromRequest(requestBody);
  if (allowedNames.size === 0) return { body, contentType, changed: false, recoveryKinds: [], recoveredToolNames: [] };
  if (contentType.includes("text/event-stream") || body.toString("utf8", 0, Math.min(body.length, 64)).startsWith("data:")) {
    return transformSse(body, allowedNames, requestBody);
  }
  if (contentType.includes("json")) return transformJson(body, allowedNames, requestBody);
  const text = body.toString("utf8");
  if (ANY_DSML_RE.test(text)) {
    return { body, contentType, changed: false, recoveryKinds: [], recoveredToolNames: [], failure: "provider returned DSML tool markup in an unsupported response media type" };
  }
  if (isMutatingBoundedLeafRequest(requestBody) && SHELL_FENCE_MARKER_RE.test(text)) {
    return { body, contentType, changed: false, recoveryKinds: [], recoveredToolNames: [], failure: "provider returned executable shell Markdown in an unsupported response media type" };
  }
  const textual = parseTextualToolCallEnvelope(text, allowedNames, requestBody);
  if (textual.markerFound) {
    return { body, contentType, changed: false, recoveryKinds: [], recoveredToolNames: [], failure: textual.failure ?? "provider returned textual tool-call markup in an unsupported response media type" };
  }
  return { body, contentType, changed: false, recoveryKinds: [], recoveredToolNames: [] };
}
