// Reference clock aligned to Renfe's servers.
//
// Ages and dead-reckoning are only as good as the clock they are measured with. The host's
// clock may be off (the dev PC was ~12 s behind), so we estimate the offset from the HTTP
// `Date` header of every feed response (1 s resolution, so we take the median of many samples).

const samples = [];
let skew = 0;

export function observe(dateHeader, sentAt, receivedAt) {
  const server = Date.parse(dateHeader || '');
  if (!server) return;
  // Date is truncated to the second: on average the true server time is +500 ms.
  samples.push(server + 500 - (sentAt + receivedAt) / 2);
  if (samples.length > 60) samples.shift();
  const s = [...samples].sort((a, b) => a - b);
  skew = s[s.length >> 1];
}

export const now = () => Date.now() + skew;
export const skewMs = () => Math.round(skew);
