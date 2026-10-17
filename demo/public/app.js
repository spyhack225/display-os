(function () {
  'use strict';
  var page = document.body.getAttribute('data-page');
  var csrf = '';
  function element(id) { return document.getElementById(id); }
  function text(id, value) { element(id).textContent = value; }
  function show(id, visible) { element(id).hidden = !visible; }
  function status(value) { text('status', value); }
  function stored(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (error) { return null; }
  }
  function save(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (error) { status('Session storage is unavailable. Keep this tab open.'); }
  }
  function api(method, path, body, token, done, extra) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.timeout = 8000;
    if (method === 'POST') {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Demo-Request', '1');
      if (path === '/api/displays' && element('enrollment-code')) xhr.setRequestHeader('X-Enrollment-Code', element('enrollment-code').value);
      if (csrf && path.indexOf('/api/owner/') === 0) xhr.setRequestHeader('X-CSRF-Token', csrf);
    }
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    if (extra) xhr.setRequestHeader('Idempotency-Key', extra);
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (error) { done('Invalid service response.', null, xhr.status); return; }
      done(xhr.status >= 200 && xhr.status < 300 ? null : result.error || 'Request rejected.', result, xhr.status);
    };
    xhr.onerror = function () { done('Connection failed. Check the display service.'); };
    xhr.ontimeout = function () { done('Service timed out. No success has been assumed.'); };
    xhr.send(method === 'POST' ? JSON.stringify(body) : null);
  }
  function entry(container, title, details) {
    var box = document.createElement('div');
    box.className = 'entry';
    var heading = document.createElement('h3');
    heading.textContent = title;
    var paragraph = document.createElement('p');
    paragraph.textContent = details;
    box.appendChild(heading); box.appendChild(paragraph); container.appendChild(box);
    return box;
  }
  function action(box, label, handler) {
    var button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.onclick = handler; box.appendChild(button);
  }

  if (page === 'display') {
    var display = stored('desk-display');
    var drawnRevision = 0;
    var acknowledgedRevision = 0;
    var delivery = null;
    var expirationTimer;
    var rendering = false;
    function renderCards(cards) {
      var container = element('cards');
      container.textContent = '';
      for (var index = 0; index < cards.length; index++) {
        var card = document.createElement('article');
        card.className = 'card' + (index % 2 ? ' accent' : '');
        var heading = document.createElement('h3'); heading.textContent = cards[index].title;
        var paragraph = document.createElement('p'); paragraph.textContent = cards[index].text;
        card.appendChild(heading); card.appendChild(paragraph); container.appendChild(card);
      }
    }
    function acknowledge() {
      if (!delivery || acknowledgedRevision === delivery.revision || rendering || document.hidden) return;
      if (!window.requestAnimationFrame) { status('Content updated, but this browser cannot confirm a render frame. No ACK sent.'); return; }
      var current = delivery;
      rendering = true;
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          if (document.hidden || !delivery || delivery.revision !== current.revision) { rendering = false; return; }
          api('POST', '/api/devices/' + display.deviceId + '/ack', { revision: current.revision, deliveryNonce: current.deliveryNonce }, display.deviceToken, function (error) {
            rendering = false;
            if (error) { status(error); return; }
            acknowledgedRevision = current.revision;
            text('revision', 'Revision ' + current.revision + ' / client ACK sent');
            status('Rendered text and sent an explicit receipt. This is client-reported evidence, not physical-device proof.');
          });
        });
      });
    }
    function pollDisplay() {
      if (!display) return;
      api('GET', '/api/devices/' + display.deviceId + '/poll', null, display.deviceToken, function (error, result, code) {
        if (error) {
          status(error);
          if (code === 401 || code === 404) {
            display = null; delivery = null; drawnRevision = 0; acknowledgedRevision = 0;
            clearTimeout(expirationTimer); save('desk-display', null);
            renderCards([{ title: 'Display session ended', text: 'Create a fresh display session. Old credentials cannot restore server state after a restart.' }]);
            text('revision', 'No active session'); show('enrollment', true); show('pairing', false); show('device-details', false);
          }
        } else {
          show('enrollment', false); show('device-details', true);
          element('device-id').value = display.deviceId;
          show('pairing', !result.claimed);
          if (!result.claimed) {
            element('pair-code').value = result.pairing.code;
            element('pair-session').value = result.pairing.sessionId;
            text('pair-expiry', result.pairing.expiresAt > result.serverTime ? 'Expires at ' + new Date(result.pairing.expiresAt).toLocaleTimeString() : 'Expired. Generate a new pairing code.');
            status('Unclaimed. Owner login and a deliberate claim are required.');
          } else if (!result.delivery) {
            status('Claimed. No active published content. Owner must separately approve an agent.');
          }
          delivery = result.delivery;
          if (delivery && drawnRevision !== delivery.revision) {
            clearTimeout(expirationTimer);
            renderCards(delivery.cards); drawnRevision = delivery.revision;
            text('content-heading', 'Published text cards'); text('revision', 'Revision ' + delivery.revision + ' / downloaded');
            status('Downloaded a revision. Waiting for a visible render frame before acknowledging.');
            expirationTimer = setTimeout(function () {
              delivery = null;
              renderCards([{ title: 'Content expired', text: 'Waiting for a new synthetic revision.' }]);
              status('Published content expired. The client removed it.');
              text('revision', 'Expired');
            }, Math.max(0, delivery.expiresAt - result.serverTime));
          }
          acknowledge();
        }
        setTimeout(pollDisplay, 1500);
      });
    }
    element('enroll-form').onsubmit = function (event) {
      event.preventDefault();
      api('POST', '/api/displays', { name: element('display-name').value }, null, function (error, result) {
        if (error) { status(error); return; }
        display = result;
        if (element('enrollment-code')) element('enrollment-code').value = '';
        save('desk-display', display); pollDisplay();
      });
    };
    element('renew-pair').onclick = function () {
      api('POST', '/api/devices/' + display.deviceId + '/pairing', {}, display.deviceToken, function (error) { if (error) status(error); else status('New code generated. The old code no longer works.'); });
    };
    document.addEventListener('visibilitychange', acknowledge);
    if (display) pollDisplay();
  }

  if (page === 'setup') {
    var ownerActive = false;
    var ownerBusy = false;
    function ownerState() {
      if (ownerBusy) return;
      ownerBusy = true;
      api('GET', '/api/owner/state', null, null, function (error, result, code) {
        ownerBusy = false;
        if (error) {
          if (ownerActive || code !== 401) status(error);
          if (code === 401) { ownerActive = false; csrf = ''; show('owner-controls', false); show('login-panel', true); }
          return;
        }
        ownerActive = true; csrf = result.csrfToken; show('login-panel', false); show('owner-controls', true);
        var requests = element('requests'); requests.textContent = '';
        if (!result.requests.length) requests.textContent = 'No pending requests. Claiming alone authorizes no agent.';
        for (var index = 0; index < result.requests.length; index++) {
          (function (request) {
            var box = entry(requests, request.label, 'Display ' + request.deviceId + '. Scopes: ' + request.scopes.join(', ') + '. Grant lasts ' + request.ttlSeconds + ' seconds. Request expires ' + new Date(request.expiresAt).toLocaleTimeString() + '.');
            action(box, 'Approve these scopes for this display', function () {
              api('POST', '/api/owner/requests/' + request.requestId + '/approve', { approved: true }, null, function (error) { status(error || 'Agent grant approved separately from ownership.'); ownerState(); });
            });
          }(result.requests[index]));
        }
        var devices = element('devices'); devices.textContent = '';
        if (!result.devices.length) devices.textContent = 'No claimed displays.';
        for (var deviceIndex = 0; deviceIndex < result.devices.length; deviceIndex++) {
          var device = result.devices[deviceIndex];
          entry(devices, device.name, 'Display ' + device.deviceId + '. ' + (device.latest ? 'Revision ' + device.revision + ': ' + device.latest.status + '. Render receipt: ' + (device.latest.renderedAt !== null ? new Date(device.latest.renderedAt).toLocaleTimeString() : 'not received') : 'No published revision.'));
        }
        var grants = element('grants'); grants.textContent = '';
        if (!result.grants.length) grants.textContent = 'No approved grants.';
        for (var grantIndex = 0; grantIndex < result.grants.length; grantIndex++) {
          (function (grant) {
            var box = entry(grants, grant.label, 'Display ' + grant.deviceId + '. ' + grant.scopes.join(', ') + '. Status: ' + grant.status + '. Expires ' + new Date(grant.expiresAt).toLocaleTimeString() + '.');
            if (grant.status === 'active') action(box, 'Revoke agent grant', function () {
              api('POST', '/api/owner/grants/' + grant.grantId + '/revoke', {}, null, function (error) { status(error || 'Grant revoked. Existing accepted content is not erased.'); ownerState(); });
            });
          }(result.grants[grantIndex]));
        }
      });
    }
    element('login-form').onsubmit = function (event) {
      event.preventDefault();
      var credential = element('owner-credential').value; element('owner-credential').value = '';
      api('POST', '/api/owner/login', { credential: credential }, null, function (error, result) {
        if (error) { status(error); return; }
        csrf = result.csrfToken; status('Owner login complete. No display has been claimed automatically.'); ownerState();
      });
    };
    element('claim-form').onsubmit = function (event) {
      event.preventDefault();
      api('POST', '/api/owner/claim', { code: element('claim-code').value, sessionId: element('claim-session').value }, null, function (error) {
        status(error || 'Display claimed. No agent permissions were granted.');
        if (!error) { element('claim-code').value = ''; element('claim-session').value = ''; ownerState(); }
      });
    };
    element('logout').onclick = function () {
      api('POST', '/api/owner/logout', {}, null, function (error) { status(error || 'Logged out.'); ownerState(); });
    };
    ownerState(); setInterval(function () { if (ownerActive) ownerState(); }, 2000);
  }

  if (page === 'agent') {
    var agent = stored('desk-agent');
    var requestPolling = false;
    var statusPolling = false;
    var pendingPublish = null;
    function requestStatus() {
      if (!agent || requestPolling) return;
      requestPolling = true;
      api('GET', '/api/agent/requests/' + agent.requestId, null, agent.requestToken, function (error, result) {
        requestPolling = false;
        if (error) { status(error); show('publish-panel', false); return; }
        if (result.status === 'pending') { status('Waiting for a deliberate owner approval. This request has no display access.'); setTimeout(requestStatus, 1500); return; }
        if (result.status === 'approved') {
          agent.grantToken = result.grantToken; agent.expiresAt = result.expiresAt; save('desk-agent', agent); show('publish-panel', true);
          status('Owner approved read and publish for display ' + agent.deviceId + '. Grant expires ' + new Date(result.expiresAt).toLocaleTimeString() + '.');
        } else { status('Agent request is ' + result.status + '.'); show('publish-panel', false); }
      });
    }
    function revisionStatus() {
      if (!agent || !agent.revision || !agent.grantToken || statusPolling) return;
      statusPolling = true;
      api('GET', '/api/agent/devices/' + agent.deviceId + '/revisions/' + agent.revision, null, agent.grantToken, function (error, result) {
        statusPolling = false;
        if (error) { text('publish-status', error); show('publish-panel', false); return; }
        text('publish-status', 'Revision ' + result.revision + ': ' + result.status + '. Accepted is not rendered. A rendered result means a client receipt reached the server.');
      });
    }
    element('request-form').onsubmit = function (event) {
      event.preventDefault();
      var deviceId = element('agent-device').value;
      api('POST', '/api/agent/requests', { deviceId: deviceId, label: element('agent-label').value, scopes: ['display:read', 'content:write'], ttlSeconds: 900 }, null, function (error, result) {
        if (error) { status(error); return; }
        agent = result; agent.deviceId = deviceId; pendingPublish = null; save('desk-agent', agent); show('publish-panel', false); requestStatus();
      });
    };
    element('publish-form').onsubmit = function (event) {
      event.preventDefault();
      if (!agent || !agent.grantToken) return;
      var button = element('publish-form').querySelector('button'); button.disabled = true;
      function publish() {
        api('POST', '/api/agent/devices/' + agent.deviceId + '/content', pendingPublish.body, agent.grantToken, function (error, result, code) {
          button.disabled = false;
          if (error) { text('publish-status', error + (code ? '' : ' Click Publish again to retry the same request.')); if (code) pendingPublish = null; return; }
          agent.revision = result.revision; pendingPublish = null; save('desk-agent', agent); revisionStatus();
        }, pendingPublish.key);
      }
      if (pendingPublish) { publish(); return; }
      api('GET', '/api/agent/devices/' + agent.deviceId + '/capabilities', null, agent.grantToken, function (error, result) {
        if (error) { button.disabled = false; text('publish-status', error); return; }
        pendingPublish = { key: 'ui_' + new Date().getTime() + '_' + Math.random().toString(36).slice(2), body: { expectedRevision: result.revision, ttlSeconds: 600, cards: [{ title: element('card-title').value, text: element('card-text').value }] } };
        publish();
      });
    };
    if (agent) {
      element('agent-device').value = agent.deviceId;
      if (agent.grantToken && agent.expiresAt > new Date().getTime()) { show('publish-panel', true); status('Restored a tab-local grant. The server still checks expiration and revocation.'); }
      else requestStatus();
    }
    setInterval(revisionStatus, 1500);
  }
}());
