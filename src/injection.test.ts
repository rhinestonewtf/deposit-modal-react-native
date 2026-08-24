import { describe, expect, it } from "vitest";

import {
  buildChannelScript,
  createSessionNonce,
  encodeFrameForInjection,
  parseInboundFrame,
} from "./injection";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Run an injected statement the way the web view's main frame would. */
function evaluate(script: string, window: Record<string, unknown>): void {
  const run = new Function("window", script) as (w: unknown) => void;
  run(window);
}

describe("the injected channel script", () => {
  it("installs a page→host channel that prefixes the nonce", () => {
    const posted: string[] = [];
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (value: string) => posted.push(value) },
    };
    evaluate(buildChannelScript("abc123"), window);

    const bridge = window.rhinestoneBridge as {
      postMessage: (v: string) => void;
    };
    bridge.postMessage('{"kind":"event","type":"ready"}');

    expect(posted).toEqual(['abc123|{"kind":"event","type":"ready"}']);
  });

  it("refuses to be replaced, and installs only once", () => {
    const posted: string[] = [];
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (value: string) => posted.push(value) },
    };
    evaluate(buildChannelScript("abc123"), window);
    const first = window.rhinestoneBridge;

    // A second injection — a reload racing the first, or a page script trying
    // to shadow the channel — must not swap what the page posts through.
    evaluate(buildChannelScript("different"), window);
    expect(window.rhinestoneBridge).toBe(first);

    expect(() => {
      "use strict";
      (window as { rhinestoneBridge: unknown }).rhinestoneBridge = {
        postMessage: () => undefined,
      };
    }).toThrow();
  });

  it("drops a non-string, so an object never coerces on the wire", () => {
    const posted: string[] = [];
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (value: string) => posted.push(value) },
    };
    evaluate(buildChannelScript("abc123"), window);

    const bridge = window.rhinestoneBridge as {
      postMessage: (v: unknown) => void;
    };
    bridge.postMessage({ kind: "event" });

    expect(posted).toEqual([]);
  });
});

describe("encoding a frame as a statement", () => {
  it("delivers the frame verbatim", () => {
    const received: string[] = [];
    const json = '{"kind":"response","id":"1","ok":true,"result":null}';
    evaluate(encodeFrameForInjection(json), {
      __rhinestone_bridge: (value: string) => received.push(value),
    });

    expect(received).toEqual([json]);
  });

  it("survives the line separators that are legal JSON and not legal script", () => {
    const received: string[] = [];
    // Both reach this boundary inside wallet-controlled text: the message on a
    // refusal is the wallet's own copy, and the page renders it verbatim.
    const message = `refused${LINE_SEPARATOR}by wallet${PARAGRAPH_SEPARATOR}anyway`;
    const json = JSON.stringify({
      kind: "response",
      id: "1",
      ok: false,
      error: { code: 4001, message },
    });
    const script = encodeFrameForInjection(json);

    expect(script).not.toContain(LINE_SEPARATOR);
    expect(script).not.toContain(PARAGRAPH_SEPARATOR);
    evaluate(script, {
      __rhinestone_bridge: (value: string) => received.push(value),
    });
    expect(JSON.parse(received[0] as string).error.message).toBe(message);
  });

  it("escapes `<`, so the same encoder is safe in a script body", () => {
    const json = JSON.stringify({ kind: "event", type: "</script>" });
    expect(encodeFrameForInjection(json)).not.toContain("<");
  });

  it("does nothing when the page has gone", () => {
    // A web view killed mid-flow still takes injected script; the receiver is
    // simply not there, and that must not throw inside the host.
    expect(() =>
      evaluate(encodeFrameForInjection('{"kind":"event"}'), {}),
    ).not.toThrow();
  });
});

describe("parsing an inbound frame", () => {
  it("splits the nonce from the frame", () => {
    expect(parseInboundFrame('abc|{"kind":"event"}')).toEqual({
      nonce: "abc",
      json: '{"kind":"event"}',
    });
  });

  it("keeps a separator that appears inside the frame", () => {
    expect(parseInboundFrame('abc|{"a":"b|c"}')?.json).toBe('{"a":"b|c"}');
  });

  it("rejects what a sub-frame would post", () => {
    expect(parseInboundFrame('{"kind":"event"}')).toBeUndefined();
    expect(parseInboundFrame("|no-nonce")).toBeUndefined();
    expect(parseInboundFrame(42)).toBeUndefined();
  });
});

describe("the session nonce", () => {
  it("is hex, long, and not the same twice", () => {
    const first = createSessionNonce();
    const second = createSessionNonce();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});
