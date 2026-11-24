import { chromium } from 'playwright';
const B = process.argv[2];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline:false, latency:150, downloadThroughput:1.6*1024*1024/8, uploadThroughput:750*1024/8 });
await p.goto(B + '/', { waitUntil: 'load', timeout: 120000 });
await p.waitForTimeout(2500);
const m = await p.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return {
    ttfb: Math.round(n.responseStart), fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
    dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd),
    bg: getComputedStyle(document.body).backgroundImage.slice(0, 40),
    jsBytes: performance.getEntriesByType('resource').filter(e => e.name.includes('home.js')).map(e => e.transferSize)[0],
  };
});
console.log(JSON.stringify(m));
await b.close();
