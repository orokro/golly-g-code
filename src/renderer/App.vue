<!--
	@file App.vue
	@description Application root.

	PLACEHOLDER — Phase 0 only. This exists to prove the shell boots, the preload
	bridge is reachable, and the CSP is not blocking anything. Phase 2 replaces it
	entirely with the vue-win-mgr layout.
-->
<script setup>

import { ref, onMounted } from 'vue';

/** @type {import('vue').Ref<String>} Application version, read over IPC. */
const version = ref('…');

/** @type {import('vue').Ref<String>} Result of the Web Worker smoke test. */
const workerStatus = ref('…');

/** @type {import('vue').Ref<String>} Result of the WebGL capability probe. */
const webglStatus = ref('…');


/**
 * Verifies a blob-URL Web Worker can actually be created.
 *
 * This is the single most valuable check in this placeholder: the upstream
 * template's CSP silently blocked blob workers, and that failure reproduces only
 * in the packaged build. If this ever reports "blocked", the CSP in main.cjs has
 * regressed.
 *
 * @returns {void}
 */
function probeWorker() {

	try {
		const source = 'self.onmessage = () => self.postMessage("pong");';
		const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		const worker = new Worker(url);

		worker.onmessage = (event) => {
			workerStatus.value = `ok (${event.data})`;
			worker.terminate();
			URL.revokeObjectURL(url);
		};

		worker.onerror = () => {
			workerStatus.value = 'BLOCKED — check the CSP in src/main/main.cjs';
		};

		worker.postMessage('ping');

	} catch (error) {
		workerStatus.value = `BLOCKED — ${error.message}`;
	}
}


/**
 * Reports which WebGL version this machine can actually provide.
 *
 * three.js dropped its WebGL1 fallback at r163, so a WebGL2-capable context is a
 * hard requirement for the Preview3D window in Phase 8.
 *
 * @returns {void}
 */
function probeWebGL() {

	const canvas = document.createElement('canvas');
	const gl2 = canvas.getContext('webgl2');

	if (gl2 !== null) {
		const info = gl2.getExtension('WEBGL_debug_renderer_info');
		const renderer = info ? gl2.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
		webglStatus.value = `WebGL2 — ${renderer}`;
		return;
	}

	webglStatus.value = canvas.getContext('webgl') !== null
		? 'WebGL1 ONLY — three.js r163+ will not run here'
		: 'no WebGL at all';
}


onMounted(async () => {
	version.value = await window.gollyAPI.getVersion();
	probeWorker();
	probeWebGL();
});

</script>

<template>
	<div class="boot">
		<h1>GollyGCode</h1>
		<p class="sub">Phase 0 shell — replaced in Phase 2.</p>
		<dl>
			<dt>version</dt><dd>{{ version }}</dd>
			<dt>blob worker</dt><dd>{{ workerStatus }}</dd>
			<dt>webgl</dt><dd>{{ webglStatus }}</dd>
		</dl>
	</div>
</template>

<style scoped>

.boot {
	padding: 32px;
	font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
}

h1 {
	margin: 0;
	font-size: 22px;
	font-weight: 600;
}

.sub {
	margin: 4px 0 24px;
	opacity: 0.5;
}

dl {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 6px 18px;
	margin: 0;
}

dt {
	opacity: 0.5;
}

dd {
	margin: 0;
}

</style>
