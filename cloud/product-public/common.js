(function () {
  'use strict';
  if (window.Promise && !window.Promise.prototype.finally) {
    window.Promise.prototype.finally = function (callback) {
      var constructor = this.constructor;
      if (typeof callback !== 'function') return this.then(callback, callback);
      return this.then(function (value) { return constructor.resolve(callback()).then(function () { return value; }); }, function (error) { return constructor.resolve(callback()).then(function () { throw error; }); });
    };
  }
  function node(tag, attributes, children) {
    var element = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) {
      var value = attributes[key];
      if (key === 'text') element.textContent = value;
      else if (key === 'className') element.className = value;
      else if (key === 'onClick') element.addEventListener('click', value);
      else if (key === 'onSubmit') element.addEventListener('submit', value);
      else if (key === 'checked') element.checked = value;
      else if (key === 'disabled') element.disabled = value;
      else element.setAttribute(key, value);
    });
    (children || []).forEach(function (child) { if (child) element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return element;
  }
  function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
  function request(path, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(options.method || 'GET', path, true);
      xhr.timeout = path === '/device/v1/local' || path === '/api/v1/providers/google/weather' || path === '/api/v1/providers/google/nearby' ? 45000 : 12000;
      if (options.body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      if (options.csrf) xhr.setRequestHeader('X-DisplayOS-CSRF', options.csrf);
      if (options.deviceToken) xhr.setRequestHeader('Authorization', 'Bearer ' + options.deviceToken);
      if (options.blob) xhr.responseType = 'blob';
      xhr.onload = function () {
        var data;
        try { data = options.blob ? xhr.response : JSON.parse(xhr.responseText || '{}'); } catch (_) { reject({ status: xhr.status }); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject({ status: xhr.status, data: data });
      };
      xhr.onerror = xhr.ontimeout = function () { reject({ status: 0 }); };
      xhr.send(options.body === undefined ? null : JSON.stringify(options.body));
    });
  }
  function message(error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return 'That was cancelled. You can try again when you are ready.';
    if (!error || error.status === 0) return 'We cannot connect right now. Please try again.';
    if (error.status === 401) return 'Please sign in again to continue.';
    if (error.status === 403) return 'This is not available for your home. Please check and try again.';
    if (error.status === 409) return 'Something changed. Refresh and try again.';
    if (error.status === 429) return 'Let us pause for a moment. Please try again shortly.';
    return 'That did not work. Please check and try again.';
  }
  function dateParts(timezone, date) {
    date = date || new Date();
    try {
      var year = date.toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric' });
      var month = date.toLocaleDateString('en-US', { timeZone: timezone, month: '2-digit' });
      var day = date.toLocaleDateString('en-US', { timeZone: timezone, day: '2-digit' });
      return { clock: date.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }), day: date.toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }), hour: Number(date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false })) % 24, minute: Number(date.toLocaleTimeString('en-GB', { timeZone: timezone, minute: '2-digit' })), date: year + '-' + month + '-' + day };
    } catch (_) { return dateParts('UTC', date); }
  }
  function button(label, action, secondary) { return node('button', { type: 'button', className: 'button' + (secondary ? ' secondary' : ''), text: label, onClick: action }); }
  function field(label, name, type, value, attributes) {
    var input = node('input', Object.assign({ id: name, name: name, type: type || 'text', value: value || '' }, attributes || {}));
    return { input: input, element: node('label', { className: 'field', for: name }, [node('span', { text: label }), input]) };
  }
  function temperature(value, unit) { return Math.round(unit === 'fahrenheit' ? value * 9 / 5 + 32 : value) + (unit === 'fahrenheit' ? '\u00b0F' : '\u00b0C'); }
  function temperatureRange(low, high, unit) { return temperature(low, unit) + ' to ' + temperature(high, unit); }
  window.DisplayOSUI = { node: node, clear: clear, request: request, message: message, dateParts: dateParts, button: button, field: field, temperature: temperature, temperatureRange: temperatureRange };
}());
