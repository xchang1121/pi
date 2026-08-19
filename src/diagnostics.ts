import type { ActionKey } from "./action-semantics.ts";

export function diagnosticAction(tool: string, input: unknown, key?: ActionKey): string {
	return diagnosticJson({ tool, input: key?.input ?? input, ...(key ? { actionKeyHash: key.hash } : {}) });
}

export function diagnosticJson(value: unknown): string {
	try {
		return JSON.stringify(redactDiagnostics(value));
	} catch {
		return "[unserializable]";
	}
}

export function redactDiagnostics(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactDiagnostics);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			/(token|secret|password|authorization|cookie|api.?key)/i.test(key) ? "[redacted]" : redactDiagnostics(item),
		]),
	);
}
