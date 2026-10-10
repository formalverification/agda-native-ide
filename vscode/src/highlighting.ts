// File: vscode/src/highlighting.ts

export function tokenReader<T>(request: (uri: string) => PromiseLike<T>, timeoutMs = 3000): (uri: string) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return uri => {
    const existing = pending.get(uri);
    if (existing) return existing;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Highlighting is still pending for this module.')), timeoutMs);
      // The command has no cancellation argument.  Keep the rejected wait
      // cached until the underlying request settles, including after timeout.
      void Promise.resolve().then(() => request(uri)).then(value => {
        clearTimeout(timer);
        pending.delete(uri);
        resolve(value);
      }, error => {
        clearTimeout(timer);
        pending.delete(uri);
        reject(error);
      });
    });
    pending.set(uri, result);
    return result;
  };
}
