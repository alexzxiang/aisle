import {
  DEFAULT_PROXY_URL,
  LATENCY_BUDGET_MS,
  TRANSITION_CAP_MS,
  config,
  normalizeProxyUrl,
  normalizeProxyWs,
  parseMockFlag,
  readConfig,
  wsFromProxyUrl,
} from './config';

describe('config', () => {
  it('falls back to safe defaults when nothing is set', () => {
    const c = readConfig({});
    expect(c.proxyUrl).toBe(DEFAULT_PROXY_URL);
    expect(c.proxyWs).toBe('ws://localhost:8787/ws');
    expect(c.mock).toBe(false);
  });

  it('reads the three EXPO_PUBLIC variables', () => {
    const c = readConfig({
      EXPO_PUBLIC_PROXY_URL: 'https://aisle-proxy.example.com/',
      EXPO_PUBLIC_PROXY_WS: 'wss://aisle-proxy.example.com/ws',
      EXPO_PUBLIC_MOCK: '1',
    });
    expect(c.proxyUrl).toBe('https://aisle-proxy.example.com');
    expect(c.proxyWs).toBe('wss://aisle-proxy.example.com/ws');
    expect(c.mock).toBe(true);
  });

  it('derives the WebSocket URL from the proxy URL when unset', () => {
    expect(wsFromProxyUrl('https://h:1234')).toBe('wss://h:1234/ws');
    expect(wsFromProxyUrl('http://10.0.0.5:8787/')).toBe('ws://10.0.0.5:8787/ws');
    expect(readConfig({ EXPO_PUBLIC_PROXY_URL: 'https://h:1234' }).proxyWs).toBe('wss://h:1234/ws');
  });

  it('rejects malformed values and keeps the default', () => {
    expect(normalizeProxyUrl('not a url')).toBe(DEFAULT_PROXY_URL);
    expect(normalizeProxyUrl('ftp://x')).toBe(DEFAULT_PROXY_URL);
    expect(normalizeProxyUrl('   ')).toBe(DEFAULT_PROXY_URL);
    expect(normalizeProxyWs('http://not-ws', 'http://h:1')).toBe('ws://h:1/ws');
  });

  it('treats only the literal "1" as mock', () => {
    expect(parseMockFlag('1')).toBe(true);
    expect(parseMockFlag(' 1 ')).toBe(true);
    expect(parseMockFlag('true')).toBe(false);
    expect(parseMockFlag('0')).toBe(false);
    expect(parseMockFlag(undefined)).toBe(false);
  });

  it('exposes a frozen app-wide config and the latency budget', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(typeof config.proxyUrl).toBe('string');
    expect(LATENCY_BUDGET_MS.tier0FrameToHaptic).toBe(150);
    expect(LATENCY_BUDGET_MS.minGapNonCritical).toBe(4000);
    expect(TRANSITION_CAP_MS).toBe(3000);
  });
});
