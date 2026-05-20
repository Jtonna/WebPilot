// Minimal WebSocket client for live UI events.
//
// Connects to `/api/ui/events` on the WebPilot server. The endpoint does
// not exist yet — this client handles connection failure gracefully so
// the UI is still usable while Wave 2 wires the server side.

const DEFAULT_PATH = '/api/ui/events';

export class UiEventsClient {
  constructor({ url, path = DEFAULT_PATH, autoReconnect = true } = {}) {
    this._url = url || this._defaultUrl(path);
    this._listeners = new Map(); // eventType -> Set<callback>
    this._ws = null;
    this._closed = false;
    this._autoReconnect = autoReconnect;
    this._reconnectDelayMs = 2000;
    this._reconnectTimer = null;
  }

  _defaultUrl(path) {
    if (typeof window === 'undefined') return null;
    const { protocol, host } = window.location;
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${host}${path}`;
  }

  connect() {
    if (this._closed) return;
    if (!this._url) return;

    try {
      this._ws = new WebSocket(this._url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ui-ws] failed to construct WebSocket', err);
      this._scheduleReconnect();
      return;
    }

    this._ws.addEventListener('open', () => {
      // eslint-disable-next-line no-console
      console.log('[ui-ws] connected', this._url);
    });

    this._ws.addEventListener('message', (event) => {
      let parsed = null;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = { type: 'raw', data: event.data };
      }
      this._emit(parsed && parsed.type, parsed);
      this._emit('*', parsed);
    });

    this._ws.addEventListener('close', () => {
      // eslint-disable-next-line no-console
      console.log('[ui-ws] disconnected');
      this._ws = null;
      this._scheduleReconnect();
    });

    this._ws.addEventListener('error', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[ui-ws] error', err && err.message ? err.message : err);
      // 'close' will fire after 'error' and handles reconnect.
    });
  }

  _scheduleReconnect() {
    if (!this._autoReconnect || this._closed) return;
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelayMs);
  }

  subscribe(eventType, callback) {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    this._listeners.get(eventType).add(callback);
    return () => this.unsubscribe(eventType, callback);
  }

  unsubscribe(eventType, callback) {
    const set = this._listeners.get(eventType);
    if (set) set.delete(callback);
  }

  _emit(eventType, payload) {
    if (!eventType) return;
    const set = this._listeners.get(eventType);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ui-ws] listener threw', err);
      }
    }
  }

  disconnect() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
      this._ws = null;
    }
    this._listeners.clear();
  }
}

export function createUiEventsClient(options) {
  return new UiEventsClient(options);
}
