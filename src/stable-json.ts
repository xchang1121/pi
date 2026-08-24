/** JSON.stringify with recursively stable object keys and no intermediate object tree. */
export function stableStringify(value: unknown): string {
	return serialize(value) as string;
}

function serialize(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		const items: string[] = [];
		for (let index = 0; index < value.length; index++) items.push(serialize(value[index]) ?? "null");
		return `[${items.join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const integerKeys: string[] = [];
	const namedKeys: string[] = [];
	for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
		(isArrayIndex(key) ? integerKeys : namedKeys).push(key);
	}
	integerKeys.sort((left, right) => Number(left) - Number(right));
	const entries: string[] = [];
	for (const key of [...integerKeys, ...namedKeys]) {
		const item = serialize(record[key]);
		if (item !== undefined) entries.push(`${JSON.stringify(key)}:${item}`);
	}
	return `{${entries.join(",")}}`;
}

function isArrayIndex(value: string) {
	const index = Number(value);
	return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && String(index) === value;
}
