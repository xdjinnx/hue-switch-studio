'use strict';

/**
 * Hue Bridge client.
 *
 * The bridge serves a certificate signed by a private "root-bridge" CA that is not in
 * Node's trust store, so ordinary verification always fails. Instead of disabling
 * verification globally, we disable Node's chain check for this one host and enforce a
 * SHA-256 pin of the certificate's public key (SPKI) ourselves. That is equivalent to
 * `curl --pinnedpubkey` and is strictly stronger than trusting any CA-signed cert.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DISCOVERY_URL = 'https://discovery.meethue.com';

/**
 * SHA-256 of the DER SubjectPublicKeyInfo, base64 — the same value as
 * `openssl x509 -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64`,
 * and the same value `curl --pinnedpubkey sha256//...` expects.
 *
 * Deliberately derived from `cert.raw` rather than `cert.pubkey`: for an ECDSA certificate
 * (which Hue bridges use) `cert.pubkey` is the bare 65-byte EC point, not the SPKI wrapper,
 * so hashing it produces a value that agrees with nothing else.
 */
function spkiPin(cert) {
  if (!cert || !cert.raw) return null;
  try {
    const spki = new crypto.X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(spki).digest('base64');
  } catch {
    return null;
  }
}

/** The algorithm identifier stored alongside a pin, so a change here forces a re-learn. */
const PIN_ALG = 'spki-sha256';

/**
 * Dedicated agent with TLS session caching disabled. On a resumed session the peer
 * certificate is not re-sent, so there would be nothing to check the pin against — every
 * connection must present its full certificate.
 */
const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0, rejectUnauthorized: false });

class PinMismatchError extends Error {
  constructor(expected, actual) {
    super(`Bridge certificate pin mismatch.\nExpected: ${expected}\nActual:   ${actual}\n\n` +
          'This means the bridge was replaced/reset, or something is intercepting the connection.');
    this.name = 'PinMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * One HTTPS request to the bridge with public-key pinning.
 * If `pin` is null the observed pin is returned so the caller can trust-on-first-use.
 */
function bridgeRequest({ host, pin, path, method = 'GET', appKey = null, body = null, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (appKey) headers['hue-application-key'] = appKey;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    let observedPin = null;
    let pinError = null;

    // SNI must not carry an IP literal (RFC 6066); Node warns it will start ignoring it.
    // Bridges are normally addressed by IP, and public-key pinning is what actually
    // establishes identity here, so only send SNI when we genuinely have a hostname.
    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

    const req = https.request(
      {
        host, port: 443, path, method, headers, agent,
        rejectUnauthorized: false,
        ...(isIpLiteral ? {} : { servername: host }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (pinError) return reject(pinError);
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            return reject(new Error(`Bridge returned non-JSON (HTTP ${res.statusCode}): ${text.slice(0, 300)}`));
          }
          resolve({ status: res.statusCode, json, pin: observedPin });
        });
      }
    );

    req.on('socket', (socket) => {
      const verify = () => {
        observedPin = spkiPin(socket.getPeerCertificate());
        if (!observedPin) {
          pinError = new Error('Bridge presented no usable certificate.');
          req.destroy();
        } else if (pin && observedPin !== pin) {
          pinError = new PinMismatchError(pin, observedPin);
          req.destroy();
        }
      };
      // A keep-alive socket is already through its handshake, so `secureConnect` will not
      // fire again — inspect it immediately instead, so every request reports a pin.
      if (socket.encrypted && !socket.connecting) verify();
      else socket.once('secureConnect', verify);
    });

    req.setTimeout(timeout, () => req.destroy(new Error(`Timed out talking to bridge at ${host}`)));
    req.on('error', (err) => reject(pinError || err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ask Philips' public discovery service which bridges share this WAN IP. */
function discoverViaCloud() {
  return new Promise((resolve) => {
    const req = https.get(DISCOVERY_URL, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const list = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(list) ? list : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

/** Unauthenticated identity probe over plain HTTP — no certificate involved. */
function probeConfig(host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port: 80, path: '/api/config', timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Not a Hue bridge (unparseable /api/config).'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('No response on port 80.')); });
  });
}

class Bridge {
  constructor({ host, pin = null, appKey = null }) {
    this.host = host;
    this.pin = pin;
    this.appKey = appKey;
  }

  /** Learn the pin without authenticating. Verifies the cert CN matches the bridge id. */
  async learnPin() {
    const res = await bridgeRequest({ host: this.host, pin: null, path: '/api/config' });
    this.pin = res.pin;
    return { pin: res.pin, config: res.json };
  }

  /** Requires a physical press of the bridge's link button within the last ~30s. */
  async pair(appName = 'hue_switch_studio', deviceName = 'desktop') {
    const res = await bridgeRequest({
      host: this.host,
      pin: this.pin,
      path: '/api',
      method: 'POST',
      body: { devicetype: `${appName}#${deviceName}`, generateclientkey: true },
    });
    const entry = Array.isArray(res.json) ? res.json[0] : null;
    if (entry && entry.error) {
      const err = new Error(entry.error.description || 'Pairing failed');
      err.hueType = entry.error.type; // 101 = link button not pressed
      throw err;
    }
    if (!entry || !entry.success) throw new Error('Unexpected pairing response from bridge.');
    this.appKey = entry.success.username;
    return { appKey: entry.success.username, clientKey: entry.success.clientkey };
  }

  async v2(path, method = 'GET', body = null) {
    const res = await bridgeRequest({
      host: this.host, pin: this.pin, appKey: this.appKey,
      path: `/clip/v2${path}`, method, body,
    });
    if (res.status === 401 || res.status === 403) throw new Error('Bridge rejected the application key. Re-pair required.');
    const errors = res.json && res.json.errors;
    if (errors && errors.length) {
      const err = new Error(describeV2Error(errors));
      err.raw = errors;
      throw err;
    }
    return res.json ? res.json.data : null;
  }

  async v1(path, method = 'GET', body = null) {
    const res = await bridgeRequest({
      host: this.host, pin: this.pin,
      path: `/api/${this.appKey}${path}`, method, body,
    });
    if (Array.isArray(res.json)) {
      const failed = res.json.find((e) => e && e.error);
      if (failed) throw new Error(failed.error.description || 'v1 API error');
    }
    return res.json;
  }
}

/**
 * The bridge reports schema violations as a deeply nested JSON-Schema dump inside a
 * single string. Pull out the parts a human can act on.
 */
function describeV2Error(errors) {
  const raw = errors.map((e) => e.description).join('\n');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const disallowed = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.additionalProperties && node.additionalProperties.disallowed) {
      disallowed.add(node.additionalProperties.disallowed);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(parsed);

  if (disallowed.size) {
    const list = [...disallowed].join(', ');
    let hint = '';
    if (disallowed.has('on_long_press')) {
      hint = '\nHint: on_long_press and on_repeat (hold-to-dim) are mutually exclusive — a button can have one or the other, not both.';
    }
    return `Bridge rejected the configuration. Disallowed field(s): ${list}.${hint}`;
  }
  return `Bridge rejected the configuration (schema validation failed).\n${raw.slice(0, 500)}`;
}

module.exports = { Bridge, bridgeRequest, discoverViaCloud, probeConfig, spkiPin, PIN_ALG, PinMismatchError };
