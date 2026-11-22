/* Renders loops at a new tempo off the main thread, so the page never stalls. */
importScripts("stretch.js");
onmessage = (e) => {
  const { id, L, R, sr, ratio } = e.data;
  try {
    const o = stretchLoop(L, R, sr, ratio);
    postMessage({ id, L: o.L, R: o.R }, [o.L.buffer, o.R.buffer]);
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};
