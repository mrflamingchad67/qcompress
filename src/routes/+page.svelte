<script lang="ts">
	import { onDestroy } from 'svelte';
	// Individual icons only. `sideEffects: false` means nothing else from the
	// collection reaches the bundle.
	// Note: CheckCircle / AlertCircle were renamed in Lucide v1.
	import {
		CircleAlert,
		CircleCheck,
		Download,
		FileText,
		FileUp,
		LoaderCircle,
		RotateCcw,
		X
	} from '@lucide/svelte';
	import { engine, type ProgressStage } from '#lib/qpdf/client';
	import { DEFAULT_OPTIONS, type CompressOptions, type Mode } from '#lib/qpdf/options';
	import { formatBytes, formatDelta, formatPercent, outputName } from '#lib/format';
	import type { InspectResult } from '#lib/qpdf/protocol';

	const MAX_BYTES = 200 * 1024 * 1024; // 200 MB
	const ACCEPT = 'application/pdf,.pdf';

	type Phase = 'empty' | 'ready' | 'working' | 'done';

	let phase = $state<Phase>('empty');
	let file = $state<File | null>(null);
	let options = $state<CompressOptions>({ ...DEFAULT_OPTIONS });
	let info = $state<InspectResult | null>(null);
	let password = $state('');
	let stage = $state<ProgressStage>('idle');
	let error = $state<string | null>(null);
	let dragging = $state(false);

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
	const statusLine = $derived(
		stage === 'loading'
			? 'Loading QPDF engine…'
			: stage === 'inspecting'
				? 'Reading document…'
				: stage === 'compressing'
					? 'Compressing…'
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
		phase = 'working';
		try {
			const result = await engine.process(options, password, (s) => (stage = s));

			if (!result.ok || !result.bytes) {
				error = describeFailure(result.invalidPassword, result.detail);
				phase = 'ready';
				return;
			}

			const blob = new Blob([result.bytes], { type: 'application/pdf' });
			const url = URL.createObjectURL(blob);
			engine.adoptResultUrl(url);

			downloadUrl = url;
			downloadName = outputName(file.name);
			inSize = file.size;
			outSize = result.size;
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

	function setMode(mode: Mode) {
		options = { ...options, mode };
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

			<p class="section-label">Settings</p>

			<div class="chips" role="radiogroup" aria-label="Processing mode">
				<label class="chip">
					<input
						type="radio"
						name="mode"
						value="compress"
						checked={options.mode === 'compress'}
						onchange={() => setMode('compress')}
					/>
					<span>Compress</span>
				</label>
				<label class="chip">
					<input
						type="radio"
						name="mode"
						value="linearize"
						checked={options.mode === 'linearize'}
						onchange={() => setMode('linearize')}
					/>
					<span>Web optimize</span>
				</label>
			</div>

			{#if options.mode === 'compress'}
				<div class="grid">
					<label class="opt">
						<span class="opt-label">Object streams</span>
						<select bind:value={options.objectStreams}>
							<option value="generate">Generate</option>
							<option value="preserve">Preserve</option>
							<option value="disable">Disable</option>
						</select>
					</label>

					<label class="opt">
						<span class="opt-label">Compression level</span>
						<select bind:value={options.compressionLevel}>
							{#each [9, 6, 3, 1, 0] as level (level)}
								<option value={level}>{level === 0 ? '0 (none)' : level}</option>
							{/each}
						</select>
					</label>

					<label class="opt">
						<span class="opt-label">Stream data</span>
						<select bind:value={options.streamData}>
							<option value="compress">Compress</option>
							<option value="preserve">Preserve</option>
							<option value="uncompress">Uncompress</option>
						</select>
					</label>

					<label class="opt">
						<span class="opt-label">Decode level</span>
						<select bind:value={options.decodeLevel}>
							<option value="generalized">Generalized</option>
							<option value="all">All</option>
							<option value="specialized">Specialized</option>
							<option value="none">None</option>
						</select>
					</label>

					<label class="opt check">
						<input type="checkbox" bind:checked={options.recompressFlate} />
						<span class="opt-label">Recompress Flate streams</span>
					</label>
				</div>

				<p class="hint">
					Structural compression only. Images and text are never rasterised, downsampled or
					re-encoded.
				</p>
			{:else}
				<p class="hint">
					Restructures the file for fast web viewing. This usually makes the file slightly
					larger.
				</p>
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

<!-- ── file tray ───────────────────────────────────────────────────────── -->
<footer class="tray">
	{#if file}
		<div class="chip-file">
			<FileText size={14} strokeWidth={2} aria-hidden="true" />
			<span class="chip-name" title={file.name}>{file.name}</span>
			<span class="chip-size">{formatBytes(file.size)}</span>
			<button
				type="button"
				class="link file-row"
				onclick={resetAll}
				disabled={busy}
				aria-label="Remove file"
			>
				<X size={13} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
	{:else}
		<p class="tray-empty">No file selected</p>
	{/if}
</footer>

<style>
	/* ── shell ───────────────────────────────────────────────────────── */
	.panel {
		min-height: calc(100vh - 49px);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 1.5rem 0.75rem 3.5rem;
	}

	/* Empty state mirrors the reference: wordmark + one dashed card, centred. */
	.panel.empty {
		align-items: center;
		justify-content: center;
		gap: 1.125rem;
		padding-bottom: 4rem;
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

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
		gap: 0.375rem;
	}

	.opt {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.25rem;
		min-height: 3.25rem;
		padding: 0.5rem 0.625rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.opt:hover {
		background: var(--bg-alt-hover);
		border-color: var(--border-strong);
	}

	.opt-label {
		color: var(--text-secondary);
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.opt select {
		padding: 0.25rem 0.375rem;
		background: var(--bg-input);
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		font-size: 0.8125rem;
	}

	.opt.check {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	.opt.check .opt-label {
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.8125rem;
		color: var(--text-primary);
	}

	.hint {
		margin: 0.75rem 0 0;
		color: var(--text-tertiary);
		font-size: 0.75rem;
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

	/* ── tray ────────────────────────────────────────────────────────── */
	.tray {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 49px;
		padding: 0.5rem 0.75rem;
		background: var(--bg-tray);
		border-top: 1px solid var(--border);
	}

	.tray-empty {
		margin: 0;
		color: var(--text-tertiary);
		font-size: 0.8125rem;
	}

	.chip-file {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 20rem;
		padding: 0.25rem 0.4375rem 0.25rem 0.625rem;
		background: var(--bg-card);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		color: var(--primary);
	}

	.chip-file :global(svg) {
		flex: none;
	}

	.chip-name {
		min-width: 0;
		overflow: hidden;
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-size {
		color: var(--text-tertiary);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	/* ── responsive ──────────────────────────────────────────────────── */
	@media (max-width: 40rem) {
		.panel {
			padding: 1rem 0.75rem 4rem;
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