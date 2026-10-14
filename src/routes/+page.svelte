<script lang="ts">
	import { onDestroy } from 'svelte';
	// Individual icons only. `sideEffects: false` means nothing else from the
	// collection reaches the bundle.
	// Note: CheckCircle / AlertCircle were renamed in Lucide v1.
	import {
		CircleAlert,
		CircleCheck,
		Code,
		Download,
		FileText,
		FileUp,
		LoaderCircle,
		RotateCcw
	} from '@lucide/svelte';
	import { engine, type ProgressStage } from '#lib/qpdf/client';
	import { MODE_ATTEMPTS, type QualityMode } from '#lib/qpdf/pipeline';
	import { formatBytes, formatDelta, formatPercent, outputName } from '#lib/format';
	import type { InspectResult, ProcessResult } from '#lib/qpdf/protocol';

	const MAX_BYTES = 200 * 1024 * 1024; // 200 MB
	const ACCEPT = 'application/pdf,.pdf';

	const author = 'mrflamingchad67';
	const repoUrl = 'https://github.com/mrflamingchad67/qcompress';
	const year = new Date().getFullYear();

	type Phase = 'empty' | 'ready' | 'working' | 'done';

	/** What each mode actually does, shown verbatim under the selector. */
	const MODE_NOTES: Record<QualityMode, string> = {
		lossless:
			'Restructures the file and removes duplicated streams. Images and text are left exactly as they are — nothing is re-encoded, so nothing can degrade.',
		balanced:
			'Lossless work first, then re-encodes JPEG photos at a high quality. Text stays sharp; photographic detail is slightly reduced.',
		maximum:
			'Lossless work first, then re-encodes images harder and reduces oversized scans. Smallest file, clearly the most visible quality loss.'
	};

	const MODES: { id: QualityMode; label: string }[] = [
		{ id: 'lossless', label: 'Lossless' },
		{ id: 'balanced', label: 'Balanced' },
		{ id: 'maximum', label: 'Maximum' }
	];

	let phase = $state<Phase>('empty');
	let file = $state<File | null>(null);
	let mode = $state<QualityMode>('balanced');
	let info = $state<InspectResult | null>(null);
	let password = $state('');
	let stage = $state<ProgressStage>('idle');
	let detail = $state<string>('');
	let error = $state<string | null>(null);
	let dragging = $state(false);

	let result = $state<ProcessResult | null>(null);
	let downloadUrl = $state<string | null>(null);
	let downloadName = $state('');
	let inSize = $state(0);
	let outSize = $state(0);

	let fileInput: HTMLInputElement | undefined = $state();

	const busy = $derived(phase === 'working');
	const showPassword = $derived(!!info?.needsPassword);
	const saved = $derived(inSize - outSize);
	const reduced = $derived(outSize < inSize);
	const unchanged = $derived(outSize === inSize);

	/** True when the file cannot be shrunk and was returned untouched. */
	const noGain = $derived(!!result?.fallback);
	const lossy = $derived(!!result?.lossy);

	const statusLine = $derived(
		stage === 'loading'
			? 'Loading QPDF engine…'
			: stage === 'inspecting'
				? 'Reading document…'
				: stage === 'compressing'
					? detail || 'Compressing…'
					: ''
	);

	function resetAll() {
		engine.reset();
		phase = 'empty';
		file = null;
		info = null;
		error = null;
		password = '';
		stage = 'idle';
		detail = '';
		result = null;
		downloadUrl = null;
		downloadName = '';
		inSize = 0;
		outSize = 0;
		if (fileInput) fileInput.value = '';
	}

	function validate(f: File): string | null {
		if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return 'That file is not a PDF.';
		if (f.size === 0) return 'That file is empty.';
		if (f.size > MAX_BYTES) {
			return `That file is ${formatBytes(f.size)}. The limit is ${formatBytes(MAX_BYTES)}.`;
		}
		return null;
	}

	async function acceptFile(f: File) {
		error = null;
		const problem = validate(f);
		if (problem) {
			error = problem;
			return;
		}

		file = f;
		info = null;
		password = '';
		phase = 'ready';

		try {
			const result = await engine.inspect(f, (s) => (stage = s));
			info = result;
			if (!result.readable && !result.needsPassword) {
				error =
					result.detail ??
					'QPDF could not open this file. It may be damaged or use an unsupported format.';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (busy) return;
		const f = e.dataTransfer?.files?.[0];
		if (f) void acceptFile(f);
	}

	async function compress() {
		if (!file || busy) return;
		error = null;
		result = null;
		phase = 'working';
		try {
			const res = await engine.process(mode, password, (s) => {
				stage = s;
				if (s === 'compressing') detail = '';
			});

			if (!res.ok || !res.bytes) {
				error = describeFailure(res.invalidPassword, res.detail);
				phase = 'ready';
				return;
			}

			const blob = new Blob([res.bytes], { type: 'application/pdf' });
			const url = URL.createObjectURL(blob);
			engine.adoptResultUrl(url);

			result = res;
			downloadUrl = url;
			downloadName = outputName(file.name);
			inSize = file.size;
			outSize = res.size;
			phase = 'done';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			phase = 'ready';
		}
	}

	function describeFailure(invalidPassword: boolean, detail: string | null): string {
		if (invalidPassword) return 'That password is not correct.';
		if (detail) return `QPDF could not process this file: ${detail}`;
		return 'QPDF could not process this file. It may be damaged or too large for this device.';
	}

	function downloadOriginal() {
		const blob = engine.getOriginal();
		if (!blob || !file) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = file.name;
		a.click();
		URL.revokeObjectURL(url);
	}

	function setMode(next: QualityMode) {
		mode = next;
	}

	/** Turn an internal strategy name into something worth reading. */
	function strategyLabel(strategy: string): string {
		const s = strategy.toLowerCase();
		if (s.includes('dedupe')) return 'duplicate streams removed';
		if (s.includes('image')) return 'images re-encoded and duplicates removed';
		if (s.includes('linearize')) return 'restructured for web viewing';
		if (s.includes('structural')) return 'structure optimised';
		return strategy;
	}

	onDestroy(() => engine.destroy());
</script>

<svelte:head>
	<title>PDF Compressor</title>
</svelte:head>

<!-- data-stage exposes the worker state machine for debugging and e2e tests. -->
<main class="panel" class:empty={phase === 'empty'} data-stage={stage}>
	<h1 class="wordmark">
		<span class="mark" aria-hidden="true">
			<svg viewBox="0 0 32 32" width="18" height="18">
				<rect width="32" height="32" rx="7" fill="var(--primary)" />
				<path d="M9 8h8l6 6v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="#fff" />
				<path d="M17 8v6h6z" fill="rgba(0,0,0,.18)" />
			</svg>
		</span>
		PDF Compressor
	</h1>

	<!-- ── file selection ──────────────────────────────────────────────── -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<div
		class="drop"
		class:dragging
		role="button"
		tabindex={busy ? -1 : 0}
		aria-disabled={busy}
		aria-label={file ? `Replace file. Currently ${file.name}` : 'Select or drop a PDF file'}
		onclick={() => !busy && fileInput?.click()}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				if (!busy) fileInput?.click();
			}
		}}
		ondragover={(e) => {
			e.preventDefault();
			if (!busy) dragging = true;
		}}
		ondragleave={(e) => {
			if (e.currentTarget === e.target) dragging = false;
		}}
		ondrop={onDrop}
	>
		<input
			bind:this={fileInput}
			type="file"
			accept={ACCEPT}
			class="visually-hidden"
			onchange={(e) => {
				const f = e.currentTarget.files?.[0];
				if (f) void acceptFile(f);
			}}
		/>

		{#if file}
			<div class="file-row">
				<FileText size={18} strokeWidth={1.8} aria-hidden="true" />
				<div class="file-info">
					<span class="file-name" title={file.name}>{file.name}</span>
					<span class="file-meta">
						{formatBytes(file.size)}{#if info?.pageCount}&nbsp;·&nbsp;{info.pageCount}
							{info.pageCount === 1 ? 'page' : 'pages'}{/if}{#if info?.pdfVersion}&nbsp;·&nbsp;PDF
							{info.pdfVersion}{/if}{#if info?.encrypted}&nbsp;·&nbsp;encrypted{/if}
					</span>
				</div>
			</div>
		{:else}
			<span class="upload-badge" aria-hidden="true">
				<FileUp size={22} strokeWidth={1.8} />
			</span>
			<strong class="drop-title">Click to select a file</strong>
			<span class="drop-hint">or drag and drop</span>
		{/if}
	</div>

	{#if phase === 'empty'}
		<p class="start-note">Compressed in your browser. Nothing is uploaded.</p>
	{/if}

	<!-- ── primary action ──────────────────────────────────────────────── -->
	{#if file && phase !== 'done'}
		<button type="button" class="primary" class:busy onclick={compress} disabled={busy || !file}>
			{#if busy}
				<LoaderCircle size={16} strokeWidth={2} aria-hidden="true" />
				Compressing…
			{:else}
				Compress PDF
			{/if}
		</button>
	{/if}

	{#if showPassword}
		<div class="field wide">
			<label for="password">Document password</label>
			<input
				id="password"
				type="password"
				bind:value={password}
				autocomplete="off"
				spellcheck="false"
				placeholder="Required to open this PDF"
			/>
		</div>
	{/if}

	<!-- ── options ─────────────────────────────────────────────────────── -->
	{#if file && phase !== 'done'}
		<fieldset class="options" disabled={busy}>
			<legend class="visually-hidden">Compression settings</legend>

			<p class="section-label">Mode</p>

			<div class="chips" role="radiogroup" aria-label="Processing mode">
				{#each MODES as m (m.id)}
					<label class="chip">
						<input
							type="radio"
							name="mode"
							value={m.id}
							checked={mode === m.id}
							onchange={() => setMode(m.id)}
						/>
						<span>{m.label}</span>
					</label>
				{/each}
			</div>

			<p class="hint">{MODE_NOTES[mode]}</p>

			{#if mode === 'lossless'}
				<p class="hint mode-tag">Nothing is ever degraded in this mode.</p>
			{:else if MODE_ATTEMPTS[mode].length > 1}
				<p class="hint mode-tag">
					Both a stronger and a lighter setting are tried; whichever produces the smaller
					valid file is kept.
				</p>
			{:else}
				<p class="hint mode-tag">Images are re-encoded — quality is traded for size.</p>
			{/if}
		</fieldset>
	{/if}

	{#if busy}
		<div class="progress" role="status" aria-live="polite">
			<div class="bar"><span></span></div>
			<p>{statusLine || 'Working…'}</p>
		</div>
	{/if}

	{#if error}
		<div class="error" role="alert">
			<p>
				<CircleAlert size={14} strokeWidth={2} aria-hidden="true" />
				<span>{error}</span>
			</p>
			<div class="error-actions">
				{#if file}
					<button type="button" class="link" onclick={compress} disabled={busy}>Retry</button>
				{/if}
				<button type="button" class="link" onclick={resetAll}>Choose another file</button>
				{#if file}
					<button type="button" class="link" onclick={downloadOriginal}>Download original</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- ── result ──────────────────────────────────────────────────────── -->
	{#if phase === 'done'}
		<div class="result">
			<div class="out-row">
				<CircleCheck size={18} strokeWidth={1.8} aria-hidden="true" />
				<div class="file-info">
					<span class="file-name" title={downloadName}>{downloadName}</span>
					<span class="file-meta">{formatBytes(outSize)}</span>
				</div>
			</div>

			{#if reduced}
				<p class="verdict good">
					<CircleCheck size={15} strokeWidth={2} aria-hidden="true" />
					Saved {formatBytes(saved)} ({formatPercent((saved / inSize) * 100)} smaller)
				</p>
			{:else if unchanged}
				<p class="verdict warn">
					<CircleAlert size={15} strokeWidth={2} aria-hidden="true" />
					No size reduction achieved
				</p>
			{:else}
				<p class="verdict warn">
					<CircleAlert size={15} strokeWidth={2} aria-hidden="true" />
					No size reduction achieved — the output is {formatDelta(-saved)}
					({formatPercent(((outSize - inSize) / inSize) * 100)} larger)
				</p>
			{/if}

			<!-- What the engine actually did, not what was asked for. -->
			{#if result}
				<ul class="report">
					<li>
						<span class="report-key">Mode</span>
						<span class="report-val">{MODES.find((m) => m.id === mode)?.label}</span>
					</li>
					<li>
						<span class="report-key">Images</span>
						<span class="report-val">
							{#if lossy && result.imagesReplaced > 0}
								{result.imagesReplaced} of {result.imagesProcessed} re-encoded (lossy)
							{:else}
								unchanged as-is
							{/if}
						</span>
					</li>
					<li>
						<span class="report-key">Method</span>
						<span class="report-val">
							{noGain ? 'no strategy improved this file — original returned' : strategyLabel(result.strategy)}
						</span>
					</li>
				</ul>
				<p class="hint">
					Rewriting a PDF invalidates any digital signature it carried.
				</p>
			{/if}

			<dl class="sizes">
				<div>
					<dt>Original</dt>
					<dd>{formatBytes(inSize)}</dd>
				</div>
				<div>
					<dt>Processed</dt>
					<dd>{formatBytes(outSize)}</dd>
				</div>
				<div>
					<dt>Change</dt>
					<dd class:saved={reduced} class:grew={!reduced && !unchanged}>
						{reduced ? '-' : '+'}{formatBytes(Math.abs(saved))}
					</dd>
				</div>
			</dl>

			<div class="result-actions">
				{#if downloadUrl}
					<a class="primary as-button" href={downloadUrl} download={downloadName}>
						<Download size={16} strokeWidth={2} aria-hidden="true" />
						Download PDF
					</a>
				{/if}
				<button type="button" class="secondary" onclick={resetAll}>
					<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
					Compress another
				</button>
			</div>
		</div>
	{/if}
</main>

<!-- ── meta bar ──────────────────────────────────────────────────────── -->
<!-- The selected file is shown in the drop card itself; there is no separate
     file tray. -->
<footer class="footer">
	<div class="meta">
		<span>&copy; {year}, {author}</span>
		<a class="source" href={repoUrl} target="_blank" rel="noopener noreferrer">
			<Code size={12} strokeWidth={2} aria-hidden="true" />
			Source
		</a>
	</div>
</footer>

<style>
	/* ── shell ───────────────────────────────────────────────────────── */
	/* Only the meta bar is fixed to the bottom, so exactly its height is
	   reserved. There is no file tray. */
	.panel {
		min-height: calc(100vh - 33px);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 1.5rem 0.75rem 5rem;
	}

	/* Empty state mirrors the reference: wordmark + one dashed card, centred. */
	.panel.empty {
		align-items: center;
		justify-content: center;
		gap: 1.125rem;
		padding-bottom: 6rem;
	}

	.wordmark {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.panel.empty .wordmark {
		font-size: 1rem;
	}

	.mark {
		display: flex;
	}

	/* ── file selection ──────────────────────────────────────────────── */
	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		width: 100%;
		max-width: 26rem;
		min-height: 12rem;
		padding: 1.5rem 1rem;
		background: var(--bg-card);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		text-align: center;
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.drop:hover,
	.drop.dragging {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.upload-badge {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		margin-bottom: 0.25rem;
		background: var(--bg-alt);
		border-radius: 999px;
		color: var(--primary);
	}

	.drop-title {
		color: var(--primary);
		font-weight: 600;
	}

	.drop-hint {
		color: var(--text-tertiary);
		font-size: 0.8125rem;
	}

	.start-note {
		margin: 0;
		color: var(--text-tertiary);
		font-size: 0.8125rem;
	}

	/* Once a file is chosen the same element collapses to a file row. */
	.panel:not(.empty) .drop {
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		gap: 0.5rem;
		min-height: 0;
		max-width: 26rem;
		margin: 0 auto;
		padding: 0.5rem 0.75rem;
		border-style: solid;
		text-align: left;
	}

	.file-row,
	.out-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.file-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.file-name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-meta {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.drop :global(svg),
	.out-row :global(svg) {
		flex: none;
		color: var(--primary);
	}

	.out-row :global(svg) {
		color: var(--success);
	}

	/* ── buttons ─────────────────────────────────────────────────────── */
	.primary {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4375rem;
		align-self: center;
		min-width: 15rem;
		margin: 0.25rem auto 0;
		padding: 0.5rem 1.25rem;
		background: var(--primary);
		border: 1px solid var(--primary);
		border-radius: var(--radius-sm);
		color: var(--text-on-primary);
		font-weight: 600;
		text-decoration: none;
	}

	.primary:hover:not(:disabled) {
		background: var(--primary-hover);
		border-color: var(--primary-hover);
	}

	.primary:disabled {
		opacity: 0.5;
	}

	.secondary {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		background: var(--bg-card);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: inherit;
	}

	.secondary:hover {
		background: var(--bg-alt);
	}

	.link {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0;
		background: none;
		border: 0;
		color: var(--primary);
		font-size: 0.8125rem;
		text-decoration: underline;
	}

	.link:hover:not(:disabled) {
		color: var(--primary-hover);
	}

	.link:disabled {
		opacity: 0.5;
	}

	/* ── options ─────────────────────────────────────────────────────── */
	.options {
		margin: 0.75rem 0 0;
		padding: 0;
		border: 0;
	}

	.section-label {
		margin: 0 0 0.5rem;
		color: var(--text-tertiary);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-bottom: 0.5rem;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.25rem 0.5625rem;
		background: var(--bg-card);
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.chip:hover {
		background: var(--bg-alt-hover);
	}

	.chip:has(input:checked) {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary);
		font-weight: 500;
	}

	.hint {
		margin: 0.75rem 0 0;
		color: var(--text-tertiary);
		font-size: 0.75rem;
	}

	.hint.mode-tag {
		margin-top: 0.25rem;
		color: var(--text-secondary);
	}

	/* Honest summary of what the engine actually did. */
	.report {
		display: grid;
		gap: 0.25rem;
		margin: 0.25rem 0 0;
		padding: 0.625rem 0.75rem;
		background: var(--bg-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		list-style: none;
		font-size: 0.75rem;
	}

	.report li {
		display: flex;
		gap: 0.5rem;
		justify-content: space-between;
	}

	.report-key {
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.report-val {
		color: var(--text-primary);
		text-align: right;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
		max-width: 26rem;
		align-self: center;
	}

	.field label {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.field input {
		padding: 0.4375rem 0.5625rem;
		background: var(--bg-input);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
	}

	/* ── progress ────────────────────────────────────────────────────── */
	.progress {
		width: 100%;
		max-width: 26rem;
		align-self: center;
	}

	.progress p {
		margin: 0.375rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.bar {
		height: 3px;
		overflow: hidden;
		background: var(--border);
		border-radius: 2px;
	}

	/* Indeterminate: qpdf reports no incremental progress, so none is faked. */
	.bar span {
		display: block;
		width: 35%;
		height: 100%;
		background: var(--primary);
		animation: slide 1.1s ease-in-out infinite;
	}

	@keyframes slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(340%);
		}
	}

	.primary.busy :global(svg) {
		animation: spin 900ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar span {
			animation: none;
			width: 100%;
			opacity: 0.5;
		}

		.primary.busy :global(svg) {
			animation-duration: 2.4s;
		}
	}

	/* ── error ───────────────────────────────────────────────────────── */
	.error {
		width: 100%;
		max-width: 34rem;
		align-self: center;
		padding: 0.625rem 0.75rem;
		background: var(--danger-soft);
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
	}

	.error p {
		display: flex;
		align-items: flex-start;
		gap: 0.4375rem;
		margin: 0;
		color: var(--danger);
		font-size: 0.8125rem;
	}

	.error p :global(svg) {
		flex: none;
		margin-top: 0.1875rem;
	}

	.error p span {
		overflow-wrap: anywhere;
	}

	.error-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.875rem;
		margin-top: 0.5rem;
	}

	/* ── result ──────────────────────────────────────────────────────── */
	.result {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		width: 100%;
		max-width: 34rem;
		align-self: center;
	}

	.verdict {
		display: flex;
		align-items: center;
		gap: 0.4375rem;
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.verdict :global(svg) {
		flex: none;
	}

	.verdict.good {
		color: var(--success);
	}

	.verdict.warn {
		color: var(--warning);
	}

	.sizes {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin: 0;
		padding: 0.625rem 0.75rem;
		background: var(--bg-alt);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.sizes dt {
		color: var(--text-secondary);
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.sizes dd {
		margin: 0.125rem 0 0;
		font-size: 1rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.sizes dd.saved {
		color: var(--success);
	}

	.sizes dd.grew {
		color: var(--warning);
	}

	.result-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.result-actions .primary {
		width: 100%;
		min-width: 0;
	}

	/* ── footer: meta bar ────────────────────────────────────────────── */
	.footer {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 10;
	}

	.meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		background: var(--bg-tray);
		border-top: 1px solid var(--border);
		color: var(--text-tertiary);
		font-size: 0.75rem;
	}

	.source {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		color: var(--text-secondary);
		text-decoration: none;
	}

	.source:hover {
		color: var(--primary);
		text-decoration: underline;
	}

	.source :global(svg) {
		flex: none;
	}

	/* ── responsive ──────────────────────────────────────────────────── */
	@media (max-width: 40rem) {
		.panel {
			padding: 1rem 0.75rem 5.5rem;
		}

		.drop {
			min-height: 10rem;
		}

		.sizes {
			grid-template-columns: minmax(0, 1fr);
			gap: 0.375rem;
		}
	}
</style>