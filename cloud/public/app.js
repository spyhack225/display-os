(function () {
  'use strict';
  function element(id) { return document.getElementById(id); }
  function text(id, value) { element(id).textContent = value; }
  function show(id, visible) { element(id).hidden = !visible; }
  function status(value) { text('status', value); }
  function stored(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (error) { return null; } }
  function save(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch (error) { status('Please keep this page open. Your browser could not save this connection.'); return false; } }
  function api(method, route, value, token, done, headers) {
    var xhr = new XMLHttpRequest(); xhr.open(method, route, true); xhr.timeout = 8000;
    if (method === 'POST') {
      xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Demo-Request', '1');
      if (window.DeskUI.csrf && route.indexOf('/api/owner/') === 0) xhr.setRequestHeader('X-CSRF-Token', window.DeskUI.csrf);
    }
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (headers) Object.keys(headers).forEach(function (key) { xhr.setRequestHeader(key, headers[key]); });
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (error) { done('Something went wrong. Please try again.', null, xhr.status); return; }
      var message = result.error || 'Something went wrong. Please try again.';
      if (document.body.getAttribute('data-page') !== 'operator') {
        var messages = { 400: 'That did not look right. Please check and try again.', 401: 'This connection has ended. Please reconnect.', 403: 'This action is not allowed. Go back to My screens.', 404: 'We could not find that screen. Please reconnect.', 409: 'Something changed. Please try again.', 410: 'This code has expired. Get a new one on your screen.', 429: 'Please wait a moment before trying again.', 503: 'DisplayOS is unavailable right now. Please try again shortly.' };
        message = messages[xhr.status] || 'Something went wrong. Please try again.';
        if (route === '/api/owner/claim' && xhr.status === 400) message = 'That code does not match. Check the code on your screen.';
      }
      done(xhr.status >= 200 && xhr.status < 300 ? null : message, result, xhr.status);
    };
    xhr.onerror = function () { done('We could not connect. Check your internet and try again.'); };
    xhr.ontimeout = function () { done('That took too long. Please try again.'); };
    xhr.send(method === 'POST' ? JSON.stringify(value) : null);
  }
  function submit(id, handler) {
    var form = element(id); var busy = false;
    form.onsubmit = function (event) {
      event.preventDefault(); if (busy) return;
      busy = true; var button = form.querySelector('button'); button.disabled = true;
      handler(function () { busy = false; button.disabled = false; });
    };
  }
  function copy(id, message) {
    var input = element(id);
    function fallback() { if (input.hidden) { status('We could not copy the invitation. Please try another browser.'); return; } input.focus(); input.select(); status('The code is selected. Choose Copy in your browser.'); }
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
    navigator.clipboard.writeText(input.value).then(function () { status(message); }, fallback);
  }
  function ticket(value) {
    var match = /^[a-f0-9]{12}$/i.exec(value.trim());
    return match ? { code: value.trim().toUpperCase() } : null;
  }
  window.DeskUI = { element: element, text: text, show: show, status: status, api: api, submit: submit, copy: copy, ticket: ticket, csrf: '' };
  var page = document.body.getAttribute('data-page');
  if (page === 'display') {
    var display = stored('desk-display');
    if (display && (!/^[a-f0-9]{24}$/.test(display.deviceId) || !/^[a-f0-9]{64}$/.test(display.deviceToken))) display = null;
    var delivery = null; var drawn = 0; var acknowledged = 0; var rendering = false; var expiryTimer; var deadline = 0; var polling = false; var pollTimer;
    var sample = [{ title: 'School pickup · 3:15 PM', text: 'Sam finishes at the usual gate. Remember the swimming bag.' }, { title: 'Dinner · 6:30 PM', text: 'Everyone is home tonight. A good moment to catch up.' }, { title: 'A few things to pick up', text: 'Milk, bread and apples. The shopping list can wait until you are out.' }, { title: 'Around the table', text: 'Ask everyone: what was the best part of your day?' }];
    function draw(cards, label) {
      var container = element('cards'); container.textContent = '';
      cards.forEach(function (value) {
        var card = document.createElement('article'); card.className = 'card';
        var heading = document.createElement('h3'); heading.textContent = value.title;
        var paragraph = document.createElement('p'); paragraph.textContent = value.text;
        card.appendChild(heading); card.appendChild(paragraph); container.appendChild(card);
      });
      var reminder = cards[label === 'A sample reminder' ? 1 : 0] || { title: 'Nothing new just yet.', text: 'Your next note will appear here.' };
      text('standby-label', label); text('standby-title', reminder.title); text('standby-text', reminder.text.slice(0, 220));
    }
    function empty(message) { delivery = null; clearTimeout(expiryTimer); draw([], 'Your home'); text('revision', message); }
    function clock() {
      var now = new Date(); var time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      text('dashboard-clock', time); text('standby-clock', time);
      text('greeting', now.getHours() < 12 ? 'Good morning.' : now.getHours() < 18 ? 'Good afternoon.' : 'Good evening.');
      var date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      text('today-date', date); text('standby-date', date); text('month-heading', now.toLocaleDateString([], { month: 'long', year: 'numeric' }));
      var calendar = element('month-calendar'); calendar.textContent = '';
      var entries = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      var start = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
      for (var offset = 0; offset < start; offset++) entries.push('');
      var length = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      for (var day = 1; day <= length; day++) entries.push(day);
      entries.forEach(function (value) { var cell = document.createElement('span'); cell.textContent = value; if (value === now.getDate()) { cell.className = 'today'; cell.setAttribute('aria-current', 'date'); } calendar.appendChild(cell); });
    }
    function mode(standby) {
      show('dashboard-view', !standby); show('standby-view', standby); document.body.setAttribute('data-mode', standby ? 'standby' : 'dashboard');
      ['dashboard-mode', 'standby-mode'].forEach(function (id, index) { element(id).className = (index === 1) === standby ? 'selected' : ''; element(id).setAttribute('aria-pressed', String((index === 1) === standby)); });
    }
    function connecting(value) { document.body.setAttribute('data-connecting', String(value)); }
    function acknowledge() {
      if (!delivery || rendering || acknowledged === delivery.revision || document.hidden || Date.now() >= deadline || !window.requestAnimationFrame) return;
      var current = delivery; rendering = true;
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        if (document.hidden || !delivery || delivery.deliveryNonce !== current.deliveryNonce || Date.now() >= deadline) { rendering = false; return; }
        api('POST', '/api/devices/' + display.deviceId + '/ack', { revision: current.revision, deliveryNonce: current.deliveryNonce }, display.deviceToken, function (error) {
          rendering = false;
          if (error) { status(error); return; }
          if (delivery && delivery.deliveryNonce === current.deliveryNonce) { acknowledged = current.revision; text('revision', 'Your note is here'); status('Your screen has sent confirmation.'); }
        });
      }); });
    }
    function poll() {
      if (!display || polling) return;
      clearTimeout(pollTimer); polling = true;
      api('GET', '/api/devices/' + display.deviceId + '/poll', null, display.deviceToken, function (error, result, code) {
        polling = false;
        if (error) {
          status(error);
          if (code === 401 || code === 404) { display = null; save('desk-display', null); empty('Let\'s reconnect'); show('pairing', false); show('enrollment', true); show('connect-display', true); connecting(true); }
        } else {
          show('enrollment', false); show('pairing', !result.claimed); show('connect-display', false); connecting(!result.claimed); show('preview-label', false);
          if (!result.claimed) {
            element('pair-ticket').value = result.pairing.code;
            text('pair-expiry', result.pairing.expiresAt > result.serverTime ? 'Use this code before ' + new Date(result.pairing.expiresAt).toLocaleTimeString() : 'This code has expired. Get a new one below.');
            status('Finish making this screen yours on your phone or laptop.');
          } else if (!result.delivery) { empty('Ready for your assistant'); status('Your screen is connected. Invite your assistant to send a note.'); }
          if (result.delivery && result.delivery.expiresAt > result.serverTime) {
            delivery = result.delivery;
            if (drawn !== delivery.revision) {
              drawn = delivery.revision; draw(delivery.cards, 'From your assistant'); text('content-heading', 'From your assistant'); text('revision', 'A new note');
              deadline = Date.now() + delivery.expiresAt - result.serverTime;
              clearTimeout(expiryTimer); expiryTimer = setTimeout(function () { empty('Ready for a fresh note'); status('That note has finished. Waiting for something new.'); }, deadline - Date.now());
            }
            acknowledge();
          }
        }
        if (display) pollTimer = setTimeout(poll, 2000);
      });
    }
    element('dashboard-mode').onclick = function () { mode(false); };
    element('standby-mode').onclick = function () { mode(true); };
    element('connect-display').onclick = function () { connecting(true); show('enrollment', true); element('close-connect').focus(); };
    element('close-connect').onclick = function () { show('enrollment', false); connecting(false); };
    element('copy-ticket').onclick = function () { copy('pair-ticket', 'Code copied. Paste it in DisplayOS setup on your phone or laptop.'); };
    element('renew-pair').onclick = function () {
      if (!display) return;
      element('renew-pair').disabled = true;
      api('POST', '/api/devices/' + display.deviceId + '/pairing', {}, display.deviceToken, function (error) { element('renew-pair').disabled = false; if (error) status(error); else poll(); });
    };
    document.addEventListener('visibilitychange', acknowledge);
    draw(sample, 'A sample reminder'); clock(); setInterval(clock, 30000);
    if (display) { empty('Reconnecting'); poll(); }
  }
  if (page === 'agent') {
    var agent = stored('desk-agent'); var pendingPublish = null; var requestBusy = false; var receiptBusy = false;
    var selected = location.hash.slice(1);
    if (/^[a-f0-9]{24}$/.test(selected)) element('agent-device').value = selected;
    function requestStatus() {
      if (!agent || requestBusy) return; requestBusy = true;
      api('GET', '/api/agent/requests/' + agent.requestId, null, agent.requestToken, function (error, result) {
        requestBusy = false;
        if (error) { status(error); show('publish-panel', false); show('request-panel', true); return; }
        if (result.status === 'pending') { status('Waiting for your okay. Go to My screens to allow your sample assistant.'); show('request-panel', false); setTimeout(requestStatus, 2000); return; }
        if (result.status === 'approved') { agent.grantToken = result.grantToken; agent.expiresAt = result.expiresAt; save('desk-agent', agent); show('publish-panel', true); show('request-panel', false); status('You said yes. Send your first note. I can help until ' + new Date(result.expiresAt).toLocaleTimeString() + '.'); }
        else { status('Your assistant is no longer connected. You can ask to connect again.'); show('publish-panel', false); show('request-panel', true); }
      });
    }
    function receipt() {
      if (!agent || !agent.revision || !agent.grantToken || receiptBusy) return; receiptBusy = true;
      api('GET', '/api/agent/devices/' + agent.deviceId + '/revisions/' + agent.revision, null, agent.grantToken, function (error, result) {
        receiptBusy = false;
        if (error) { text('publish-status', error); show('publish-panel', false); show('request-panel', true); return; }
        var states = { accepted: 'Your note is on its way.', downloaded: 'Your screen has received the note. Waiting for confirmation.', rendered: 'Your screen sent confirmation.', expired: 'This note has finished.' };
        text('publish-status', states[result.status] || 'Waiting for your screen.');
      });
    }
    submit('request-form', function (finish) {
      var deviceId = element('agent-device').value.trim();
      if (!/^[a-f0-9]{24}$/.test(deviceId)) { finish(); status('Go to My screens and choose Try a sample assistant for your screen.'); return; }
      api('POST', '/api/agent/requests', { deviceId: deviceId, label: element('agent-label').value, scopes: ['display:read', 'content:write'], ttlSeconds: 900 }, null, function (error, result) {
        finish(); if (error) { status(error); return; }
        agent = result; agent.deviceId = deviceId; pendingPublish = null; save('desk-agent', agent); show('publish-panel', false); requestStatus();
      });
    });
    submit('publish-form', function (finish) {
      if (!agent || !agent.grantToken) { finish(); return; }
      function publish() {
        api('POST', '/api/agent/devices/' + agent.deviceId + '/content', pendingPublish.body, agent.grantToken, function (error, result, code) {
          finish(); if (error) { text('publish-status', error + (code ? '' : ' Choose Send my note again to retry.')); if (code) pendingPublish = null; return; }
          agent.revision = result.revision; pendingPublish = null; save('desk-agent', agent); receipt();
        }, { 'Idempotency-Key': pendingPublish.key });
      }
      if (pendingPublish) { publish(); return; }
      api('GET', '/api/agent/devices/' + agent.deviceId + '/capabilities', null, agent.grantToken, function (error, result) {
        if (error) { finish(); text('publish-status', error); return; }
        pendingPublish = { key: 'ui_' + Date.now() + '_' + Math.random().toString(36).slice(2), body: { expectedRevision: result.revision, ttlSeconds: 600, cards: [{ title: element('card-title').value, text: element('card-text').value }] } }; publish();
      });
    });
    if (agent && (!selected || selected === agent.deviceId)) { element('agent-device').value = agent.deviceId; requestStatus(); }
    else agent = null;
    setInterval(receipt, 2000);
  }
  if (page === 'operator') {
    submit('operator-login', function (finish) {
      var credential = element('owner-credential').value; element('owner-credential').value = '';
      api('POST', '/api/owner/login', { credential: credential }, null, function (error) { finish(); if (error) status(error); else location.assign('/pilot/setup'); });
    });
    submit('enroll-form', function (finish) {
      api('POST', '/api/displays', { name: element('display-name').value }, null, function (error, result) {
        finish(); element('enrollment-code').value = '';
        if (error) { status(error); return; }
        if (save('desk-display', result)) location.assign('/pilot/display');
      }, { 'X-Enrollment-Code': element('enrollment-code').value });
    });
  }
}());
