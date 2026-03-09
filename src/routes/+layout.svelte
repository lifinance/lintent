<script lang="ts">
	import { Buffer } from "buffer";
	globalThis.Buffer = Buffer;

	import "../app.css";

	let { children } = $props();
</script>

{@render children()}
