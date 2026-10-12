// File: scripts/library-archives/gate/memory.ts
//
// The reactor's heap, for the gate's record (issue 13): its linear memory,
// which a wasm32 Agda cannot grow past 4 GiB in a browser either, and which
// never shrinks, so its size when a check has ended is the check's peak.
// It wraps WebAssembly.instantiate before the engine's worker runs, to keep
// the instance's memory, and answers the page on a BroadcastChannel, which
// leaves the worker's own messages to the engine.  The worker's name is
// the check's, which the page gives it.

const channel = new BroadcastChannel("library-gate-memory");
let memory: WebAssembly.Memory | undefined;

const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
  ...args: unknown[]
) => Promise<WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource>;
(WebAssembly as { instantiate: unknown }).instantiate = async (...args: unknown[]) => {
  const result = await instantiate(...args);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exported = instance.exports.memory;
  if (exported instanceof WebAssembly.Memory) memory = exported;
  return result;
};

channel.onmessage = (event: MessageEvent<{ ask?: string }>) => {
  if (event.data?.ask === self.name)
    channel.postMessage({ name: self.name, bytes: memory ? memory.buffer.byteLength : null });
};
