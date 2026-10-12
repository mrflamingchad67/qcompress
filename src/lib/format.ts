export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	// One decimal below 10, none above: keeps the column narrow and comparable.
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Signed, human-readable byte delta: "-1.2 MB" / "+340 B". */
export function formatDelta(delta: number): string {
	const sign = delta < 0 ? '-' : '+';
	return `${sign}${formatBytes(Math.abs(delta))}`;
}

export function formatPercent(pct: number): string {
	return `${Math.abs(pct) < 0.1 ? '0.0' : pct.toFixed(1)}%`;
}

/** Output filename: <original>-compressed.pdf */
export function outputName(original: string): string {
	const base = original.replace(/\.pdf$/i, '') || 'document';
	return `${base}-compressed.pdf`;
}