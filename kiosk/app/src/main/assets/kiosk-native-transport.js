(function () {
  'use strict';
  var port = null;
  var sequence = 0;
  var pending = {};
  var queue = [];
  var paths = ['/device/v1/pairing', '/device/v1/confirm', '/device/v1/ack', '/device/v1/erase', '/device/v1/lists', '/device/v1/voice'];
  var nativeUi;
  function send(path, body) {
    return new Promise(function (resolve, reject) {
      if (Object.keys(pending).length >= 8) { reject({ status: 429 }); return; }
      var id = String(++sequence);
      var packet = JSON.stringify({ id: id, path: path, body: body });
      if (packet.length > 8192) { reject({ status: 413 }); return; }
      var timeout = path === '/device/v1/confirm' ? 115000 : 30000;
      pending[id] = { resolve: resolve, reject: reject, timer: setTimeout(function () {
        delete pending[id];
        queue = queue.filter(function (queued) { return JSON.parse(queued).id !== id; });
        reject({ status: 0 });
      }, timeout) };
      if (port) port.postMessage(packet); else queue.push(packet);
    });
  }
  Object.defineProperty(window, 'DisplayOSUI', {
    configurable: false,
    get: function () { return nativeUi; },
    set: function (value) {
      if (nativeUi) throw new Error('Native adapter already installed');
      var original = value.request;
      value.request = function (path, options) {
        options = options || {};
        if (typeof path !== 'string') return Promise.reject({ status: 403 });
        if (path === '/device/v1/local' && options.method && options.method !== 'GET') return Promise.reject({ status: 403 });
        if (path.indexOf('/device/') === 0 && options.method === 'POST') {
          if (paths.indexOf(path) < 0) return Promise.reject({ status: 403 });
          return send(path, options.body || {});
        }
        if (path.indexOf('/device/') === 0 && path !== '/device/v1/poll' && path !== '/device/v1/local' && !/^\/device\/v1\/media\/[A-Za-z0-9_-]{8,128}$/.test(path)) return Promise.reject({ status: 403 });
        var safe = {};
        Object.keys(options).forEach(function (key) { if (key !== 'deviceToken') safe[key] = options[key]; });
        return original(path, safe);
      };
      nativeUi = value;
    }
  });
  window.addEventListener('message', function (event) {
    var nativeOrigin = event.origin === '' || event.origin === 'null';
    if (!event.isTrusted || event.source !== null || !nativeOrigin || event.data !== 'displayos-native-port-v1' || !event.ports || event.ports.length !== 1 || port) return;
    port = event.ports[0];
    port.onmessage = function (message) {
      var answer;
      try { answer = JSON.parse(message.data); } catch (_) { return; }
      var entry = pending[answer.id]; if (!entry) return;
      delete pending[answer.id]; clearTimeout(entry.timer);
      if (answer.status >= 200 && answer.status < 300) entry.resolve(answer.body);
      else entry.reject({ status: answer.status });
    };
    queue.forEach(function (packet) { port.postMessage(packet); }); queue = [];
  });
}());
