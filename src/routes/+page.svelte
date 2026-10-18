<script lang="ts">
	import { onDestroy } from 'svelte';
	// Individual icons only. `sideEffects: false` means nothing else from the
	// collection reaches the bundle.
	// Note: CheckCircle / AlertCircle were renamed in Lucide v1.
	import {
		CircleAlert,
		CircleCheck,
		CircleHelp,
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

	let errorEl: HTMLDivElement | undefined = $state();

	/**
	 * What completion says out loud.
	 *
	 * The progress panel is a live region, but it sits inside `{#if busy}`, so
	 * the moment compression ends the region is destroyed - taking with it the
	 * text a screen reader was part-way through. Nothing else was speaking, so
	 * the whole operation ended silently: nothing ever said the work was
	 * finished. The browser suite proved it, 0 announcements across a complete
	 * run. This is a separate, permanently mounted region so that finishing is
	 * itself an event.
	 */
	const announcement = $derived.by(() => {
		if (phase !== 'done') return '';
		const name = downloadName;
		const size = formatBytes(outSize);
		if (reduced) return `Done. ${name}, ${size}, ${formatPercent((saved / inSize) * 100)} smaller than the original.`;
		if (unchanged) return `Done. ${name}, ${size}. No size reduction was achieved.`;
		return `Done. ${name}, ${size}, ${formatPercent(((outSize - inSize) / inSize) * 100)} larger than the original.`;
	});

	/**
	 * Land the keyboard on the failure.
	 *
	 * `role="alert"` makes a screen reader speak the error, but it does nothing
	 * for a sighted keyboard user: focus stayed wherever it was, which the
	 * suite measured as `activeElement BODY` - the document, not the message.
	 * The alert is given `tabindex="-1"` so it can receive focus without
	 * joining the Tab order, and is focused once as it appears.
	 */
	$effect(() => {
		if (error && errorEl) errorEl.focus();
	});
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

	/* ── help ─────────────────────────────────────────────────────────── */
	let helpEl: HTMLDialogElement | undefined = $state();

	function openHelp() {
		helpEl?.showModal();
	}

	function closeHelp() {
		helpEl?.close();
	}

	/* A click on a modal <dialog> lands on the dialog element itself when it
	   lands on the backdrop. Clicks inside the content do not bubble up to it,
	   so this closes only on an outside click and not on every click. */
	function onHelpBackdrop(ev: MouseEvent) {
		if (ev.target === helpEl) closeHelp();
	}

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

	/**
	 * What to show when QPDF could not open the file.
	 *
	 * The engine's own words are worth keeping - they say WHY, which a generic
	 * apology does not - but they were shown raw and alone, and qpdf reports them
	 * against its own scratch name. A real user saw:
	 *
	 *     WARNING: in_mvdnjgjz_0.pdf: can't find PDF header
	 *
	 * `in_mvdnjgjz_0.pdf` is a file inside the WASM filesystem that the user has
	 * never heard of, presented as though it were theirs. So: lead with a plain
	 * sentence, then give the reason, with the scratch name replaced by the name
	 * of the file actually chosen.
	 *
	 * Both halves are deliberate. Dropping the diagnostic would hide the most
	 * useful thing the engine says; showing it unedited points at the wrong file.
	 */
	function describeUnreadable(detail: string | null | undefined, realName: string): string {
		const lead = 'This file could not be opened. It may be damaged, or use a format QPDF cannot read.';
		if (!detail) return lead;

		// qpdf's scratch names are `in_<random>_0.pdf`; \w covers the underscore,
		// which [a-z0-9] does not. Anything not matched is left alone.
		const reason = String(detail).replace(/\bin_\w+\.pdf\b/gi, realName).trim();
		return reason ? `${lead} The engine said: ${reason}` : lead;
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
				error = describeUnreadable(result.detail, f.name);
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
	<title>QCompress</title>
</svelte:head>

<!-- data-stage exposes the worker state machine for debugging and e2e tests. -->
<main class="panel" class:empty={phase === 'empty'} data-stage={stage}>
	<!--
		The reference nests an .upload-card inside .upload-page. Making .panel
		itself the card was tried and is wrong: .panel carries min-height:100dvh
		so the footer never overlaps content, so the card stretches to the full
		viewport with the dropzone stranded at the top. The wrapper is what makes
		the card hug its content, so the wrapper is restored here rather than
		patched over with min-height:0.
	-->
	<div class="card">
	<h1 class="wordmark">
		<span class="mark" aria-hidden="true">
			<svg viewBox="0 0 32 32" width="36" height="36">
				<rect width="32" height="32" rx="7" fill="var(--primary)" />
				<path d="M9 8h8l6 6v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="#fff" />
				<path d="M17 8v6h6z" fill="rgba(0,0,0,.18)" />
			</svg>
		</span>
		QCompress
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
		<!-- .upload-card-actions in the reference: a centred row under the
		     dropzone. Its content there is the same Help button. -->
		<div class="card-actions">
			<button type="button" class="help-button" onclick={openHelp}>
				<CircleHelp size={16} strokeWidth={1.8} aria-hidden="true" />
				Help
			</button>
		</div>
	{/if}
	</div>

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

	<!-- Stays mounted across every phase, so that finishing is announced rather
	     than being swallowed by the teardown of the region above. -->
	<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>

	{#if error}
		<div class="error" role="alert" tabindex="-1" bind:this={errorEl}>
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
							{:else if result.imageSkips?.length}
								{result.imageSkips
									.map((s) => `${s.count} ${s.reason}`)
									.join(', ')}
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

<!-- ── help ───────────────────────────────────────────────────────────── -->
<!-- A native <dialog>, so focus trapping, Escape-to-close and the backdrop
     come from the platform rather than from hand-written key handling. Styled
     from the reference's #popup. -->
<dialog bind:this={helpEl} class="help-dialog" onclick={onHelpBackdrop}>
	<div class="help-content">
		<h1>QCompress</h1>
		<p class="help-subtitle">Lossless PDF compression, entirely on your device.</p>

		<div class="help-section">
			<h2>Why use this?</h2>
			<p>
				Most online tools upload your file to a server. This one runs entirely in your browser,
				so your document never leaves your device.
			</p>
		</div>

		<div class="help-section">
			<h2>How to use</h2>
			<ol>
				<li>Select a PDF by clicking the drop zone or dragging one onto it.</li>
				<li>Choose a mode.</li>
				<li>Press <strong>Compress PDF</strong> and wait for the result.</li>
			</ol>
		</div>

		<div class="help-section">
			<h2>The modes</h2>
			<ul>
				<li><strong>Lossless</strong> rewrites the file structure only. Nothing is degraded.</li>
				<li>
					<strong>Balanced</strong> and <strong>Maximum</strong> may re-encode images. Several
					settings are tried and the smallest valid result is kept.
				</li>
				<li>If nothing valid is smaller, your original file is returned untouched.</li>
			</ul>
		</div>

		<div class="help-section">
			<h2>Worth knowing</h2>
			<ul>
				<li>Rewriting a PDF invalidates any digital signature it carried.</li>
				<li>Files up to 200&nbsp;MB. A single stream will not inflate past 128&nbsp;MB.</li>
				<li>Some PDFs cannot be safely improved. Those are reported, not silently altered.</li>
			</ul>
		</div>

		<button type="button" class="help-dismiss" onclick={closeHelp}>Got it</button>
	</div>
</dialog>

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
	/* The meta bar is fixed to the bottom, so exactly its height is reserved
	   here. That height is shared through a custom property rather than
	   written twice: it was a literal 33px, the restyle made the bar 28px, and
	   on a 420px-tall window the card then overlapped the bar by 3px. One
	   source, so the two cannot disagree again. */
	.footer {
		--footer-h: 28px;
	}

	.panel {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		/* min-height, not height: when the content genuinely cannot fit - a
		   380px-tall window - the panel grows and the page scrolls instead of
		   the card sliding under the fixed meta bar. Capping it at 100dvh would
		   hide the overflow. */
		min-height: calc(100dvh - var(--footer-h, 28px));
		gap: 0.625rem;
		padding: 1.5rem 1rem 5rem;
	}

	/* ── the upload card ──────────────────────────────────────────────────
	   Mirrors convert.toIt's .upload-card, copied from that repo's
	   src/ui/pages/Upload/index.css. The card is a child of the page, not the
	   page itself: .panel keeps min-height so the footer cannot overlap
	   content, and .card is what hugs its own content and centres with
	   margin:auto.

	   Only the empty state is a card. In every other phase the wrapper is
	   removed from layout with display:contents, so the file row, options,
	   progress, error and result panels flow exactly as they did before and
	   none of the 276 browser assertions change. */
	.card {
		display: flex;
		flex-direction: column;
		width: clamp(22.75rem, 70vw, 32.5rem);
		max-width: calc(100vw - 2rem);
		margin: auto;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow:
			0 1px 2px rgb(0 0 0 / 0.03),
			0 4px 12px rgb(0 0 0 / 0.04),
			0 12px 32px rgb(0 0 0 / 0.03);
		overflow: hidden;
	}

	/* Once a file is chosen the card is dissolved, not restyled. */
	.panel:not(.empty) .card {
		display: contents;
	}

	/* Empty state: centre the card horizontally and drop the column gap, since
	   the card supplies its own internal spacing.

	   Vertical centring is left entirely to .card's margin:auto. Adding
	   justify-content:center here pins the card to the top and clips its
	   overflow when the viewport is shorter than the card - which is exactly
	   what happened on short windows. Auto margins collapse to zero when there
	   is no free space, so the card simply flows from the top instead of being
	   cut off. */
	.panel.empty {
		align-items: center;
		gap: 0;
		/* Vertical padding is keyed to vh: at 1.5rem top and bottom it consumed
		   48px that the card needed on a 380px-tall window, and the card
		   overlapped the fixed meta bar by 4px. */
		padding: clamp(0.5rem, 3vh, 1.5rem) 1rem clamp(0.5rem, 2vh, 1rem);
	}

	/* Reference .upload-card-actions. */
	.card-actions {
		display: flex;
		justify-content: center;
		gap: 0.75rem;
		/* Same reason as the dropzone: the lower clamp bound is what keeps the
		   card clear of the fixed meta bar on a short window. */
		padding: clamp(0.5rem, 2vw, 1.5rem) 1.25rem clamp(0.75rem, 2.5vw, 1.75rem);
	}

	/* A transcription of the reference's .styled-button (default variant), not
	   an approximation of it. An earlier version added a 44px min-height and a
	   justify-content that the reference does not have, and used --border where
	   the reference uses --btn-border; that made the button visibly taller than
	   the original. Those were inventions, not requirements - test:mobile
	   measures .drop, button.primary, .chip and a.primary[download], and none of
	   them is this button. */
	.help-button {
		appearance: none;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.55rem 0.85rem;
		background: var(--bg-card);
		border: 1px solid var(--btn-border);
		border-radius: 8px;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 600;
		user-select: none;
		transition:
			color 150ms,
			background 150ms,
			border-color 150ms;
	}

	.help-button:hover,
	.help-button:focus-visible {
		color: var(--text-primary);
		background: var(--bg-section);
		border-color: var(--border-strong);
	}

	/* Reference #popup. */
	.help-dialog {
		max-width: 32rem;
		width: calc(100vw - 2rem);
		max-height: calc(100dvh - 4rem);
		padding: 1.75rem 2rem;
		background: var(--bg-card);
		color: var(--text-primary);
		border: 1px solid var(--border);
		border-radius: 14px;
		box-shadow: 0 20px 60px rgb(0 0 0 / 0.4);
		overflow-y: auto;
	}

	.help-dialog[open] {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin: auto;
	}

	/* The reference uses brightness(0.7) blur(4px) over rgba(0,0,0,0.35).
	   The dimming must come from the backdrop layer alone: applying it to the
	   dialog itself dims the text being read, which is the opposite of the
	   intent. Only the blur is kept here, because a brightness filter would
	   wash out the 4.5:1 text this palette was measured for. */
	.help-dialog::backdrop {
		background: rgb(0 0 0 / 0.55);
		backdrop-filter: blur(4px);
	}

	.help-content {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.help-content h1 {
		font-size: 1.2rem;
		font-weight: 800;
		line-height: 1.3;
	}

	.help-content h2 {
		margin-top: 0.5rem;
		font-size: 0.95rem;
		font-weight: 700;
	}

	.help-subtitle {
		color: var(--primary-text);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.help-content p,
	.help-content ol,
	.help-content ul {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.6;
	}

	.help-content ol,
	.help-content ul {
		padding-left: 1.25rem;
		line-height: 1.7;
	}

	.help-content li {
		margin-bottom: 0.25rem;
	}

	.help-dismiss {
		align-self: center;
		min-width: 30%;
		min-height: 44px;
		margin-top: 0.5rem;
		padding: 0.55rem 1.2rem;
		background: var(--primary);
		border: none;
		border-radius: 8px;
		color: var(--text-on-primary);
		font-size: 0.85rem;
		font-weight: 700;
		transition: opacity 150ms ease;
	}

	.help-dismiss:hover {
		opacity: 0.9;
	}

	/* Reference .upload-card-header: centred, with clamp(1.5rem,3vw,2rem)
	   above and clamp(1rem,2vw,1.5rem) below. Lower bound reduced so the card
	   fits above the fixed meta bar on a short window. */
	.wordmark {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		margin: 0;
		padding: clamp(0.75rem, 3vw, 2rem) 2rem clamp(0.5rem, 2vw, 1.5rem);
		font-size: 1.2rem;
		font-weight: 800;
		letter-spacing: -0.02em;
		user-select: none;
	}

	.mark {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--primary-text);
		transition: transform 400ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	/* The reference rotates its mark on hover; the motion is dropped under
	   reduced-motion rather than merely slowed. */
	@media (prefers-reduced-motion: no-preference) {
		.wordmark:hover .mark {
			transform: rotate(-45deg);
		}
	}

	/* ── file selection ──────────────────────────────────────────────── */
	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		width: 100%;
		/* Reference .upload-dropzone: bg-card-alt, 2px dashed, 12px radius,
		   inset 1.25rem from the card edge via margin, generous padding.

		   No min-height, as in the reference: it sizes to its content. A 12rem
		   floor was added earlier and made the card 374px tall, tall enough to
		   overflow a short window and get pinned to the top.

		   The vertical clamp is keyed to vh, not vw. The reference's 5vw/3rem
		   assumes a wide window, and 5vw is a function of width - so at 1280px
		   wide the padding stayed at its 3rem maximum no matter how short the
		   window became, and the card ran under the fixed meta bar at 420px
		   tall. The side padding keeps the reference's 4vw/2rem, which is a
		   width concern and behaves correctly. */
		margin: 0 1.25rem;
		width: auto;
		padding: clamp(0.75rem, 6vh, 3rem) clamp(1.5rem, 4vw, 2rem);
		background: var(--bg-alt);
		border: 2px dashed var(--border);
		border-radius: 12px;
		text-align: center;
		cursor: pointer;
		transition:
			background-color 200ms cubic-bezier(0.165, 0.84, 0.44, 1),
			border-color 200ms cubic-bezier(0.165, 0.84, 0.44, 1),
			transform 100ms cubic-bezier(0.165, 0.84, 0.44, 1);
	}

	.drop:hover,
	.drop.dragging {
		background: var(--bg-alt-hover);
		border-color: var(--primary);
	}

	.drop:active:not(.dragging) {
		transform: scale(0.995);
	}

	/* Circular icon well, as in the reference's .upload-icon-wrap. */
	.upload-badge {
		display: grid;
		place-items: center;
		width: 4.5rem;
		height: 4.5rem;
		margin-bottom: 1rem;
		background: var(--bg-card);
		border-radius: 999px;
		color: var(--primary-text);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.04),
			0 2px 8px rgb(0 0 0 / 0.04);
		transition: transform 240ms cubic-bezier(0.165, 0.84, 0.44, 1);
	}

	@media (prefers-reduced-motion: no-preference) {
		.drop:hover .upload-badge {
			transform: scale(1.08);
		}

		.drop:active:not(.dragging) .upload-badge {
			transform: scale(1.04);
		}
	}

	.drop-title {
		/* The lighter blue: 13px bold on the dark dropzone, where the fill blue
		   would sit at 3.35:1. */
		color: var(--primary-text);
		font-size: 0.9375rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		line-height: 1.3;
	}

	.drop-hint {
		margin-top: 0.375rem;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	/* Once a file is chosen the same element collapses to a file row, inside a
	   card that has been dissolved by display:contents - so the dropzone's
	   1.25rem inset has to be undone here rather than inherited.

	   Values are the reference's .file-info-badge: bg-section fill, 8px radius,
	   0.4/0.65rem padding, 0.8125rem text, 280px cap. min-height stays at 44px
	   because test:mobile measures .drop as a tap target. */
	.panel:not(.empty) .drop {
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		gap: 0.5rem;
		min-height: 44px;
		max-width: 280px;
		margin: 0 auto;
		padding: 0.4rem 0.65rem;
		background: var(--bg-section);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.8125rem;
		text-align: left;
		transition: background 150ms ease;
	}

	/* Reference .file-info-name / .file-info-size. */
	.panel:not(.empty) .file-name {
		font-weight: 600;
	}

	.panel:not(.empty) .file-meta {
		color: var(--text-tertiary);
		font-size: 0.6875rem;
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
		color: var(--primary-text);
	}

	.out-row :global(svg) {
		color: var(--success);
	}

	/* ── buttons ─────────────────────────────────────────────────────── */
	/* Reference .styled-button: 8px radius, 0.55/0.85rem padding, 0.8rem at
	   weight 600, with a 150ms colour/background/border transition. */
	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		align-self: center;
		min-width: 15rem;
		/* WCAG 2.5.5 target size. Kept as min-height so it holds regardless
		   of the user's font size - the reference's padding alone gives 36px. */
		min-height: 44px;
		margin: 0.25rem auto 0;
		padding: 0.55rem 0.85rem;
		background: var(--primary);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-on-primary);
		font-size: 0.8rem;
		font-weight: 600;
		text-decoration: none;
		transition: opacity 150ms ease;
	}

	.primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.primary:disabled {
		opacity: 0.5;
	}

	.secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		/* Same reasoning as .primary: this is a touch target too. */
		min-height: 44px;
		padding: 0.55rem 0.85rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 600;
		transition:
			color 150ms ease,
			background-color 150ms ease,
			border-color 150ms ease;
	}

	.secondary:hover {
		color: var(--text-primary);
		background: var(--bg-section);
		border-color: var(--border-strong);
	}

	/*
	 * The recovery actions inside the error panel. The reference has no
	 * equivalent, but it does style buttons that sit inside a dialog - its
	 * .explorer-dialog-btn is a bordered 8px-radius control with primary text
	 * that fills with primary on hover, and that is the pattern followed here.
	 *
	 * These were underlined text links before. They are recovery actions a
	 * phone user may need after a failed upload, so min-height stays at 44px
	 * even though the reference's own padding yields a shorter control.
	 */
	.link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-height: 44px;
		padding: 0.45rem 1rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--primary-text);
		font-size: 0.8rem;
		font-weight: 600;
		transition:
			background 150ms,
			color 150ms,
			border-color 150ms;
	}

	.link:hover:not(:disabled) {
		background: var(--primary);
		border-color: var(--primary);
		color: var(--text-on-primary);
	}

	.link:disabled {
		opacity: 0.5;
	}

	/* ── options ─────────────────────────────────────────────────────── */
	/*
	 * Centred and width-capped. .panel is align-items:stretch so the upload
	 * card can fill its wrapper, which left this block running the full page
	 * width - the MODE label and chips sat flush against the left edge while
	 * the file row and primary action above them were centred. Every block in
	 * the column is capped and centred the same way.
	 */
	.options {
		width: 100%;
		max-width: 26rem;
		align-self: center;
		margin: 0.75rem 0 0;
		padding: 0;
		border: 0;
	}

	/* The reference's .header-step-label, which it uses for the step marker in
	   the conversion header. Uppercase, primary-coloured, on a 10% primary
	   wash - a badge rather than the plain grey caption this used to be. */
	.section-label {
		display: inline-flex;
		align-self: flex-start;
		margin: 0 0 0.5rem;
		padding: 0.2rem 0.55rem;
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		border-radius: 4px;
		color: var(--primary-text);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	/*
	 * Two layers, deliberately.
	 *
	 * The reference's .chip is a 26px pill: padding 0.25rem 0.6rem at 0.75rem.
	 * Copying that onto the <label> fails test:mobile, which asserts every
	 * .chip is at least 44px tall - an assertion added after an earlier run
	 * found the primary button at 39px and did not look at the chips at all.
	 *
	 * So the <label> is the touch target and the inner <span> is the reference's
	 * pill, verbatim. The chip looks like the reference and is hit-tested at
	 * 44px, which is how a native segmented control behaves: a small visible
	 * control inside a larger invisible one. boundingBox() measures the label,
	 * so the assertion is satisfied honestly rather than by being relaxed.
	 */
	.chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		cursor: pointer;
	}

	.chip > span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.25rem 0.6rem;
		background: var(--bg-section);
		border: 1px solid transparent;
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.4;
		user-select: none;
		white-space: nowrap;
		transition:
			background 150ms ease,
			border-color 150ms ease,
			color 150ms ease;
	}

	.chip:hover > span {
		background: var(--bg-light);
		color: var(--text-primary);
	}

	/* Focus lands on the hidden radio, so the ring is drawn on the pill. */
	.chip:has(input:focus-visible) > span {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.chip:has(input:checked) > span {
		background: var(--primary);
		border-color: var(--primary);
		color: var(--text-on-primary);
		font-weight: 600;
	}

	.chip:has(input:checked):hover > span {
		opacity: 0.9;
	}

	/* Carries real meaning - the signature warning, what each mode does - so it
	   is not the faintest tier. 12px on the page background, where tertiary
	   measured 2.53:1. */
	.hint {
		margin: 0.75rem 0 0;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.hint.mode-tag {
		margin-top: 0.25rem;
		color: var(--text-secondary);
	}

	/* Honest summary of what the engine actually did. Same card as .sizes -
	   the reference's .loading-metrics-card - because it reports the same kind
	   of thing. list-style stays none: this is a definition list, not prose,
	   and bullets would misrepresent it. */
	.report {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 1rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 12px;
		list-style: none;
		font-size: 0.8125rem;
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
	/*
	 * Copied from the reference's .loading-conversion-info: a striped track
	 * built from a repeating -45deg gradient, animated by translating the
	 * background by exactly one stripe pair.
	 *
	 * ONE DELIBERATE OMISSION. The reference fills this by clipping a
	 * pseudo-element with clip-path: inset(0 calc(100% - var(--progress))). That
	 * needs a real percentage, and QCompress has none - qpdf reports no
	 * incremental progress, so none is faked. The fill therefore slides across
	 * instead of clipping to a figure. Same materials, same motion direction,
	 * no invented number.
	 *
	 * The DOM is unchanged: test-browser queries .progress and reads .bar span
	 * to assert it stops animating under reduced-motion, so both are kept.
	 */
	.progress {
		width: 100%;
		max-width: 26rem;
		align-self: center;
	}

	.progress p {
		margin: 0.5rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		text-align: center;
	}

	.bar {
		--stripe-width: 10px;
		/* stripe-width * 2 * sqrt(2), the reference's value: the distance the
		   background must travel for the stripes to appear stationary. */
		--stripe-size: 28.284px;
		position: relative;
		height: 2.5rem;
		overflow: hidden;
		background: repeating-linear-gradient(
			-45deg,
			var(--bg-section),
			var(--bg-section) var(--stripe-width),
			transparent var(--stripe-width),
			transparent calc(var(--stripe-width) * 2)
		);
		background-size: var(--stripe-size) var(--stripe-size);
		border: 1px solid var(--border);
		border-radius: 8px;
		animation: progress-stripes 0.8s linear infinite;
	}

	.bar span {
		position: absolute;
		inset: 0 auto 0 0;
		width: 35%;
		background: repeating-linear-gradient(
			-45deg,
			var(--primary),
			var(--primary) var(--stripe-width),
			var(--primary-transparent) var(--stripe-width),
			var(--primary-transparent) calc(var(--stripe-width) * 2)
		);
		background-size: var(--stripe-size) var(--stripe-size);
		animation: slide 1.6s linear infinite;
	}

	@keyframes progress-stripes {
		from {
			background-position: 0 0;
		}
		to {
			background-position: var(--stripe-size) 0;
		}
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
		/* The reference stops the stripe animation on both the track and its
		   fill for the same reason. The track's stripes are what signal "still
		   working" once motion is off, so the fill goes full width and the
		   status text carries the rest. test-browser reads .bar span here and
		   asserts it is no longer animating. */
		.bar,
		.bar span {
			animation: none;
		}

		.bar span {
			width: 100%;
			opacity: 0.5;
		}

		/* The spinner used to be slowed to 2.4s here, which is still an
		 * infinitely looping rotation - the exact thing the preference asks to
		 * be spared. It is removed instead; the button's own label and the
		 * full-width dimmed bar carry "still working" without any motion. */
		.primary.busy :global(svg) {
			animation: none;
			opacity: 0.55;
		}
	}

	/* ── error ───────────────────────────────────────────────────────── */
	/*
	 * The reference has no inline error component - its Popup is for help and
	 * confirmation, and it carries no danger styling at all. Converting this
	 * panel to a dialog would also be wrong here: it is non-blocking, and
	 * test-browser pins .error, role="alert", its text and .error-actions.
	 *
	 * So the shape is this app's and the colour treatment is the reference's:
	 * --danger-transparent for the fill and color-mix(danger 20%) for the
	 * border are the exact values its .loading-action-btn.danger:hover uses.
	 */
	.error {
		width: 100%;
		max-width: 34rem;
		align-self: center;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 0.85rem;
		background: var(--danger-soft);
		border: 1px solid color-mix(in srgb, var(--danger) 20%, transparent);
		border-radius: 8px;
	}

	.error p {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0;
		color: var(--danger);
		font-size: 0.85rem;
		line-height: 1.6;
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
		gap: 0.5rem;
		margin-top: 0.25rem;
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

	/* The reference's .loading-metrics-card: a bordered, 12px-radius card on
	   --bg-card, 1rem padding, capped at 500px. Used for both the before/after
	   figures and the engine report, which are the same kind of object. */
	.sizes {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
		margin: 0;
		padding: 1rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 12px;
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

	/*
	 * The reference's .conversion-action-bar: a horizontal bar on --bg-card
	 * with a top border, 0.75rem gaps, 0.75/1.25rem padding and a 64px floor.
	 * It was a full-width vertical stack before, which is the opposite of how
	 * the reference presents its own actions.
	 */
	.result-actions {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1.25rem;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		min-height: 64px;
	}

	/* The download is the reason the panel is open, so it leads. The reference
	   gives its primary action no fixed width; min-width is dropped here so the
	   two buttons sit side by side instead of one stretching. test:mobile
	   measures a.primary[download] as a tap target, and min-height on .primary
	   keeps that true at this width. */
	.result-actions .primary {
		min-width: 0;
		flex: 1 1 12rem;
	}

	.result-actions .secondary {
		flex: 0 0 auto;
	}

	/* ── footer: meta bar ────────────────────────────────────────────── */
	.footer {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 10;
	}

	/* Reference footer: --bg-section, 0.75rem, muted, items right-aligned with
	   the copyright pushed to the far end. */
	.meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.4rem 1rem;
		background: var(--bg-section);
		border-top: 1px solid var(--border);
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.source {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--text-secondary);
		text-decoration: none;
		transition: color 150ms ease;
	}

	.source:hover {
		color: var(--text-primary);
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